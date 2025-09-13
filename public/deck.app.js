// Deck.gl engine mounted into the center panel while keeping left/right UI
// Load with ?engine=deck or localStorage.engine='deck'
(function(){
  const center = document.querySelector('.center-panel');
  const stage = document.getElementById('stage');
  if (stage) stage.style.display = 'none';
  if (!center) return;

  const {Deck, ScatterplotLayer, LineLayer, TextLayer, PolygonLayer, ArcLayer, ScreenGridLayer, HexagonLayer, HeatmapLayer, PathLayer, PointCloudLayer, OrthographicView, COORDINATE_SYSTEM, BrushingExtension} = window.deck || {};
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
  let hasFittedOnce = false; // fit view after first render
  let currentZoom = 0;       // updated on view changes
  const timeline = { start: null, end: null, value: null, playing: true };
  let transfersCache = null; // reuse transfers for flows/heat/shockwaves
  let pulseT = 0;            // animation time for pulses
  let hoveredOwner = -1;     // owner core hover state
  let collapseOwner = -1;    // owner collapse animation
  let collapsePhase = 0;     // 0..1..0 ease
  let timelineLimits = null; // {t0,t1}

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
    startUILoad();
    presetData = await fetch(API.preset).then(r=>r.json()).catch(()=>null);
    const w = center.clientWidth||800, h = center.clientHeight||600;
    deckInst = new Deck({
      canvas: 'deck-canvas', width:w, height:h, controller:true,
      views:[ new (OrthographicView||window.deck.OrthographicView)({ id:'ortho' }) ],
      initialViewState:{ target:[0,0,0], zoom:0 },
      onViewStateChange: ({viewState}) => { currentZoom = viewState.zoom; }
    });
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
    // Build traits UI for deck engine
    try { buildTraitsUI(); } catch {}
    stopUILoad();
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
    // Time slider controls for trading flows
    const timeEl = document.getElementById('time-slider');
    const timeLabel = document.getElementById('time-label');
    const fmtDate = ts => { try{ const d=new Date((ts||0)*1000); return d.toISOString().slice(0,10);}catch{return ''} };
    if (timeEl && !timeEl.dataset.deckBound){
      timeEl.dataset.deckBound='1';
      const updateLabel = ()=>{ if (timeLabel) timeLabel.textContent = timeline.value!=null? fmtDate(timeline.value): '' };
      timeEl.addEventListener('input', ()=>{
        if (timeline.start!=null && timeline.end!=null){
          const p = Math.max(0, Math.min(100, parseInt(timeEl.value||'0',10)))/100;
          timeline.value = Math.round(timeline.start + (timeline.end - timeline.start)*p);
          timeline.playing = false;
          if (currentMode==='transfers') render(nodes, edges, currentMode);
          updateLabel();
        }
      });
      timeEl.addEventListener('change', ()=>{ timeline.playing = true; });
      setInterval(()=>{
        if (!timeline.playing || timeline.start==null || timeline.end==null) return;
        const p = ((parseInt(timeEl.value||'0',10)+1)%101);
        timeEl.value = String(p);
        const frac=p/100; timeline.value = Math.round(timeline.start + (timeline.end - timeline.start)*frac);
        if (currentMode==='transfers') render(nodes, edges, currentMode);
        updateLabel();
      }, 2000);
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
    startUILoad();
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
      const now = (performance.now? performance.now(): Date.now());
      const t = (now - start)/1000;
      pulseT = t; // global pulse time
      if (currentMode==='holders') animateHolders(t);
      else if (currentMode==='traits') animateTraits(t);
      else if (currentMode==='transfers') { if (timeline.playing) render(nodes, edges, currentMode); }
      animReq = requestAnimationFrame(tick);
    };
    animReq = requestAnimationFrame(tick);
    stopUILoad();
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
      // Group tokens by owner to assign orbital rings by recency
      const byOwner = new Map();
      for (const d of nodes){ const oi=d.ownerIndex; if (oi==null||oi<0) continue; if(!byOwner.has(oi)) byOwner.set(oi, []); byOwner.get(oi).push(d); }
      byOwner.forEach(list=>{ list.sort((a,b)=>(a.lastActivity||0)-(b.lastActivity||0)); /* oldest first */ });
      const ringCount = 5; const ringSpacing = 14;
      basePositions = nodes.map((d,i)=>{
        const hub = hubs.get(d.ownerIndex) || [cx,cy,0];
        // ring index by quantiles within owner
        const list = byOwner.get(d.ownerIndex) || [];
        let ring = 0; if (list.length>0){ const idx = list.indexOf(d); const q = idx/(list.length-1||1); ring = Math.max(0, Math.min(ringCount-1, Math.floor(q*ringCount))); }
        const baseR = 26 + ring*ringSpacing + Math.sqrt((ownerHoldings?.[d.ownerIndex]||1))*1.0;
        d.orbitRadius = baseR; // base radius
        // speed: newer trades faster
        const recency = Math.max(0, Math.min(1, (Date.now()/1000 - (d.lastActivity||0)) / (86400*365)));
        d.orbitSpeed = 0.010 / Math.max(1, Math.sqrt((ownerHoldings?.[d.ownerIndex]||1))) * (1.2 - 0.6*Math.min(1, recency));
        const ang=(i*0.47)% (Math.PI*2); const pos=[hub[0]+Math.cos(ang)*baseR, hub[1]+Math.sin(ang)*baseR, 0]; d.position=pos; return pos.slice();
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
      // Timeline layout: X=time, Y=price (log)
      const tarr = pdata.tokenLastActivity||[]; const parr = pdata.tokenLastSalePrice||[];
      const t0 = Math.min(...tarr.filter(Boolean)), t1 = Math.max(...tarr.filter(Boolean));
      timelineLimits = { t0: t0||0, t1: t1||1 };
      const lx = (t)=>{ if(!t0||!t1||t0===t1) return cx; return (t - t0)/(t1 - t0) * (w-160) + 80; };
      const ly = (p)=>{ const v=Math.log1p(Math.max(0, p||0)); const vmax = Math.log1p(Math.max(1, Math.max(...parr.filter(x=>x!=null))))||1; const y = (1 - v/(vmax||1))*(h-160) + 80; return y; };
      basePositions = nodes.map(d=>{ const t=tarr[d.tokenId]||t0; const p=parr[d.tokenId]||0; const pos=[lx(t), ly(p), 0]; d.position=pos; d.radius=3+(p?Math.min(6,Math.sqrt(p)):2); return pos.slice(); });
    } else {
      // Default grid
      const grid=100; nodes.forEach((d,i)=>{ d.position=[(i%grid)*20-1000, Math.floor(i/grid)*20-1000, 0]; }); basePositions = nodes.map(d=>d.position.slice());
    }
    hasFittedOnce = false; // trigger fit on next render
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
      // Fancy ownership multi-rings (top owners)
      (mode==='holders' && ui.bubbles) && new PolygonLayer({ id:'owner-rings', data: buildOwnerRings(), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, stroked:true, filled:false, getPolygon:d=>d.path, getLineColor:d=>d.color, getLineWidth:d=>d.width, lineWidthUnits:'pixels', parameters:{ depthTest:false }, updateTriggers:{ getLineColor: [pulseT] } }),
      // Ambient ownership edges
      (ui.ownership && ui.ambient) && new LineLayer({ id:'edges', data:edges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>nodes[d.sourceIndex]?.position||[0,0,0], getTargetPosition:d=>nodes[d.targetIndex]?.position||[0,0,0], getColor:d=>d.color, getWidth:d=>d.width, widthUnits:'pixels', opacity:0.35 }),
      // Wash/desire overlays
      (ui.wash && washSet && washSet.size) && new ScatterplotLayer({ id:'wash', data:nodes.filter(n=>washSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(8, (d.radius||4)+6), getFillColor:[0,0,0,0], getLineColor:[255,0,102,220], lineWidthMinPixels:1.5, stroked:true, filled:false, radiusUnits:'pixels' }),
      (ui.desire && desireSet && desireSet.size) && new ScatterplotLayer({ id:'desire', data:nodes.filter(n=>desireSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(7, (d.radius||4)+4), getFillColor:[0,0,0,0], getLineColor:[255,215,0,200], lineWidthMinPixels:1, stroked:true, filled:false, radiusUnits:'pixels' }),
      new ScatterplotLayer({ id:'glow', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>d.radius*3.0, getFillColor:d=>[d.color[0],d.color[1],d.color[2], 12], radiusUnits:'pixels', parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
      // Neighbor edges on click
      (selectedId>0) && new LineLayer({ id:'click-edges', data: buildClickEdges(selectedId), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,180], getWidth:1.2, widthUnits:'pixels', parameters:{ depthTest:false } }),
      new ScatterplotLayer({ id:'nodes', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, highlightColor:[255,255,255,80], getPosition:d=>d.position, getRadius:d=>d.radius||4, getFillColor:d=>d.color, radiusUnits:'pixels', onClick: handleClick }),
      // Subtle pulse rings for recently active tokens
      new ScatterplotLayer({ id:'pulses', data: nodes.filter(n=>recentActive(n)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:false, stroked:true, filled:false, getPosition:d=>d.position, getRadius:d=> (d.radius||4) * (1.6 + 0.4*Math.sin(pulseT*2 + (d.id||0))), getLineColor:[0,255,102,140], lineWidthMinPixels:1, radiusUnits:'pixels', updateTriggers:{ getRadius: [pulseT] }, parameters:{ depthTest:false } }),
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
    // LOD: hide ambient edges when zoomed out
    const lod = (function(z){ if (z < -0.5) return { showEdges:false }; return { showEdges:true }; })(currentZoom);
    if (!lod.showEdges) layers = layers.filter(l=> l && l.id!=='edges');
    deckInst.setProps({ layers });
    if (!hasFittedOnce) { try { fitViewToNodes(nodes); hasFittedOnce = true; } catch {} }
  }

  function animateHolders(t){
    // advance orbital angle; speed scales by owner holdings for a smoother look
    for (const d of nodes){
      const h = (ownerHoldings?.[d.ownerIndex]||1);
      let speed = d.orbitSpeed || (0.010 / Math.max(1, Math.sqrt(h)));
      if (hoveredOwner>=0 && d.ownerIndex===hoveredOwner) speed*=1.6;
      d.orbit = (d.orbit || 0) + speed;
      // collapse animation
      if (collapseOwner>=0 && d.ownerIndex===collapseOwner){
        const k = (collapsePhase<0.5)? (1 - collapsePhase*2*0.6) : (1 - (1-collapsePhase)*2*0.6);
        const r = d.orbitRadius * k;
        const hub = ownerCenters?.[d.ownerIndex] || [0,0,0];
        d.position = [ hub[0] + Math.cos(d.orbit||0)*r, hub[1] + Math.sin(d.orbit||0)*r, 0 ];
      } else if (typeof d.orbitRadius === 'number'){
        const hub = ownerCenters?.[d.ownerIndex] || [0,0,0];
        d.position = [ hub[0] + Math.cos(d.orbit||0)*d.orbitRadius, hub[1] + Math.sin(d.orbit||0)*d.orbitRadius, 0 ];
      }
    }
    if (collapseOwner>=0){ collapsePhase += 0.02; if (collapsePhase>=1){ collapseOwner=-1; collapsePhase=0; } }
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

  function recentActive(n){
    const last = Number(n.lastActivity||0); if (!last) return false;
    const days = (Date.now()/1000 - last) / 86400; return days < 7; // last week
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

  function buildOwnerRings(){
    try {
      if (!ownerCenters || !ownerHoldings) return [];
      const owners = ownerCenters.map((c,i)=>({ i, c, h: ownerHoldings[i]||0 })).filter(o=>o.c).sort((a,b)=>b.h-a.h).slice(0,12);
      const rings = [];
      for (const o of owners){
        const base = 60 + Math.sqrt(o.h||1)*10;
        for (let k=0;k<3;k++){
          const r = base + k*18;
          // animated alpha sweep per ring
          const a = Math.max(20, Math.min(200, Math.round(100 + 60*Math.sin(pulseT*1.2 + k*0.8 + o.i*0.2))));
          rings.push({ path: circlePath(o.c[0], o.c[1], r, 128), color:[0,255,102, a], width: 1.2 });
        }
      }
      return rings;
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

  // UI loading bar helpers
  let loadCount = 0;
  function startUILoad(){ const el=document.getElementById('top-loader'); if(!el) return; loadCount++; el.hidden=false; }
  function stopUILoad(){ const el=document.getElementById('top-loader'); if(!el) return; loadCount=Math.max(0,loadCount-1); if(loadCount===0) el.hidden=true; }

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

// Timeline flow particles
function buildFlowParticles(limit=600){
  if (!transfersCache || !timelineLimits) return [];
  const dots = [];
  const t0 = timelineLimits.t0 || 0, t1 = timelineLimits.t1 || (t0+1);
  const W = 86400 * 14; // focus 14 days around current time
  const tv = timeline.value || t1;
  const width = (center.clientWidth||1200), height=(center.clientHeight||800);
  const lx = (t)=> (t - t0)/(t1 - t0) * (width-160) + 80;
  const parr = presetData?.tokenLastSalePrice || [];
  const maxP = Math.max(1, Math.max(...parr.filter(x=>x!=null)) || 1);
  const ly = (p)=>{ const v=Math.log1p(Math.max(0,p||0)); const vmax=Math.log1p(maxP)||1; return (1 - v/(vmax)) * (height-160) + 80; };
  for (let i=0;i<transfersCache.length && dots.length<limit;i++){
    const tr = transfersCache[i]; const ts = tr.timestamp||tv; const dt = tv - ts;
    if (dt<0 || dt>W) continue;
    const x = lx(ts);
    const y = ly(tr.price||0) + Math.sin((pulseT*2) + i*0.07) * 6;
    dots.push({ p:[x,y,0], price: tr.price||0 });
  }
  return dots;
}

  function buildClickEdges(id){
    try {
      const idx = id-1;
      const segs = [];
      for (const e of edges){
        const a = e.sourceIndex, b = e.targetIndex;
        if (a===idx || b===idx){
          const pa = nodes[a]?.position, pb = nodes[b]?.position; if (!pa||!pb) continue;
          segs.push({ s: pa, t: pb });
        }
        if (segs.length>800) break;
      }
      return segs;
    } catch { return []; }
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
      const buyVol = walletMeta?.buy_volume_tia != null ? Math.round(walletMeta.buy_volume_tia*100)/100 : null;
      const sellVol = walletMeta?.sell_volume_tia != null ? Math.round(walletMeta.sell_volume_tia*100)/100 : null;
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
          <div class='card'><div class='label'>SPEND</div><div class='big-number'>${buyVol!=null? (buyVol+' TIA') : '--'}</div></div>
          <div class='card'><div class='label'>REVENUE</div><div class='big-number'>${sellVol!=null? (sellVol+' TIA') : '--'}</div></div>
        </div>
        <div class='section-label'>STORY</div>
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
      nodeList.forEach(n=>{
        const ownerIdx = n.ownerIndex; const c = centers[ownerIdx] || [0,0,0];
        const h = (counts[ownerIdx]||1);
        n.ownerX=c[0]; n.ownerY=c[1];
        n.orbit = (n.id%360) * Math.PI/180;
        n.orbitRadius = 28 + Math.sqrt(h)*8; // larger holdings → larger orbit ring
      });
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
        radius: 120,
        coverage: 0.7,
        elevationScale: 0,
        getColorWeight: d => d.tokenCount,
        colorRange: [[0,0,0,0],[0,255,102,60],[0,255,102,140]]
      });
      // 2) Owner cores (whale suns)
      const cores = (function(){ const out=[]; if(!ownerCenters) return out; for (let i=0;i<ownerCenters.length;i++){ const c=ownerCenters[i]; if(!c) continue; const h=ownerHoldings?.[i]||0; const size = 4 + Math.sqrt(h)*1.2; out.push({ idx:i, position:c, size, label: (presetData?.owners?.[i]||'').slice(0,6)+'...'+(presetData?.owners?.[i]||'').slice(-4) }); } return out; })();
      const coreLayer = new ScatterplotLayer({ id:'owner-cores', data: cores, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, onHover: info=>{ hoveredOwner = info?.object?.idx ?? -1; render(nodes,edges,currentMode); }, onClick: info=>{ if(info?.object){ collapseOwner = info.object.idx; collapsePhase=0; } }, getPosition:d=>d.position, getRadius:d=>d.size*3.5, getFillColor:[0,255,102,60], radiusUnits:'pixels' });
      const coreLabels = new TextLayer({ id:'owner-labels', data: cores.slice(0, Math.min(cores.length, 40)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>[d.position[0], d.position[1]-22, 0], getText:d=>d.label, getSize: 12, getColor:[0,255,102,200], fontFamily:'IBM Plex Mono', billboard:true });
      // 3) Tokens with orbital motion around owner center
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
      // 4) Ownership connections (owner center -> orbiting token)
      const hasArc = typeof ArcLayer === 'function';
      const arcsData = nodes.slice(0, Math.min(nodes.length, 6000)).map(d=>({ s: [d.ownerX, d.ownerY, 0], t: [ d.ownerX + Math.cos(d.orbit)*d.orbitRadius, d.ownerY + Math.sin(d.orbit)*d.orbitRadius, 0 ] }));
      const arcs = hasArc ? new ArcLayer({ id:'ownership-links', data: arcsData, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getSourceColor:[0,255,102,180], getTargetColor:[0,255,102,10], getWidth:1 }) : null;
      return [ density, coreLayer, coreLabels, tokens, arcs, ...base.filter(Boolean) ];
    } catch { return base; }
  }

  function makeTraitsLayers(base){
    const tk = presetData?.tokenTraitKey || [];
    const traitKeys = presetData?.traitKeys || [];
    const groups = new Map();
    nodes.forEach(n=>{ const k=tk[n.tokenId]; if (k>=0){ if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(n); }});
    const keys = Array.from(groups.keys());
    const clusterPos = new Map();
    const step = 220; keys.forEach((k,i)=>{ const ang=i*0.6; const r=220 + Math.sqrt(i)*step; clusterPos.set(k, [Math.cos(ang)*r, Math.sin(ang)*r, 0]); });
    nodes.forEach(n=>{ const k=tk[n.tokenId]; const c = clusterPos.get(k) || [0,0,0]; const z=(n.rarity||0)*50; n.position = [ c[0] + ((n.tokenId%20)-10)*12, c[1] + (Math.floor(n.tokenId/20)%10 -5)*12, z]; n.radius = (n.rarity>0.9)?8:4; });
    const points = (typeof PointCloudLayer==='function') ? new PointCloudLayer({ id:'trait-clusters', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getNormal:[0,0,1], getColor:d=> d.rarity>0.95 ? [255,0,255,220] : d.color, pointSize:3, material:{ ambient:0.5, diffuse:1, shininess:30, specularColor:[0,255,102] }, pickable:true, onClick:handleClick }) : new ScatterplotLayer({ id:'trait-clusters', data:nodes, getPosition:d=>[d.position[0],d.position[1],0], getRadius:d=>d.radius, getFillColor:d=> d.rarity>0.95 ? [255,0,255,200] : d.color, radiusUnits:'pixels', pickable:true, onClick:handleClick });
    const helix = typeof PathLayer==='function' ? new PathLayer({ id:'trait-dna', data: Array.from(groups.values()).map(list=> helixPath(list)), getPath:d=>d, getColor:[0,255,102,100], getWidth:2, widthMinPixels:1, parameters:{ depthTest:false } }) : null;
    const labels = new TextLayer({ id:'trait-labels', data: keys.map(k=>({ k, center: clusterPos.get(k)||[0,0,0] })), getPosition:d=>d.center, getText:d=> traitKeys[d.k]||('Trait '+d.k), getSize:14, getColor:[0,255,102,200], fontFamily:'IBM Plex Mono', getPixelOffset:[0,-20] });
    // Rare particle sparkles
    const rare = new ScatterplotLayer({ id:'rare-spark', data: nodes.filter(n=> (n.rarity||0)>0.95), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius: d=> 2 + 1.2*Math.max(0, Math.sin(pulseT*3 + (d.id||0)*0.3)), getFillColor:[255,0,255,220], radiusUnits:'pixels', pickable:false, updateTriggers:{ getRadius: [pulseT] } });
    return [ rare, points, helix, labels, ...base ];
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
    const nodesL = new ScatterplotLayer({ id:'wallet-nodes', data: owners, pickable:true, autoHighlight:true, onClick: async (info)=>{ if(info?.object){ await openWallet(info.object.address);} }, getPosition:d=>d.position, getRadius:d=> Math.max(3, Math.sqrt(d.ethos||100)), getFillColor:d=>[0, Math.min(255,(d.ethos||0)/4), 102, 200], getLineColor:d=>[255,255,255, d.ethos>800?255:0], lineWidthMinPixels: d=> d.ethos>800?2:0, stroked:true, radiusUnits:'pixels', extensions: (typeof BrushingExtension==='function') ? [new BrushingExtension()] : undefined, brushingRadius: 120, brushingEnabled: true });
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

  // Build Traits UI (left panel) and wire to deck highlight
  async function buildTraitsUI(){
    const container = document.getElementById('traits-container');
    if (!container) return;
    container.innerHTML = '';
    const r = await fetch(`/api/traits?v=${Date.now()}`).catch(()=>null);
    if (!r || !r.ok) return;
    const j = await r.json(); const groups = j.traits || [];
    for (const g of groups){
      const wrap = document.createElement('div'); wrap.className='trait-group';
      const header = document.createElement('div'); header.className='trait-header'; header.innerHTML = `<span class="twist">▶</span> ${g.type}`;
      const values = document.createElement('div'); values.className='trait-values';
      for (const v of g.values || []){
        const val = document.createElement('div'); val.className='trait-value'; val.textContent = `${v.value} (${v.count})`;
        val.dataset.type = g.type; val.dataset.value = v.value;
        val.addEventListener('click', onTraitClick);
        values.appendChild(val);
      }
      header.addEventListener('click', ()=>{ const open = values.style.display!=='block'; values.style.display=open?'block':'none'; header.querySelector('.twist').textContent = open?'▼':'▶'; });
      wrap.appendChild(header); wrap.appendChild(values); container.appendChild(wrap);
    }
  }

  async function onTraitClick(e){
    const el = e.currentTarget; const type = el.dataset.type; const value = el.dataset.value;
    if (!type || !value) return;
    try {
      const r = await fetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`).then(x=>x.json());
      const ids = new Set((r.tokens||[]).map(Number));
      highlightSet = ids;
      render(nodes, edges, currentMode);
    } catch {}
  }

  // Price color ramp for flows: green → gold → red
  function priceColor(p){
    const v = Math.max(0, Math.min(1, (Number(p||0) / 2.0)));
    if (v < 0.5){ const t=v/0.5; return [0, Math.round(255*(0.6+0.4*t)), 102]; }
    const t=(v-0.5)/0.5; return [Math.round(255*t), 215, 0];
  }

  function fitViewToNodes(list){
    if (!list || !list.length) return;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const n of list){ const p=n.position; if (!p) continue; if (p[0]<minX) minX=p[0]; if (p[1]<minY) minY=p[1]; if (p[0]>maxX) maxX=p[0]; if (p[1]>maxY) maxY=p[1]; }
    const w = center.clientWidth||1200, h=center.clientHeight||800; const pad = 120;
    const contentW = Math.max(1, maxX-minX), contentH = Math.max(1, maxY-minY);
    const scale = Math.min((w-pad*2)/contentW, (h-pad*2)/contentH);
    const zoom = Math.log2(scale);
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    deckInst.setProps({ initialViewState: { target:[cx,cy,0], zoom } });
  }

  // Transfers view helpers
  function makeTransfersLayers(base){
    const add = [];
    if (flowEdges && flowEdges.length){
      add.push(new LineLayer({ id:'transfer-volume', data:flowEdges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, widthUnits:'pixels', getSourcePosition:e=>nodes[e.a]?.position, getTargetPosition:e=>nodes[e.b]?.position, getColor:[0,255,102,120], getWidth:e=>Math.max(1, Math.log1p(e.count)), opacity:0.35 }));
    }
    // Avoid wallet-positioned flows when using timeline layout; keep heat + particles
    // (We can re-enable TripsLayer if we project to timeline coords later)
    // Flow particles gliding along current timeline
    try { const dots = buildFlowParticles(600); if (dots && dots.length) add.unshift(new ScatterplotLayer({ id:'flow-dots', data:dots, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.p, getRadius:2, getFillColor:d=> priceColor(d.price), radiusUnits:'pixels', pickable:false, updateTriggers:{ getPosition:[timeline.value] } })); } catch {}
    // Heat overlay using transfer timestamps and price
    try {
      if (transfersCache && transfersCache.length && typeof HeatmapLayer==='function'){
        const t0 = timeline.start || Math.min(...transfersCache.map(t=>t.timestamp||0));
        const dt = (timeline.end|| (t0+1)) - t0 || 1;
        const pts = transfersCache.map(tr=>({ position: [ (tr.timestamp - t0)/dt * 2000 - 1000, Math.log1p(Math.max(0,tr.price||0))*200 - 200, 0 ], w: 1 }));
        add.push(new HeatmapLayer({ id:'activity-heat', data: pts, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getWeight:d=>d.w, radiusPixels:24, intensity:1, threshold:0.05, colorRange:[[0,0,0,0],[0,128,51,128],[0,255,102,255]] }));
      }
    } catch {}
    // Price spikes shockwaves (approx)
    try {
      if (transfersCache && timeline.value!=null){
        const now = timeline.value;
        const events = transfersCache.filter(tr=> (tr.price||0) > 2 && (now - tr.timestamp) < 3600*12); // 12h ripple window
        const waves = [];
        for (const e of events){
          const center = ownerCenters?.[ (presetData?.owners||[]).indexOf((e.to||'').toLowerCase()) ] || [0,0,0];
          const age = Math.max(0, now - (e.timestamp||now));
          const r = 50 + age * 5; // wave expands over time
          waves.push({ c:center, r });
        }
        if (waves.length){
          add.unshift(new PolygonLayer({ id:'price-spikes', data:waves, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, stroked:true, filled:false, getPolygon:d=> circlePath(d.c[0], d.c[1], d.r, 64), getLineColor:[255,0,102,100], getLineWidth:2, lineWidthUnits:'pixels', parameters:{ depthTest:false } }));
        }
      }
    } catch {}
    return [ ...add, ...base ];
  }

  function makeTripsLayer(){
    const TripsLayer = (window.deck && (window.deck.TripsLayer || window.deck?.GeoLayers?.TripsLayer)) || window.TripsLayer || null;
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
        if (transfers.length){
          const ts = transfers.map(t=>t.timestamp||0); timeline.start = Math.min(...ts); timeline.end = Math.max(...ts); timeline.value = timeline.end; try{ const s=document.getElementById('time-slider'); if(s) s.value='100'; }catch{}
        }
        transfersCache = transfers;
        cached = transfers.map(tr=>{
          const s = walletCenters.get(tr.from) || [0,0,0];
          const t = walletCenters.get(tr.to) || [0,0,0];
          return { path:[s,t], timestamps:[tr.timestamp, tr.timestamp+60], price: tr.price||0 };
        });
        return cached;
      },
      currentTime: timeline.value || (Date.now()/1000),
      getPath: d=>d.path,
      getTimestamps: d=>d.timestamps,
      trailLength: 3600*6,
      fadeTrail: true,
      widthMinPixels: 2,
      getWidth: d=> Math.max(2, Math.sqrt(Math.max(0.01, d.price)) * 3),
      getColor: d=> priceColor(d.price),
      capRounded: true,
      jointRounded: true,
      opacity: 0.8,
      coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN
    });
  }
})();
