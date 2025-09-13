// Deck.gl engine mounted into the center panel while keeping left/right UI
// Load with ?engine=deck or localStorage.engine='deck'
(function(){
  const center = document.querySelector('.center-panel');
  const stage = document.getElementById('stage');
  if (stage) stage.style.display = 'none';
  if (!center) return;

  const {Deck, ScatterplotLayer, LineLayer, TextLayer, PolygonLayer, ArcLayer, ScreenGridLayer, HexagonLayer, HeatmapLayer, PathLayer, OrthographicView, COORDINATE_SYSTEM} = window.deck || {};
  if (!Deck) { console.error('Deck.gl UMD not found'); return; }

  const API = {
    graph: '/api/graph',
    preset: '/api/preset-data',
    token: id => `/api/token/${id}`,
    story: id => `/api/token/${id}/story`
  };

  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  // Canvas for deck
  const canvas = document.createElement('canvas');
  canvas.id = 'deck-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  center.appendChild(canvas);

  let deckInst = null;
  let presetData = null;
  let nodes = [];
  let edges = [];
  let basePositions = null; // for subtle animations
  let currentMode = 'holders';
  let animReq = null;
  let flowEdges = null; // transfer flows for TRADING rivers
  let activityBuckets = null; // activity for HEALTH
  let selectedId = -1; // persistent selection ring
  let highlightSet = null; // wallet highlight filter
  let washSet = null; // wash watch overlay
  let desireSet = null; // desire paths overlay
  let edgeCount = 200; // default UI slider value
  let ownerCenters = null; // computed per owner
  let ownerHoldings = null;

  // UI toggles reflect left panel checkboxes
  const ui = {
    get ambient(){ return getChecked('ambient-edges', true); },
    get ownership(){ return getChecked('layer-ownership', true); },
    get traits(){ return getChecked('layer-traits', false); },
    get trades(){ return getChecked('layer-trades', true); },
    get sales(){ return getChecked('layer-sales', true); },
    get transfers(){ return getChecked('layer-transfers', true); },
    get mints(){ return getChecked('layer-mints', true); },
    get bubbles(){ return getChecked('layer-bubbles', true); },
    get wash(){ return getChecked('layer-wash', false); },
    get desire(){ return getChecked('layer-desire', false); },
  };

  // Resize
  try { new ResizeObserver(()=>{ const w=center.clientWidth||800, h=center.clientHeight||600; deckInst?.setProps?.({width:w, height:h}); }).observe(center); } catch {}

  init().catch(console.error);

  async function init(){
    presetData = await fetch(API.preset).then(r=>r.json()).catch(()=>null);
    const w = center.clientWidth||800, h = center.clientHeight||600;
    deckInst = new Deck({ canvas: 'deck-canvas', width:w, height:h, controller:true, views:[ new (OrthographicView||window.deck.OrthographicView)({ id:'ortho' }) ], initialViewState:{ target:[0,0,0], zoom:0 } });
    // Wire tabs/select and inputs
    bindViewControls();
    bindInputs();
    bindShortcuts();
    // Initialize edge slider value
    const edgesEl = document.getElementById('edges-slider');
    if (edgesEl) edgeCount = parseInt(edgesEl.value||'200',10);
    // Optional preselect via ?token=
    try { const usp = new URLSearchParams(location.search); const t = parseInt(usp.get('token')||'',10); if (t>0) selectedId = t; } catch {}
    await loadMode('holders', edgeCount);
    if (selectedId>0) focusSelect(selectedId);
  }

  function bindViewControls(){
    const viewEl = document.getElementById('view');
    if (viewEl && !viewEl.dataset.deckBound){
      viewEl.dataset.deckBound='1';
      viewEl.addEventListener('change', async ()=>{
        const v = viewEl.value;
        if (v==='ownership') await loadMode('holders', edgeCount);
        else if (v==='trading') await loadMode('transfers', edgeCount);
        else if (v==='traits') await loadMode('traits', edgeCount);
        else if (v==='whales') await loadMode('wallets', edgeCount);
        else if (v==='health') await loadMode('holders', edgeCount);
      });
    }
    document.querySelectorAll('.tab-btn[data-view]')?.forEach(btn=>{
      if (!btn.dataset.deckBound){ btn.dataset.deckBound='1'; btn.addEventListener('click', ()=>{ const m=btn.dataset.view; if (m==='ownership') viewEl.value='ownership'; if (m==='trading') viewEl.value='trading'; if (m==='traits') viewEl.value='traits'; if (m==='whales') viewEl.value='whales'; if (m==='health') viewEl.value='health'; viewEl.dispatchEvent(new Event('change')); }); }
    });
    // Mode select (fallback)
    const modeEl = document.getElementById('mode');
    if (modeEl && !modeEl.dataset.deckBound){
      modeEl.dataset.deckBound='1';
      modeEl.addEventListener('change', ()=>{ loadMode(modeEl.value||'holders', edgeCount); });
    }
  }

  function bindInputs(){
    // Edge slider
    const edgesEl = document.getElementById('edges-slider');
    const edgeCountEl = document.getElementById('edge-count');
    if (edgesEl && !edgesEl.dataset.deckBound){
      edgesEl.dataset.deckBound = '1';
      edgesEl.addEventListener('input', ()=>{ edgeCount = parseInt(edgesEl.value||'200',10); if (edgeCountEl) edgeCountEl.textContent = String(edgeCount); loadMode(currentMode, edgeCount); });
    }
    // Layer toggles -> re-render
    const ids = ['ambient-edges','layer-ownership','layer-traits','layer-trades','layer-sales','layer-transfers','layer-mints','layer-bubbles','layer-wash','layer-desire'];
    ids.forEach(id=>{ const el=document.getElementById(id); if (el && !el.dataset.deckBound){ el.dataset.deckBound='1'; el.addEventListener('change', async ()=>{
      if (id==='layer-wash' && el.checked && !washSet) washSet = await fetchWash().catch(()=>null);
      if (id==='layer-desire' && el.checked && !desireSet) desireSet = await fetchDesire().catch(()=>null);
      render(nodes, edges, currentMode);
    }); }});
    // Search behavior
    const searchEl = document.getElementById('search');
    const clearBtn = document.getElementById('clear-search');
    if (clearBtn && !clearBtn.dataset.deckBound){
      clearBtn.dataset.deckBound='1';
      clearBtn.addEventListener('click', ()=>{ highlightSet=null; selectedId=-1; try { searchEl.value=''; } catch {}; render(nodes,edges,currentMode); searchEl?.focus(); });
    }
    if (searchEl && !searchEl.dataset.deckBound){
      searchEl.dataset.deckBound='1';
      searchEl.addEventListener('keydown', async (e)=>{
        if (e.key!=='Enter') return;
        const raw = (searchEl.value||'').trim();
        searchEl.value='';
        if (!raw) return;
        // ENS -> resolve
        if (/\.eth$/i.test(raw)){
          try { const r = await fetch(`/api/resolve?q=${encodeURIComponent(raw)}`).then(x=>x.json()); if (r?.address) { await highlightWallet(r.address); return; } } catch {}
        }
        // 0x wallet
        if (/^0x[a-fA-F0-9]{40}$/.test(raw)) { await highlightWallet(raw); return; }
        // token id
        const id = parseInt(raw, 10);
        if (id>0) focusSelect(id);
      });
    }
  }

  async function loadMode(mode, edgesWanted){
    currentMode = mode;
    const params = new URLSearchParams({ mode, nodes:'10000', edges:String(edgesWanted ?? edgeCount) });
    const graph = await fetch(`${API.graph}?${params}`, { cache:'default' }).then(r=>r.json()).catch(()=>({nodes:[],edges:[]}));
    const pdata = presetData || {};
    nodes = buildNodes(graph.nodes||[], pdata);
    edges = buildEdges(graph.edges||[], nodes);
    computeOwnerMetrics(pdata, nodes);
    applyLayout(nodes, mode, pdata);
    // lazy fetch flow/activity data
    if (mode==='transfers' && !flowEdges) flowEdges = await fetchFlowEdges(nodes).catch(()=>null);
    if (mode==='holders' || mode==='frozen'){ if (!activityBuckets) activityBuckets = await fetch('/api/activity').then(r=>r.json()).catch(()=>null); }
    render(nodes, edges, mode);
    // (re)start tiny animation for holders and traits if applicable
    if (animReq) cancelAnimationFrame(animReq);
    const start = performance.now? performance.now(): Date.now();
    const tick = ()=>{
      const t = ((performance.now? performance.now(): Date.now()) - start)/1000;
      if (currentMode==='holders') animateHolders(t);
      else if (currentMode==='traits') animateTraits(t);
      animReq = requestAnimationFrame(tick);
    };
    animReq = requestAnimationFrame(tick);
  }

  function buildNodes(apiNodes, pdata){
    const ownerIndex = pdata.ownerIndex||[]; const ownerEthos = pdata.ownerEthos||[];
    const tokenLastActivity = pdata.tokenLastActivity||[]; const tokenPrice=pdata.tokenPrice||[]; const rarity=pdata.rarity||[];
    return apiNodes.map((n,i)=>{
      const idx = (n.id-1>=0)?(n.id-1):i; const oi=ownerIndex[idx]??-1; const ethos=oi>=0?(ownerEthos[oi]||0):0;
      return {
        id: n.id, tokenId: idx,
        position: [0,0,0],
        color: colorFor(n, ethos, tokenLastActivity[idx]),
        baseColor: colorFor(n, ethos, tokenLastActivity[idx]),
        radius: 4,
        ownerIndex: oi,
        lastActivity: tokenLastActivity[idx]||0,
        price: tokenPrice[idx]||0,
        rarity: rarity[idx]||0.5,
        frozen: !!n.frozen,
        dormant: !!n.dormant
      };
    });
  }

  function buildEdges(apiEdges, nodes){
    return (apiEdges||[]).slice(0,5000).map(e=>{
      const a = Array.isArray(e)?e[0]:e.a; const b = Array.isArray(e)?e[1]:e.b; const ia = (a-1); const ib=(b-1);
      const na = nodes[ia]; const nb = nodes[ib]; if (!na||!nb) return null;
      return { sourceIndex: ia, targetIndex: ib, color:[0,255,102,40], width:1 };
    }).filter(Boolean);
  }

  function applyLayout(nodes, mode, pdata){
    const w = center.clientWidth||1200, h=center.clientHeight||800; const cx=w/2, cy=h/2;
    if (mode==='holders'){
      // Gravitational clusters: owner hubs + token orbits
      const owners = Math.max(1, (pdata.owners?.length||12));
      const hubs = new Map();
      nodes.forEach((d,i)=>{ const oi=d.ownerIndex>=0?d.ownerIndex:(i%owners); if (!hubs.has(oi)){ const ang=(oi/owners)*Math.PI*2; hubs.set(oi, [cx+Math.cos(ang)*240, cy+Math.sin(ang)*220, 0]); } });
      basePositions = nodes.map((d,i)=>{
        const hub = hubs.get(d.ownerIndex) || [cx,cy,0]; const idx=i%50; const level=Math.floor(Math.log2(idx+2)); const r=20 + level*16; const ang=(i*0.618)%1 * Math.PI*2; const pos=[hub[0]+Math.cos(ang)*r, hub[1]+Math.sin(ang)*r, 0]; d.position=pos; return pos.slice();
      });
    } else if (mode==='traits'){
      const tk = pdata.tokenTraitKey||[]; const freq=new Map(); tk.forEach(k=>{ if (k>=0) freq.set(k,(freq.get(k)||0)+1); }); const keys=[...freq.keys()].sort((a,b)=>freq.get(a)-freq.get(b));
      const centers=new Map(); keys.forEach((k,i)=>{ const ang=(i/keys.length)*Math.PI*2; const rad=Math.min(cx,cy)*0.6; centers.set(k,[cx+Math.cos(ang)*rad*0.5, cy+Math.sin(ang)*rad*0.5, 0]); });
      basePositions = nodes.map((d,i)=>{
        const k=tk[d.tokenId]; const c=centers.get(k)||[cx,cy,0]; const spread=(freq.get(k)||50)>50?120:60; const ang=(i*1.77)% (Math.PI*2); const r=(i%spread); const pos=[c[0]+Math.cos(ang)*r, c[1]+Math.sin(ang)*r, 0]; d.position=pos; return pos.slice();
      });
    } else if (mode==='wallets'){
      // Whale trees simplified: radial tiers by holdings
      const counts = new Map(); nodes.forEach(d=>{ const c=counts.get(d.ownerIndex)||0; counts.set(d.ownerIndex,c+1); });
      nodes.forEach((d,i)=>{ const hold = counts.get(d.ownerIndex)||1; const rad = hold>20? 200: hold>10? 400: hold>5? 600: 800; const ang=(i/10000)*Math.PI*2; d.position=[cx+Math.cos(ang)*rad, cy+Math.sin(ang)*rad, 0]; });
      basePositions = nodes.map(d=>d.position.slice());
    } else if (mode==='transfers'){
      // Profit waterfalls (basic) using price vs buy info if present
      const lastSale = pdata.tokenLastSalePrice||[]; const lastBuy=pdata.tokenLastBuyPrice||[]; const lastAct=pdata.tokenLastActivity||[];
      const tiers={bigProfit:[],profit:[],breakeven:[],loss:[],bigLoss:[]};
      nodes.forEach(d=>{ const i=d.tokenId; const lp=Number(lastSale[i]||0); const bp=Number(lastBuy[i]||lp); const p=lp-bp; if (p>5) tiers.bigProfit.push(d); else if (p>0) tiers.profit.push(d); else if (p>-0.5) tiers.breakeven.push(d); else if (p>-5) tiers.loss.push(d); else tiers.bigLoss.push(d); });
      const order=['bigProfit','profit','breakeven','loss','bigLoss']; let curY=70; const tierH=Math.max(100,h/5);
      order.forEach(key=>{ const arr=tiers[key]; const poolW=Math.min(arr.length*3+200, w-160); arr.forEach((d,j)=>{ const col=j%50; const row=Math.floor(j/50); const pos=[cx-poolW/2 + (col+0.5)*(poolW/50), curY + row*18, 0]; d.position=pos; const days=d.lastActivity? (Date.now()/1000-d.lastActivity)/86400:999; d.radius= days<7? 9: days<30? 6: 3; d.color = key==='bigProfit'?[0,255,0,200]: key==='profit'?[0,255,102,200]: key==='breakeven'?[255,255,102,200]: key==='loss'?[255,102,102,200]:[255,0,0,220]; }); curY+=tierH; });
      basePositions = nodes.map(d=>d.position.slice());
    } else {
      // Default grid
      const grid=100; nodes.forEach((d,i)=>{ d.position=[(i%grid)*20-1000, Math.floor(i/grid)*20-1000, 0]; }); basePositions = nodes.map(d=>d.position.slice());
    }
  }

  function colorFor(n, ethos, lastAct){
    if (n.frozen) return [68,136,255,220]; if (n.dormant) return [102,102,102,140];
    const days = lastAct? (Date.now()/1000 - lastAct)/86400: 365; if (days<7) return [255,0,102,200];
    const g = clamp(Math.floor(100 + Math.min(1, ethos/1500)*155), 0, 255); return [0,g,102,180];
  }

  function render(nodes, edges, mode){
    const w = center.clientWidth||1200, h=center.clientHeight||800;
    const grid = makeGridLines(w, h, 50);
    const holdersHulls = (mode==='holders' && ui.bubbles) ? computeHulls(nodes, presetData) : [];
    // Apply highlight filter dimming
    if (highlightSet && highlightSet.size){ nodes.forEach(n=>{ const on = highlightSet.has(n.id); const c=n.baseColor.slice(); c[3] = on? Math.max(160, c[3]||160) : 35; n.color=c; }); }
    else { nodes.forEach(n=> n.color = n.baseColor.slice()); }

    // Selection ring data (persistent after click)
    const selObj = selectedId>0 ? nodes.find(n=>n && n.id===selectedId) : null;

    let layers = [
      // Grid lines behind everything
      new LineLayer({ id:'grid', data:grid, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,25], getWidth:1, widthUnits:'pixels' }),
      // Ownership hull rings (soft fill + stroke)
      holdersHulls.length && new PolygonLayer({ id:'hulls', data:holdersHulls, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPolygon:d=>d.path, stroked:true, filled:true, getFillColor:[0,255,102,10], getLineColor:[0,255,102,45], getLineWidth:1, lineWidthUnits:'pixels' }),
      // Ambient ownership edges
      (ui.ownership && ui.ambient) && new LineLayer({ id:'edges', data:edges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>nodes[d.sourceIndex]?.position||[0,0,0], getTargetPosition:d=>nodes[d.targetIndex]?.position||[0,0,0], getColor:d=>d.color, getWidth:d=>d.width, widthUnits:'pixels', opacity:0.35 }),
      // Wash/desire overlays
      (ui.wash && washSet && washSet.size) && new ScatterplotLayer({ id:'wash', data:nodes.filter(n=>washSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(8, (d.radius||4)+6), getFillColor:[0,0,0,0], getLineColor:[255,0,102,220], lineWidthMinPixels:1.5, stroked:true, filled:false, radiusUnits:'pixels' }),
      (ui.desire && desireSet && desireSet.size) && new ScatterplotLayer({ id:'desire', data:nodes.filter(n=>desireSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(7, (d.radius||4)+4), getFillColor:[0,0,0,0], getLineColor:[255,215,0,200], lineWidthMinPixels:1, stroked:true, filled:false, radiusUnits:'pixels' }),
      new ScatterplotLayer({ id:'glow', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>d.radius*3.5, getFillColor:d=>[d.color[0],d.color[1],d.color[2], 20], radiusUnits:'pixels', parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
      new ScatterplotLayer({ id:'nodes', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, highlightColor:[255,255,255,80], getPosition:d=>d.position, getRadius:d=>d.radius||4, getFillColor:d=>d.color, radiusUnits:'pixels', onClick: handleClick }),
      (selObj) && new ScatterplotLayer({ id:'selection-ring', data:[selObj], coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(10,(d.radius||4)+8), getFillColor:[0,0,0,0], getLineColor:[0,255,102,220], lineWidthMinPixels:2, stroked:true, filled:false, radiusUnits:'pixels' })
    ];
    // View-specific adds
    try {
      if (mode==='holders') layers = makeHoldersLayers(layers);
      if (mode==='traits' && ui.traits) layers = makeTraitsLayers(layers);
      if (mode==='wallets') layers = makeWalletsLayers(layers);
      if (mode==='transfers') layers = makeTransfersLayers(layers);
      // Health/Activity view keys off select state while using holders data
      const ve = document.getElementById('view');
      if (ve && ve.value==='health' && mode==='holders') layers = makeActivityLayers(layers);
    } catch {}
    if (mode==='traits' && ui.traits){
      const paths = computeConstellationPaths(nodes, presetData);
      if (paths.length) layers.unshift(new LineLayer({ id:'trait-constellations', data:paths, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[255,215,0,160], getWidth:0.8, widthUnits:'pixels', opacity:0.6 }));
    }
    deckInst.setProps({ layers });
  }

  function animateHolders(t){
    // advance orbital angle; re-render will recompute positions in layer getPosition
    for (const d of nodes){ d.orbit = (d.orbit || 0) + 0.007; }
    render(nodes, edges, currentMode);
  }
  function animateTraits(t){
    if (!basePositions) return;
    const out = nodes.map((d,i)=>{ const bp=basePositions[i]; const ny = bp[1] + Math.sin((i*0.1)+t)*1.5; return [bp[0], ny, 0]; });
    nodes.forEach((d,i)=> d.position=out[i]);
    render(nodes, edges, currentMode);
  }

  function bindShortcuts(){
    window.addEventListener('keydown', (e)=>{
      const viewEl = document.getElementById('view'); if (!viewEl) return;
      const map = { '1':'ownership','2':'trading','3':'traits','4':'whales','5':'health' };
      if (map[e.key]){ viewEl.value = map[e.key]; viewEl.dispatchEvent(new Event('change')); }
      if (e.key==='r' || e.key==='R'){ deckInst?.setProps({initialViewState:{target:[0,0,0], zoom:0}}); }
    });
  }

  function makeGridLines(w, h, step){
    const data = [];
    for (let x=0;x<=w;x+=step) data.push({ s:[x,0,0], t:[x,h,0] });
    for (let y=0;y<=h;y+=step) data.push({ s:[0,y,0], t:[w,y,0] });
    return data;
  }

  function computeHulls(nodes, pdata){
    try {
      const byOwner = new Map();
      nodes.forEach((n,i)=>{ const oi=n.ownerIndex; if (oi==null||oi<0) return; if(!byOwner.has(oi)) byOwner.set(oi, []); byOwner.get(oi).push(i); });
      const owners = Array.from(byOwner.entries()).sort((a,b)=> (b[1].length - a[1].length)).slice(0,12);
      const out=[];
      for (const [oi, idxs] of owners){
        if (idxs.length<4) continue;
        let sx=0,sy=0; idxs.forEach(i=>{ sx+=nodes[i].position[0]; sy+=nodes[i].position[1]; });
        const cx=sx/idxs.length, cy=sy/idxs.length;
        const dists = idxs.map(i=>{ const n=nodes[i]; const dx=n.position[0]-cx, dy=n.position[1]-cy; return Math.hypot(dx,dy); }).sort((a,b)=>a-b);
        const r = (dists[Math.floor(dists.length*0.8)]||20)*1.15 + 18;
        const path = circlePath(cx, cy, r, 48);
        out.push({ path });
      }
      return out;
    } catch { return []; }
  }

  function circlePath(cx,cy,r,segments){
    const pts=[]; for(let i=0;i<segments;i++){ const ang=(i/segments)*Math.PI*2; pts.push([cx+Math.cos(ang)*r, cy+Math.sin(ang)*r, 0]); } return pts;
  }

  async function fetchFlowEdges(nodes){
    try {
      const r = await fetch('/api/transfer-edges?limit=1000&nodes=10000').then(x=>x.json());
      // Map representative tokens to node indices
      const mapIndex = new Map(); nodes.forEach((n,i)=>mapIndex.set(n.tokenId+1, i));
      return r.map(e=>({ a: mapIndex.get(e.a), b: mapIndex.get(e.b), count: e.count||1, type: (e.type||'transfer') })).filter(x=>x.a!=null && x.b!=null);
    } catch { return null; }
  }

  function computeConstellationPaths(nodes, pdata){
    const tk = pdata?.tokenTraitKey||[]; const freq = new Map(); tk.forEach(k=>{ if (k>=0) freq.set(k,(freq.get(k)||0)+1); });
    const groups = new Map(); nodes.forEach(n=>{ const k=tk[n.tokenId]; const f=freq.get(k)||0; if (k>=0 && f>=3 && f<=30){ if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(n); } });
    const out = [];
    groups.forEach(list=>{
      if (list.length<3) return; let sx=0, sy=0; list.forEach(n=>{ sx+=n.position[0]; sy+=n.position[1]; }); const cx=sx/list.length, cy=sy/list.length;
      const ordered = list.map(n=>({n, ang: Math.atan2(n.position[1]-cy, n.position[0]-cx)})).sort((a,b)=>a.ang-b.ang).map(o=>o.n);
      for (let i=0;i<ordered.length;i++){ const a=ordered[i], b=ordered[(i+1)%ordered.length]; out.push({ s:a.position, t:b.position }); if (out.length>800) break; }
    });
    return out;
  }

  async function handleClick(info){
    const detailsEl = document.getElementById('details'); const thumb = document.getElementById('thumb');
    if(!info?.object){ detailsEl.innerHTML='Select a node…'; if(thumb) thumb.style.display='none'; return; }
    const id = info.object.id; selectedId = id;
    try {
      const t = await fetch(API.token(id)+'?v='+Date.now()).then(r=>r.json());
      if (thumb){ thumb.style.display='block'; thumb.src = `/${t.thumbnail_local||t.image_local||('thumbnails/'+id+'.jpg')}`; }
      // Pull story + listings + wallet meta
      const [story, listings, walletMeta] = await Promise.all([
        fetch(API.story(id)).then(r=>r.ok?r.json():null).catch(()=>null),
        fetch(`/api/token/${id}/listings`).then(r=>r.ok?r.json():{listings:[]}).catch(()=>({listings:[]})),
        t.owner ? fetch(`/api/wallet/${t.owner}/meta?v=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null) : null
      ]);
      const birth = story?.birth_date? (timeAgo(Number(story.birth_date)*1000)+' ago') : '--';
      const owners = story?.total_owners ?? '--';
      const peak = story?.peak_price!=null? (Math.round(story.peak_price*100)/100 + ' TIA') : '--';
      const ethos = (walletMeta && typeof walletMeta.ethos_score==='number') ? Math.round(walletMeta.ethos_score) : (t?.ethos?.score!=null? Math.round(t.ethos.score): null);
      const realized = walletMeta?.realized_pnl_tia != null ? Math.round(walletMeta.realized_pnl_tia*100)/100 : null;
      const lastBuy = (t?.last_buy_price!=null) ? (Math.round(Number(t.last_buy_price)*100)/100 + ' TIA') : '--';
      const lastSale = (t?.last_sale_price!=null) ? (Math.round(Number(t.last_sale_price)*100)/100 + ' TIA') : '--';
      const holdDays = t.hold_days!=null ? Math.round(Number(t.hold_days)) : '--';
      const traitsRows = (t.traits||[]).slice(0,18).map(a=>`<div class='label'>${a.trait_type}</div><div class='value'>${a.trait_value}</div>`).join('');
      const listingRows = (listings?.listings||[]).slice(0,6).map(l=>`<div class='label'>${l.platform||l.marketplace||'MARKET'}</div><div class='value'>${(l.price!=null? (Math.round(l.price*100)/100+' TIA') : '--')}</div>`).join('');
      const ethosCard = (ethos!=null) ? `
        <div class='card'>
          <div class='label'>ETHOS</div>
          <div class='big-number'>${ethos}</div>
        </div>` : `
        <div class='card'>
          <div class='label'>ETHOS</div>
          <div class='big-number'>N/A</div>
        </div>`;

      detailsEl.innerHTML = `
        <div class='token-title'>MAMMOTH #${String(id).padStart(4,'0')}</div>
        <div class='section-label'>OWNER</div>
        <div class='address'>${(t.owner||'').slice(0,6)}...${(t.owner||'').slice(-4)}</div>
        <div class='card2'>
          ${ethosCard}
          <div class='card'><div class='label'>HOLDINGS</div><div class='big-number'>${walletMeta?.total_holdings ?? '--'}</div></div>
        </div>
        <div class='card2'>
          <div class='card'><div class='label'>REALIZED PNL</div><div class='big-number'>${realized!=null? (realized+' TIA') : '--'}</div></div>
          <div class='card'><div class='label'>TRADES</div><div class='big-number'>${walletMeta?.trade_count ?? '--'}</div></div>
        </div>
        <div class='card2'>
          <div class='card'><div class='label'>LAST BUY</div><div class='big-number'>${lastBuy}</div></div>
          <div class='card'><div class='label'>LAST SALE</div><div class='big-number'>${lastSale}</div></div>
        </div>
        <div class='card2'>
          <div class='card'><div class='label'>BIRTH</div><div class='big-number'>${birth}</div></div>
          <div class='card'><div class='label'>OWNERS</div><div class='big-number'>${owners}</div></div>
        </div>
        <div class='card2'>
          <div class='card'><div class='label'>HOLD DAYS</div><div class='big-number'>${holdDays}</div></div>
          <div class='card'><div class='label'>PEAK</div><div class='big-number'>${peak}</div></div>
        </div>
        <div class='section-label'>LISTINGS</div>
        <div class='traits-table'>${listingRows || `<div class='label'>NO LISTINGS</div><div class='value'>--</div>`}</div>
        <div class='section-label'>TRAITS</div>
        <div class='traits-table'>${traitsRows}</div>
      `;
      render(nodes, edges, currentMode);
    } catch { detailsEl.innerHTML='Select a node…'; }
  }

  function timeAgo(ms){
    const s = Math.max(1, Math.floor((Date.now()-ms)/1000));
    const d = Math.floor(s/86400); if (d>=1) return `${d} day${d>1?'s':''}`; const h=Math.floor(s/3600); if (h>=1) return `${h} hour${h>1?'s':''}`; const m=Math.floor(s/60); if (m>=1) return `${m} min${m>1?'s':''}`; return `${s}s`;
  }

  // Helpers
  function getChecked(id, fallback){ try { const el=document.getElementById(id); if (!el) return !!fallback; return !!el.checked; } catch { return !!fallback; } }
  async function highlightWallet(address){
    try {
      const r = await fetch(`/api/wallet/${address}`).then(x=>x.json());
      const ids = new Set((r.tokens||[]).map(Number));
      highlightSet = ids; selectedId=-1; render(nodes,edges,currentMode);
    } catch { highlightSet=null; }
  }
  async function fetchWash(){ try { const r = await fetch('/api/suspicious-trades').then(x=>x.json()); const s=new Set((r.tokens||[]).map(t=>Number(t.token_id||t.id))); return s; } catch { return null; } }
  async function fetchDesire(){ try { const r = await fetch('/api/desire-paths').then(x=>x.json()); const s=new Set((r.desire_paths||[]).map(t=>Number(t.token_id||t.id))); return s; } catch { return null; } }
  function focusSelect(id){ const obj = nodes.find(n=>n.id===id); if (!obj) return; selectedId=id; // center roughly by resetting viewState target
    try { const vs = deckInst?.viewState || {}; deckInst?.setProps?.({ initialViewState: { target: [obj.position[0], obj.position[1], 0], zoom: 1.2 } }); } catch {}
    handleClick({ object: obj }); }

  // ---------- View builders and helpers ----------
  function computeOwnerMetrics(pdata, nodeList){
    try {
      const oi = pdata?.ownerIndex || [];
      const owners = pdata?.owners || [];
      const counts = new Array(owners.length).fill(0);
      for (let i=0;i<oi.length;i++){ const k=oi[i]; if (k>=0) counts[k]++; }
      ownerHoldings = counts;
      // Radial packing for owner centers, weighted by holdings
      const ranked = owners.map((o,idx)=>({ idx, c: counts[idx]||0 })).sort((a,b)=>b.c-a.c);
      const centers = new Array(owners.length).fill(null);
      const ringStep = 260; let ring=0, placed=0; let perRing=6;
      for (let i=0;i<ranked.length;i++){
        if (placed>=perRing){ ring++; placed=0; perRing = Math.ceil(perRing*1.6); }
        const ang = (placed/perRing)*Math.PI*2; placed++;
        const r = 120 + ring*ringStep;
        centers[ranked[i].idx] = [Math.cos(ang)*r, Math.sin(ang)*r, 0];
      }
      ownerCenters = centers;
      // Attach owner center + orbit params to nodes (for holders view)
      nodeList.forEach(n=>{ const ownerIdx = n.ownerIndex; const c = centers[ownerIdx] || [0,0,0]; n.ownerX=c[0]; n.ownerY=c[1]; n.orbit = (n.id%360) * Math.PI/180; n.orbitRadius = 40 + (counts[ownerIdx]||1)*0.9; });
    } catch {}
  }

  function makeHoldersLayers(base){
    try {
      // 1) Density layer (Hexagon or ScreenGrid fallback)
      const layerData = (ownerCenters||[]).map((p,idx)=> p? { clusterCenter: p, tokenCount: ownerHoldings[idx]||0 } : null).filter(Boolean);
      const hexCls = HexagonLayer || ScreenGridLayer;
      const density = new hexCls({
        id: 'ownership-density',
        data: layerData,
        getPosition: d => d.clusterCenter,
        radius: 100,
        coverage: 0.8,
        elevationScale: 0,
        getColorWeight: d => d.tokenCount,
        colorRange: [[0,0,0,0],[0,255,102,100],[0,255,102,255]]
      });
      // 2) Tokens with orbital motion around owner center
      const tokens = new ScatterplotLayer({
        id: 'token-orbits',
        data: nodes,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255,255,255,80],
        getPosition: d => [ d.ownerX + Math.cos(d.orbit)*d.orbitRadius, d.ownerY + Math.sin(d.orbit)*d.orbitRadius, 0 ],
        getRadius: d => (ownerHoldings?.[d.ownerIndex]||0) > 20 ? 8 : 4,
        getFillColor: d => {
          const ethos = (presetData?.ownerEthos?.[d.ownerIndex]||0);
          return ethos>800 ? [255,215,0,200] : d.color;
        },
        radiusUnits:'pixels',
        onClick: handleClick
      });
      // 3) Ownership connections (owner center -> orbiting token)
      const hasArc = typeof ArcLayer === 'function';
      const arcsData = nodes.slice(0, Math.min(nodes.length, 5000)).map(d=>({ s: [d.ownerX, d.ownerY, 0], t: [ d.ownerX + Math.cos(d.orbit)*d.orbitRadius, d.ownerY + Math.sin(d.orbit)*d.orbitRadius, 0 ] }));
      const arcs = hasArc ? new ArcLayer({ id:'ownership-links', data: arcsData, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getSourceColor:[0,255,102,255], getTargetColor:[0,255,102,0], getWidth:1 }) : null;
      return [ density, tokens, arcs, ...base.filter(Boolean) ];
    } catch { return base; }
  }

  function makeTraitsLayers(base){
    const tk = presetData?.tokenTraitKey || [];
    const traitKeys = presetData?.traitKeys || [];
    const groups = new Map();
    nodes.forEach(n=>{ const k=tk[n.tokenId]; if (k>=0){ if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(n); }});
    // Cluster positions on spiral
    const keys = Array.from(groups.keys());
    const clusterPos = new Map();
    const step = 220; keys.forEach((k,i)=>{ const ang=i*0.6; const r=200 + Math.sqrt(i)*step; clusterPos.set(k, [Math.cos(ang)*r, Math.sin(ang)*r, 0]); });
    nodes.forEach(n=>{ const k=tk[n.tokenId]; const c = clusterPos.get(k) || [0,0,0]; n.position = [ c[0] + ((n.tokenId%20)-10)*10, c[1] + (Math.floor(n.tokenId/20)%10 -5)*10, 0]; n.radius = (n.rarity>0.9)?8:4; });
    const points = new ScatterplotLayer({ id:'trait-clusters', data:nodes, getPosition:d=>d.position, getRadius:d=>d.radius, getFillColor:d=> d.rarity>0.95 ? [255,0,255,200] : d.color, radiusUnits:'pixels', pickable:true, onClick:handleClick });
    const helix = typeof PathLayer==='function' ? new PathLayer({ id:'trait-dna', data: Array.from(groups.values()).map(list=> helixPath(list)), getPath:d=>d, getColor:[0,255,102,100], getWidth:2, widthMinPixels:1, parameters:{ depthTest:false } }) : null;
    const labels = new TextLayer({ id:'trait-labels', data: keys.map(k=>({ k, center: clusterPos.get(k)||[0,0,0] })), getPosition:d=>d.center, getText:d=> traitKeys[d.k]||('Trait '+d.k), getSize:14, getColor:[0,255,102,200], fontFamily:'IBM Plex Mono', getPixelOffset:[0,-20] });
    return [ points, helix, labels, ...base.filter(Boolean) ];
  }

  function helixPath(list){
    if (!list || list.length<3) return [];
    const c = list.reduce((acc,n)=>{acc[0]+=n.position[0];acc[1]+=n.position[1];return acc;},[0,0]); c[0]/=list.length; c[1]/=list.length;
    const ordered = list.map(n=>({n, ang:Math.atan2(n.position[1]-c[1], n.position[0]-c[0])})).sort((a,b)=>a.ang-b.ang).map(o=>o.n);
    const path=[]; for (let i=0;i<ordered.length;i++){ const a=ordered[i].position; const b=ordered[(i+1)%ordered.length].position; const mid=[(a[0]+b[0])/2, (a[1]+b[1])/2, 0]; path.push(a, mid, b); }
    return path;
  }

  function makeWalletsLayers(base){
    const owners = (presetData?.owners||[]).map((addr,i)=>({ address: addr, position: ownerCenters?.[i] || [0,0,0], ethos: presetData?.ownerEthos?.[i] || 0, holdings: ownerHoldings?.[i] || 0 }));
    const glow = new ScatterplotLayer({ id:'wallet-glow', data: owners, getPosition:d=>d.position, getRadius:d=>Math.max(6, Math.sqrt(d.ethos||100)), getFillColor:d=>[0, Math.min(255,(d.ethos||0)/4), 102, 25], radiusUnits:'pixels' });
    const nodesL = new ScatterplotLayer({ id:'wallet-nodes', data: owners, pickable:true, autoHighlight:true, onClick: async (info)=>{ if(info?.object){ await openWallet(info.object.address);} }, getPosition:d=>d.position, getRadius:d=> Math.max(3, Math.sqrt(d.ethos||100)), getFillColor:d=>[0, Math.min(255,(d.ethos||0)/4), 102, 200], getLineColor:d=>[255,255,255, d.ethos>800?255:0], lineWidthMinPixels: d=> d.ethos>800?2:0, stroked:true, radiusUnits:'pixels' });
    return [ glow, nodesL, ...base ];
  }

  async function openWallet(addr){
    await highlightWallet(addr);
    try {
      const meta = await fetch(`/api/wallet/${addr}/meta`).then(r=>r.json());
      const detailsEl = document.getElementById('details');
      const thumb = document.getElementById('thumb'); if (thumb) thumb.style.display='none';
      const ethos = meta?.ethos_score!=null? Math.round(meta.ethos_score): 'N/A';
      detailsEl.innerHTML = `
        <div class='token-title'>${meta.ens_name || addr}</div>
        <div class='section-label'>HOLDINGS</div>
        <div class='big-number'>${meta.total_holdings ?? '--'}</div>
        <div class='card2'>
          <div class='card'><div class='label'>ETHOS</div><div class='big-number'>${ethos}</div></div>
          <div class='card'><div class='label'>TRADES</div><div class='big-number'>${meta.trade_count ?? '--'}</div></div>
        </div>
      `;
    } catch {}
  }

  // Transfers view helpers
  function makeTransfersLayers(base){
    const add = [];
    if (flowEdges && flowEdges.length){
      add.push(new LineLayer({ id:'transfer-volume', data:flowEdges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, widthUnits:'pixels', getSourcePosition:e=>nodes[e.a]?.position, getTargetPosition:e=>nodes[e.b]?.position, getColor:[0,255,102,140], getWidth:e=>Math.max(1, Math.log1p(e.count)), opacity:0.45 }));
    }
    const TripsLayer = window.deck && window.deck.TripsLayer;
    if (TripsLayer) add.unshift(makeTripsLayer());
    return [ ...add, ...base ];
  }

  function makeTripsLayer(){
    const TripsLayer = window.deck.TripsLayer;
    let cached = null;
    return new TripsLayer({
      id:'transfer-flows',
      data: async ()=>{
        if (cached) return cached;
        const r = await fetch('/api/transfers?limit=3000').then(x=>x.json()).catch(()=>({transfers:[]}));
        const transfers = r.transfers||[];
        const walletCenters = new Map();
        const owners = presetData?.owners || [];
        for (let i=0;i<owners.length;i++){ const c = ownerCenters?.[i]; if (c) walletCenters.set(owners[i], c); }
        cached = transfers.map(tr=>{
          const s = walletCenters.get(tr.from) || [0,0,0];
          const t = walletCenters.get(tr.to) || [0,0,0];
          return { path:[s,t], timestamps:[tr.timestamp, tr.timestamp+60], price: tr.price||0 };
        });
        return cached;
      },
      currentTime: (Date.now()/1000)% (24*3600),
      getPath: d=>d.path,
      getTimestamps: d=>d.timestamps,
      trailLength: 3600*2,
      fadeTrail: true,
      widthMinPixels: 2,
      getWidth: d=> Math.max(2, Math.sqrt(Math.max(0.01, d.price)) * 3),
      getColor: d=> d.price>1 ? [255,215,0] : [0,255,102],
      capRounded: true,
      jointRounded: true,
      opacity: 0.8,
      coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN
    });
  }
})();
