// Deck.gl engine mounted into the center panel while keeping left/right UI
// Load with ?engine=deck or localStorage.engine='deck'
if (!window.deck) {
  console.error('deck.app.js: window.deck missing; aborting init');
  throw new Error('Deck UMD not loaded');
}
(function(){
  // ETag-aware JSON fetch with in-memory memo; dedupes view switches
  const __mem = new Map(); // url -> { etag, json, t }
  async function jfetch(url){
    try {
      const cached = __mem.get(url);
      const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
      const res = await fetch(url, { headers });
      if (res.status===304 && cached) return cached.json;
      const etag = res.headers.get('ETag') || '';
      const json = await res.json();
      __mem.set(url, { etag, json, t: Date.now() });
      return json;
    } catch { return null; }
  }
  // Precomputed caches and builders for fast, simple views
  const pre = { wallets: null, edges: null, tokens: null };
  async function loadPrecomputed(mode){
    try { if (!pre.wallets && (mode==='holders' || mode==='wallets' || mode==='transfers' || mode==='health')) pre.wallets = await jfetch('/api/precomputed/wallets'); } catch {}
    try { if (!pre.edges && mode==='transfers') pre.edges = await jfetch('/api/precomputed/edges?window=30d'); } catch {}
    try { if (!pre.tokens && mode==='traits') pre.tokens = await jfetch('/api/precomputed/tokens'); } catch {}
  }
  function buildWalletBinary(list){
    const wallets = Array.isArray(list?.wallets) ? list.wallets : [];
    const n = wallets.length; const pos = new Float32Array(n*2); const rad = new Float32Array(n); const col = new Uint8ClampedArray(n*4);
    const now = Math.floor(Date.now()/1000);
    for (let i=0;i<n;i++){
      const w = wallets[i]; const xy=w.xy||[0,0]; const h=Number(w.holdings||0); const b=Number(w.buys||0); const s=Number(w.sells||0);
      pos[i*2]=xy[0]; pos[i*2+1]=xy[1];
      rad[i] = 2 + Math.min(6, Math.log10(1 + h+b+s)*2.5);
      const days = w.lastTxAt ? Math.max(0, (now - Number(w.lastTxAt||0))/86400) : 9999;
      const a = Math.round(255 * (0.25 + 0.75 * (1 - Math.min(90, days)/90)));
      let c = COLORS.active;
      if ((h>=10) || (b+s>=20) || (Number(w.volume30dTia||0)>=500)) c = COLORS.whale;
      if (days>=90) c = COLORS.dormant;
      col[i*4]=c[0]; col[i*4+1]=c[1]; col[i*4+2]=c[2]; col[i*4+3]=a;
    }
    return { length:n, attributes:{ getPosition:{ value:pos, size:2 }, getRadius:{ value:rad, size:1 }, getFillColor:{ value:col, size:4 } } };
  }
  function topEdges(edgeList, cap=400){ const e=Array.isArray(edgeList?.edges)?edgeList.edges:[]; return e.slice().sort((a,b)=> (Number(b.valueTia||0)-Number(a.valueTia||0)) || (Number(b.weight||0)-Number(a.weight||0)) ).slice(0,cap); }
  function buildTokenBinary(list){ const t=Array.isArray(list?.tokens)?list.tokens:[]; const n=t.length; const pos=new Float32Array(n*2); const rad=new Float32Array(n); const col=new Uint8ClampedArray(n*4); for(let i=0;i<n;i++){ const it=t[i]; const xy=it.xy||[0,0]; pos[i*2]=xy[0]; pos[i*2+1]=xy[1]; rad[i]=Math.max(2, 10 - Math.log10(Math.max(1, Number(it.rarityRank||999999)))); col[i*4]=0; col[i*4+1]=255; col[i*4+2]=102; col[i*4+3]=200; } return { length:n, attributes:{ getPosition:{value:pos,size:2}, getRadius:{value:rad,size:1}, getFillColor:{value:col,size:4} } };
  }
  // Fallback binary from current graph nodes (positions from applyLayout)
  function buildNodeBinaryFromNodes(nodeList){
    const n = Array.isArray(nodeList)? nodeList.length : 0;
    const pos = new Float32Array(n*2); const rad = new Float32Array(n); const col = new Uint8ClampedArray(n*4);
    for (let i=0;i<n;i++){
      const d=nodeList[i]; const p=d?.position||[0,0,0]; pos[i*2]=p[0]; pos[i*2+1]=p[1];
      rad[i] = d?.radius || 4;
      const c = nodeColor(d) || [0,255,102,200]; const a = c[3]!=null?c[3]:200;
      col[i*4]=c[0]; col[i*4+1]=c[1]; col[i*4+2]=c[2]; col[i*4+3]=a;
    }
    return { length:n, attributes:{ getPosition:{ value:pos, size:2 }, getRadius:{ value:rad, size:1 }, getFillColor:{ value:col, size:4 } } };
  }
  const SIMPLE_VIEW = true;
  let simpleView = 'dots';
  function buildSimpleLayers(mode){
    const layers = []; const zoom=(currentZoom==null)?0:currentZoom;
    if (simpleView==='dots'){
      const hasW = Array.isArray(pre.wallets?.wallets) && pre.wallets.wallets.length>0;
      const bin = hasW ? buildWalletBinary(pre.wallets) : buildNodeBinaryFromNodes(nodes);
      layers.push(new ScatterplotLayer({ id:'dots', data:bin, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, highlightColor:[255,255,255,100], stroked:true, getLineWidth: d=>0, lineWidthUnits:'pixels', transitions:{ getRadius:{ duration:200 } },
        onClick: async (info)=>{
          const idx=info?.index; if (idx==null) return;
          if (hasW){
            const addr=pre.wallets.wallets[idx]?.addr || pre.wallets.wallets[idx]?.address;
            if (addr){
              try {
                const r = await jfetch(`/api/wallet/${addr}`);
                const tok = Array.isArray(r?.tokens) && r.tokens.length ? Number(r.tokens[0]) : null;
                if (tok!=null) { focusSelect(tok); return; }
              } catch {}
            }
          }
          // Fallback: open token from current graph nodes by index
          const obj = nodes[idx]; if (obj) handleClick({ object: obj });
        }
      }));
    } else if (simpleView==='currents' || simpleView==='web'){
      const hasE = Array.isArray(pre.edges?.edges) && pre.edges.edges.length>0;
      if (hasE){
        const E=topEdges(pre.edges, 400);
        if (simpleView==='currents') layers.push(new ArcLayer({ id:'currents', data:E, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, visible: zoom>=1.4, getSourcePosition:e=> e.path?.[0]||[0,0,0], getTargetPosition:e=> e.path?.[1]||[0,0,0], getWidth:e=> Math.max(1, Math.min(3, Math.log10((Number(e.valueTia)||0)+1))), getSourceColor:e=> e.type==='sale'? COLORS.saleArc : COLORS.xferArc, getTargetColor:e=> e.type==='sale'? COLORS.saleArc : COLORS.xferArc }));
        if (simpleView==='web') layers.push(new PathLayer({ id:'web', data:E.map(r=>({ path:r.path, type:r.type, valueTia:r.valueTia })), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, visible: zoom>=1.2, getPath:d=>d.path, getWidth:d=> Math.max(1, Math.min(2, Math.log10((Number(d.valueTia)||0)+1))), widthUnits:'pixels', getColor:d=> d.type==='sale'? COLORS.saleArc : COLORS.xferArc }));
      } else if ((edges||[]).length){
        const segs = (edges||[]).slice(0, 400).map(e=>({ path:[ nodes[e.sourceIndex]?.position||[0,0,0], nodes[e.targetIndex]?.position||[0,0,0] ], type:'transfer', valueTia:1 }));
        if (simpleView==='currents') layers.push(new ArcLayer({ id:'currents', data:segs, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, visible: zoom>=1.4, getSourcePosition:e=> e.path[0], getTargetPosition:e=> e.path[1], getWidth:1, getSourceColor: COLORS.xferArc, getTargetColor: COLORS.xferArc }));
        if (simpleView==='web') layers.push(new PathLayer({ id:'web', data:segs, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, visible: zoom>=1.2, getPath:d=>d.path, getWidth:1, widthUnits:'pixels', getColor: COLORS.xferArc }));
      }
    } else if (simpleView==='pulse'){
      const hasW = Array.isArray(pre.wallets?.wallets) && pre.wallets.wallets.length>0;
      const bin = hasW ? buildWalletBinary(pre.wallets) : buildNodeBinaryFromNodes(nodes);
      const now=Math.floor(Date.now()/1000);
      layers.push(new ScatterplotLayer({ id:'pulse', data:bin, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled, updateTriggers:{ getRadius:[pulseT] }, getRadius:(obj,{index})=>{ const last=(pre.wallets?.wallets?.[index]?.lastTxAt)||0; const base=obj.attributes.getRadius.value[index]; const fresh=(now-last)<86400; return fresh ? base*(1+0.06*Math.sin((pulseT||0)*2+index)) : base; },
        onClick: (info)=>{ const idx=info?.index; if (idx==null) return; if (hasW){ const addr=pre.wallets.wallets[idx]?.addr || pre.wallets.wallets[idx]?.address; if (addr) openWallet(String(addr)); } else { const obj=nodes[idx]; if (obj) handleClick({ object: obj }); } }
      }));
    } else if (simpleView==='crown'){
      const hasT = Array.isArray(pre.tokens?.tokens) && pre.tokens.tokens.length>0;
      const bin = hasT ? buildTokenBinary(pre.tokens) : buildNodeBinaryFromNodes(nodes);
      layers.push(new ScatterplotLayer({ id:'crown', data:bin, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, onHover:onHoverThrottled,
        onClick: (info)=>{ const idx=info?.index; if (idx==null) return; if (hasT){ const t=pre.tokens.tokens[idx]; const id=t?.id; if (id!=null) handleClick({ object:{ id } }); } else { const obj=nodes[idx]; if (obj) handleClick({ object: obj }); } }
      }));
      if (hasT){ try { const tok=pre.tokens?.tokens||[]; const K=20; const top=tok.filter(x=>Number.isFinite(x.rarityRank)).sort((a,b)=> (Number(a.rarityRank||1e12)-Number(b.rarityRank||1e12))).slice(0,K); layers.push(new TextLayer({ id:'crown-labels', data:top, visible:(zoom>=2), getPosition:d=> d.xy||[0,0,0], getText:d=>`#${d.id}`, sizeUnits:'pixels', getSize:12, getColor:[0,255,102,220] })); } catch {} }
    }
    // Selection ring overlay in simple views
    try {
      if (selectedId>0){
        const obj = nodes.find(n=> n && n.id===selectedId);
        if (obj){
          layers.push(new ScatterplotLayer({ id:'selection-ring', data:[obj], coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:false, stroked:true, filled:false, getPosition:d=>d.position, getRadius:d=> Math.max(10,(d.radius||4)+8), getLineColor:[0,255,102,220], lineWidthMinPixels:2, radiusUnits:'pixels' }));
        }
      }
    } catch {}
    return layers;
  }
  // Unified colors and node color mapping (Team, Whale, Frozen, Dormant, Other)
  const COLORS = {
    active:  [0,255,102,220],     // neon green
    whale:   [10,138,61,230],     // dark green
    frozen:  [68,136,255,200],    // blue
    dormant: [102,102,102,180],   // gray
    saleArc: [255,59,59,140],     // red
    xferArc: [74,163,255,140],    // blue
    rare:    [255,215,0,220],     // gold (labels/rare dots)
  };
  function nodeColor(d){
    try {
      const types = presetData?.ownerWalletType || [];
      const t = (d.ownerIndex!=null && d.ownerIndex>=0) ? (types[d.ownerIndex]||'') : '';
      // Whale: explicit wallet_type or large holdings/volume (approx from price)
      const isWhale = (t==='whale_trader' || t==='whale');
      const isFrozen = !!d.frozen;
      const now = Math.floor(Date.now()/1000);
      const daysSince = d.lastActivity? (now - (d.lastActivity||0))/86400 : 9e6;
      const isDormant = !isFrozen && (d.dormant || daysSince >= 90);
      if (isWhale) return COLORS.whale;
      if (isFrozen) return COLORS.frozen;
      if (isDormant) return COLORS.dormant;
      return COLORS.active;
    } catch { return COLORS.active.slice(); }
  }
  const center = document.querySelector('.center-panel');
  const stage = document.getElementById('stage');
  if (stage) stage.style.display = 'none';
  if (!center) return;

  const {Deck, ScatterplotLayer, LineLayer, TextLayer, PolygonLayer, ArcLayer, ScreenGridLayer, HexagonLayer, HeatmapLayer, PathLayer, PointCloudLayer, GPUGridLayer, ContourLayer, IconLayer, OrthographicView, COORDINATE_SYSTEM, BrushingExtension} = window.deck || {};
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
  let ownerCenters = null; // computed per owner (holders view)
  let ownerOceanPos = null; // computed per owner (whales view)
  let ownerHoldings = null;
  const ownerLabels = new Map(); // addr -> label (ENS or short address)
  let hasFittedOnce = false; // fit view after first render
  let currentZoom = 0;       // updated on view changes
  const timeline = { start: null, end: null, value: null, playing: true };
  let transfersCache = null; // reuse transfers for flows/heat/shockwaves
  let pulseT = 0;            // animation time for pulses
  let hoveredOwner = -1;     // owner core hover state
  let collapseOwner = -1;    // owner collapse animation
  let collapsePhase = 0;     // 0..1..0 ease
  let timelineLimits = null; // {t0,t1}
  // UI loading indicator counter
  let loadCount = 0;
  // Cache for trait similarity fetches (tokenId -> [{token_id, similarity}])
  const dnaCache = new Map();
  // Cache for body temperature heatmap (7x24 grid)
  let heatmapCache = null;
  // Cache for wallet relationships
  let whalesRelationships = null;

  // UI toggles reflect left panel checkboxes
  const ui = {
    get ambient(){ return getChecked('ambient-edges', false); },
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
    presetData = await jfetch(API.preset) || null;
    const w = center.clientWidth||800, h = center.clientHeight||600;
    deckInst = new Deck({
      canvas: 'deck-canvas', width:w, height:h,
      controller: { dragPan: true, scrollZoom: true, touchRotate: false, doubleClickZoom: false },
      pickingRadius: 6,
      views:[ new (OrthographicView||window.deck.OrthographicView)({ id:'ortho' }) ],
      initialViewState:{ target:[0,0,0], zoom:0 },
      onViewStateChange: ({viewState}) => { currentZoom = viewState.zoom; }
    });
    try { deckInst.setProps?.({ useDevicePixels: Math.min((window.devicePixelRatio||1), 1.75) }); } catch {}
    // Wire tabs/select and inputs
    bindViewControls();
    bindInputs();
    bindShortcuts();
    try { const se=document.getElementById('search'); if (se) se.value=''; } catch {}
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

  // Simple overlap relaxation within each owner cluster
  function relaxWithinOwners(list, holdings, iters=2, minDist=6){
    try {
      const byOwner = new Map();
      for (const n of list){ const oi=n.ownerIndex; if (oi==null||oi<0) continue; if(!byOwner.has(oi)) byOwner.set(oi, []); byOwner.get(oi).push(n); }
      const md2 = (minDist*minDist);
      for (let k=0;k<iters;k++){
        for (const arr of byOwner.values()){
          for (let i=0;i<arr.length;i++){
            const a = arr[i];
            for (let j=i+1;j<arr.length;j++){
              const b = arr[j];
              const dx = a.position[0]-b.position[0];
              const dy = a.position[1]-b.position[1];
              const d2 = dx*dx+dy*dy;
              if (d2>0 && d2<md2){
                const d = Math.max(1, Math.sqrt(d2));
                const push = (minDist - d)/d * 0.5;
                a.position[0] += dx*push; a.position[1] += dy*push;
                b.position[0] -= dx*push; b.position[1] -= dy*push;
              }
            }
          }
        }
      }
    } catch {}
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
        else if (v==='health') await loadMode('health', edgeCount);
      });
    }
    document.querySelectorAll('.tab-btn[data-view]')?.forEach(btn=>{
      if (!btn.dataset.deckBound){ btn.dataset.deckBound='1'; btn.addEventListener('click', ()=>{ const m=btn.dataset.view; if (m==='ownership') viewEl.value='ownership'; if (m==='trading') viewEl.value='trading'; if (m==='traits') viewEl.value='traits'; if (m==='whales') viewEl.value='whales'; if (m==='health') viewEl.value='health'; viewEl.dispatchEvent(new Event('change')); }); }
    });
    // Simple view buttons
    document.querySelectorAll('.tab-btn[data-simple]')?.forEach(btn=>{
      if (!btn.dataset.deckBound){ btn.dataset.deckBound='1'; btn.addEventListener('click', async ()=>{
        simpleView = String(btn.dataset.simple||'constellation');
        if (simpleView==='constellation') await loadMode('holders', edgeCount);
        else if (simpleView==='currents' || simpleView==='web') await loadMode('transfers', edgeCount);
        else if (simpleView==='pulse') await loadMode('health', edgeCount);
        else if (simpleView==='crown') await loadMode('traits', edgeCount);
      }); }
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
    const full = new URLSearchParams(location.search).has('full');
    const params = new URLSearchParams({ mode, nodes:'10000', edges: full ? '5000' : String(edgesWanted ?? edgeCount) });
    startUILoad();
    const graph = await jfetch(`${API.graph}?${params}`) || {nodes:[],edges:[]};
    await loadPrecomputed(mode);
    const pdata = presetData || {};
    nodes = buildNodes(graph.nodes||[], pdata);
    if (!nodes || nodes.length===0){ stopUILoad(); console.warn('API returned zero nodes'); return; }
    edges = buildEdges(graph.edges||[], nodes);
    computeOwnerMetrics(pdata, nodes);
    applyLayout(nodes, mode, pdata);
    try { relaxWithinOwners(nodes, ownerHoldings, 2, 6); } catch {}
    // lazy fetch flow/activity data
    if ((mode==='transfers' || mode==='holders') && !flowEdges) flowEdges = await fetchFlowEdges(nodes).catch(()=>null);
    // Pull raw transfers for particles if we don't have them yet; also seed the timeline
    if (mode==='transfers' && !transfersCache){
      try {
        const r = await jfetch('/api/transfers?limit=5000');
        transfersCache = Array.isArray(r?.transfers) ? r.transfers : [];
        if (transfersCache.length){
          const ts = transfersCache.map(t=> t.timestamp||0);
          const t0 = Math.min(...ts), t1 = Math.max(...ts);
          timeline.start = t0; timeline.end = t1; timeline.value = t1; timeline.playing = true;
          timelineLimits = { t0, t1 };
        }
      } catch {}
    }
    if (mode==='holders' || mode==='frozen'){ if (!activityBuckets) activityBuckets = await jfetch('/api/activity') || null; }
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
    try { if ((!selectedId || selectedId<0) && nodes && nodes.length){ focusSelect(nodes[Math.floor(nodes.length*0.5)].id); } } catch {}
  }

  // Expose tiny control API for automated tests/screenshots
  try {
    window.mammoths = {
      setSimpleView: async (key)=>{
        simpleView = String(key||'dots');
        if (simpleView==='dots') await loadMode('holders', edgeCount);
        else if (simpleView==='currents' || simpleView==='web') await loadMode('transfers', edgeCount);
        else if (simpleView==='pulse') await loadMode('health', edgeCount);
        else if (simpleView==='crown') await loadMode('traits', edgeCount);
      },
      focusToken: (id)=>{ try { focusSelect(Number(id)); } catch {} },
    };
  } catch {}

  function buildNodes(apiNodes, pdata){
    const ownerIndex = pdata.ownerIndex||[]; const ownerEthos = pdata.ownerEthos||[];
    const tokenLastActivity = pdata.tokenLastActivity||[]; const tokenPrice=pdata.tokenPrice||[]; const rarity=pdata.rarity||[];
    return apiNodes.map((n,i)=>{
      const idx = (n.id-1>=0)?(n.id-1):i;
      const rawOi = ownerIndex[idx];
      // Fallback grouping when DB ownerIndex is missing: spread into 12 clusters
      const oi = (rawOi!=null && rawOi>=0) ? rawOi : (i % 12);
      const ethos=oi>=0?(ownerEthos[oi]||0):0;
      return {
        id: n.id, tokenId: idx,
        position: [0,0,0],
        ownerIndex: oi,
        lastActivity: tokenLastActivity[idx]||0,
        price: tokenPrice[idx]||0,
        rarity: rarity[idx]||0.5,
        frozen: !!n.frozen,
        dormant: !!n.dormant,
        color: [0,255,102,180],
        baseColor: [0,255,102,180],
        radius: 4,
      };
    }).map(d=>{ const c=nodeColor(d); d.baseColor=c.slice(); d.color=c.slice(); return d; });
  }

  function buildEdges(apiEdges, nodes){
    const full = new URLSearchParams(location.search).has('full');
    const cap = full ? 1e9 : 5000;
    return (apiEdges||[]).slice(0,cap).map(e=>{
      const a = Array.isArray(e)?e[0]:e.a; const b = Array.isArray(e)?e[1]:e.b; const ia = (a-1); const ib=(b-1);
      const na = nodes[ia]; const nb = nodes[ib]; if (!na||!nb) return null;
      return { sourceIndex: ia, targetIndex: ib, color:[0,255,102,40], width:1 };
    }).filter(Boolean);
  }

  function applyLayout(nodes, mode, pdata){
    const w = center.clientWidth||1200, h=center.clientHeight||800; const cx=w/2, cy=h/2;
    // Compute layout even when SIMPLE_VIEW is on so fallbacks have positions
    if (mode==='holders'){
      // Gravitational clusters: owner hubs + token orbits
      const owners = Math.max(1, (pdata.owners?.length||12));
      const hubs = new Map();
      nodes.forEach((d,i)=>{ const oi=d.ownerIndex>=0?d.ownerIndex:(i%owners); if (!hubs.has(oi)){ const ang=(oi/owners)*Math.PI*2; hubs.set(oi, [cx+Math.cos(ang)*240, cy+Math.sin(ang)*220, 0]); } });
      // Group tokens by owner to assign orbital rings by recency
      const byOwner = new Map();
      for (const d of nodes){ const oi=d.ownerIndex; if (oi==null||oi<0) continue; if(!byOwner.has(oi)) byOwner.set(oi, []); byOwner.get(oi).push(d); }
      byOwner.forEach(list=>{ list.sort((a,b)=>(a.lastActivity||0)-(b.lastActivity||0)); /* oldest first */ });
      const ringCount = 5;
      basePositions = nodes.map((d,i)=>{
        const hub = hubs.get(d.ownerIndex) || [cx,cy,0];
        // ring index by quantiles within owner
        const list = byOwner.get(d.ownerIndex) || [];
        let ring = 0; let rank = 0; if (list.length>0){ const idx = list.indexOf(d); rank = idx; const q = idx/(list.length-1||1); ring = Math.max(0, Math.min(ringCount-1, Math.floor(q*ringCount))); }
        const ringSpacing = 12 + Math.min(18, Math.sqrt(ownerHoldings?.[d.ownerIndex]||1));
        const baseR = 26 + ring*ringSpacing;
        d.orbitRadius = baseR; // base radius
        // speed: newer trades faster
        const recency = Math.max(0, Math.min(1, (Date.now()/1000 - (d.lastActivity||0)) / (86400*365)));
        d.orbitSpeed = 0.010 / Math.max(1, Math.sqrt((ownerHoldings?.[d.ownerIndex]||1))) * (1.2 - 0.6*Math.min(1, recency));
        // golden-angle within owner to avoid same-angle stacking
        const ang=(rank*2.399963229728653)% (Math.PI*2);
        const pos=[hub[0]+Math.cos(ang)*baseR, hub[1]+Math.sin(ang)*baseR, 0]; d.position=pos; return pos.slice();
      });
    } else if (mode==='traits'){
      const tk = pdata.tokenTraitKey||[]; const freq=new Map(); tk.forEach(k=>{ if (k>=0) freq.set(k,(freq.get(k)||0)+1); }); const keys=[...freq.keys()].sort((a,b)=>freq.get(a)-freq.get(b));
      const centers=new Map(); keys.forEach((k,i)=>{ const ang=(i/keys.length)*Math.PI*2; const rad=Math.min(cx,cy)*0.6; centers.set(k,[cx+Math.cos(ang)*rad*0.5, cy+Math.sin(ang)*rad*0.5, 0]); });
      // Place within each trait group using local rank and a Vogel spiral for even spread
      const byTrait = new Map(); nodes.forEach(n=>{ const k=tk[n.tokenId]; if(k>=0){ if(!byTrait.has(k)) byTrait.set(k,[]); byTrait.get(k).push(n);} });
      basePositions = nodes.map(d=>{
        const k = tk[d.tokenId]; const c = centers.get(k)||[cx,cy,0];
        const list = byTrait.get(k)||[]; const idx = Math.max(0, list.indexOf(d));
        const ang = (idx*2.3999632297) % (Math.PI*2);
        const r = Math.sqrt(idx+0.5) * 4;
        const pos=[c[0]+Math.cos(ang)*r, c[1]+Math.sin(ang)*r, 0]; d.position=pos; return pos.slice();
      });
    } else if (mode==='wallets'){
      // Wallets view uses owner aggregates in layers; no need to reposition token nodes here
      basePositions = nodes.map(d=>d.position.slice());
    } else if (mode==='transfers'){
      // Timeline layout: X=time, Y=price (log), with safe fallbacks when DB arrays are empty
      const tarrRaw = pdata.tokenLastActivity||[]; const parr = pdata.tokenLastSalePrice||[];
      const tvals = tarrRaw.filter(t=> typeof t==='number' && isFinite(t));
      const t0 = tvals.length ? Math.min(...tvals) : 0;
      const t1 = tvals.length ? Math.max(...tvals) : 1;
      timelineLimits = { t0, t1 };
      const lx = (t)=>{ if(!(t1>t0)) return cx; return (t - t0)/(t1 - t0) * (w-160) + 80; };
      const ly = (p)=>{ const v=Math.log1p(Math.max(0, p||0)); const vmax = Math.log1p(Math.max(1, Math.max(...(parr.filter(x=>x!=null && isFinite(x))), 1))); const y = (1 - v/(vmax||1))*(h-160) + 80; return y; };
      basePositions = nodes.map(d=>{ const t=tarrRaw[d.tokenId] ?? t0; const p=parr[d.tokenId] ?? 0; const pos=[lx(t), ly(p), 0]; d.position=pos; d.radius=3+(p?Math.min(6,Math.sqrt(p)):2); return pos.slice(); });
    } else {
      // Default grid
      const grid=100; nodes.forEach((d,i)=>{ d.position=[(i%grid)*20-1000, Math.floor(i/grid)*20-1000, 0]; }); basePositions = nodes.map(d=>d.position.slice());
    }
    hasFittedOnce = false; // trigger fit on next render
  }

  // colorFor removed in favor of nodeColor

  function render(nodes, edges, mode){
    const w = center.clientWidth||1200, h=center.clientHeight||800;
    if (SIMPLE_VIEW){
      const simple = buildSimpleLayers(mode);
      deckInst.setProps({ layers: simple });
      return;
    }
    const grid = makeGridLines(w, h, 50);
    const holdersHulls = (mode==='holders' && ui.bubbles) ? computeHulls(nodes, presetData) : [];
    // Zoom gates to reduce GPU work when zoomed out
    const showEdges = (mode==='holders' && ui.ownership && ui.ambient && (currentZoom==null || currentZoom>=0.4));
    const showOverlays = (currentZoom==null || currentZoom>=0.6);
    const showHulls = (currentZoom==null || currentZoom>=0.8);
    // Apply highlight filter dimming
    if (highlightSet && highlightSet.size){ nodes.forEach(n=>{ const on = highlightSet.has(n.id); const c=n.baseColor.slice(); c[3] = on? Math.max(160, c[3]||160) : 35; n.color=c; }); }
    else { nodes.forEach(n=> n.color = n.baseColor.slice()); }

    // Selection ring data (persistent after click)
    const selObj = selectedId>0 ? nodes.find(n=>n && n.id===selectedId) : null;

    let layers = [
      // Grid lines behind everything
      new LineLayer({ id:'grid', data:grid, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,25], getWidth:1, widthUnits:'pixels' }),
      // Ownership hull rings gated by zoom (soft fill + stroke)
      (showHulls && holdersHulls.length) && new PolygonLayer({ id:'hulls', data:holdersHulls, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPolygon:d=>d.path, stroked:true, filled:true, getFillColor:[0,255,102,10], getLineColor:[0,255,102,45], getLineWidth:1, lineWidthUnits:'pixels' }),
      // Fancy ownership multi-rings (top owners), also gated by zoom
      (showHulls && mode==='holders' && ui.bubbles) && new PolygonLayer({ id:'owner-rings', data: buildOwnerRings(), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, stroked:true, filled:false, getPolygon:d=>d.path, getLineColor:d=>d.color, getLineWidth:d=>d.width, lineWidthUnits:'pixels', parameters:{ depthTest:false }, updateTriggers:{ getLineColor: [pulseT] } }),
      // Ambient ownership edges
      showEdges && new LineLayer({ id:'edges', data:edges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>nodes[d.sourceIndex]?.position||[0,0,0], getTargetPosition:d=>nodes[d.targetIndex]?.position||[0,0,0], getColor:d=>d.color, getWidth:d=>d.width, widthUnits:'pixels', opacity:0.35 }),
      // Wash/desire overlays
      (showOverlays && ui.wash && washSet && washSet.size) && new ScatterplotLayer({ id:'wash', data:nodes.filter(n=>washSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(8, (d.radius||4)+6), getFillColor:[0,0,0,0], getLineColor:[255,0,102,220], lineWidthMinPixels:1.5, stroked:true, filled:false, radiusUnits:'pixels' }),
      (showOverlays && ui.desire && desireSet && desireSet.size) && new ScatterplotLayer({ id:'desire', data:nodes.filter(n=>desireSet.has(n.id)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(7, (d.radius||4)+4), getFillColor:[0,0,0,0], getLineColor:[255,215,0,200], lineWidthMinPixels:1, stroked:true, filled:false, radiusUnits:'pixels' }),
      new ScatterplotLayer({ id:'glow', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>d.radius*3.0, getFillColor:d=>[d.color[0],d.color[1],d.color[2], 12], radiusUnits:'pixels', parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
      // Neighbor edges on click
      (selectedId>0) && new LineLayer({ id:'click-edges', data: buildClickEdges(selectedId), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,180], getWidth:1.2, widthUnits:'pixels', parameters:{ depthTest:false } }),
      new ScatterplotLayer({ id:'nodes', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, highlightColor:[255,255,255,80], getPosition:d=>d.position, getRadius:d=>d.radius||4, getFillColor:d=>d.color, radiusUnits:'pixels', onClick: handleClick }),
      // Subtle pulse rings for recently active tokens
      (showOverlays) && new ScatterplotLayer({ id:'pulses', data: nodes.filter(n=>recentActive(n)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:false, stroked:true, filled:false, getPosition:d=>d.position, getRadius:d=> (d.radius||4) * (1.6 + 0.4*Math.sin(pulseT*2 + (d.id||0))), getLineColor:[0,255,102,140], lineWidthMinPixels:1, radiusUnits:'pixels', updateTriggers:{ getRadius: [pulseT] }, parameters:{ depthTest:false } }),
      (selObj) && new ScatterplotLayer({ id:'selection-ring', data:[selObj], coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(10,(d.radius||4)+8), getFillColor:[0,0,0,0], getLineColor:[0,255,102,220], lineWidthMinPixels:2, stroked:true, filled:false, radiusUnits:'pixels' })
    ];
    // View-specific adds
    try {
      if (mode==='holders') layers = makeHoldersLayers(layers);
      if (mode==='traits' && ui.traits) layers = makeTraitsLayers(layers);
      if (mode==='wallets') layers = makeWalletsLayers(layers);
      if (mode==='transfers') layers = makeTransfersLayers(layers);
      if (mode==='transfers' && timelineLimits){
        // Scanning line at current time
        const t0=timelineLimits.t0||0, t1=timelineLimits.t1||1; const w=center.clientWidth||1200; const h=center.clientHeight||800;
        const x = (timeline.value||t1); const px = (x - t0)/(t1 - t0) * (w-160) + 80;
        const scan = [{ s:[px,80,0], t:[px,h-80,0] }];
        layers.unshift(new LineLayer({ id:'scanline', data:scan, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,120], getWidth:1.5, widthUnits:'pixels', parameters:{ depthTest:false }, updateTriggers:{ data: [timeline.value] } }));
      }
      // Health/Activity view keys off select state while using holders data
      const ve = document.getElementById('view');
      if (ve && ve.value==='health' && mode==='holders') layers = makeActivityLayers(layers);
    } catch {}
    if (mode==='traits' && ui.traits){
      const paths = computeConstellationPaths(nodes, presetData);
      if (paths.length) layers.unshift(new LineLayer({ id:'trait-constellations', data:paths, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[255,215,0,160], getWidth:0.8, widthUnits:'pixels', opacity:0.6 }));
    }
    // LOD: stronger gating for heavy visuals
    const showEdges = currentZoom >= 0.5;
    const showFx = currentZoom >= 0.8;     // glow/pulses only when quite close
    const showDots = currentZoom >= 0.25;  // particles only when close
    if (!showEdges) layers = layers.filter(l=> l && l.id!=='edges');
    if (!showFx) layers = layers.filter(l=> l && l.id!=='glow' && l.id!=='pulses');
    if (currentMode==='transfers' && !showDots) layers = layers.filter(l=> l && l.id!=='flow-dots');
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

  // Health view: "Body tissue" cells (single layer prototype)
  function makeActivityLayers(base){
    try {
      // Body temperature heat (7x24) mapped to viewport
      let tempLayer = null;
      try {
        if (!heatmapCache) {
          // lazy load; do not block
          jfetch('/api/heatmap').then(j=>{ heatmapCache=j||{grid:[]}; render(nodes, edges, currentMode); });
        }
        const grid = (heatmapCache && heatmapCache.grid) ? heatmapCache.grid : [];
        if (Array.isArray(grid) && grid.length){
          const width = (center.clientWidth||1200), height=(center.clientHeight||800);
          const pad = 80; const x0=pad, x1=width-pad, y0=pad, y1=height-pad;
          const cols = 24, rows = 7;
          const pts = [];
          for (let r=0;r<rows;r++){
            for (let c=0;c<cols;c++){
              const cell = (grid[r] && grid[r][c]) ? grid[r][c] : { count:0, volume:0 };
              const x = x0 + (c+0.5)/cols * (x1-x0);
              const y = y0 + (r+0.5)/rows * (y1-y0);
              const w = Number(cell.count||0) + Number(cell.volume||0)*0.1;
              if (w>0) pts.push({ p:[x,y,0], w });
            }
          }
          if (pts.length && typeof HeatmapLayer==='function'){
            tempLayer = new HeatmapLayer({ id:'body-temp', data: pts, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.p, getWeight:d=>d.w, radiusPixels: 36, intensity: 0.7, threshold: 0.02, colorRange:[[0,0,0,0],[255,120,0,80],[255,0,0,160]] });
          }
        }
      } catch {}

      const now = Math.floor(Date.now()/1000);
      const last = presetData?.tokenLastActivity || [];
      const holds = presetData?.tokenHoldDays || [];
      const sales = presetData?.tokenSaleCount || [];
      // Downsample for perf but keep spatial coverage
      const N = Math.min(nodes.length, 3000);
      const step = Math.max(1, Math.floor(nodes.length / N));
      const data = [];
      for (let i=0, k=0; i<nodes.length && k<N; i+=step, k++){
        const n = nodes[i];
        const idx = n.tokenId | 0;
        const isFrozen = !!n.frozen;
        const isDorm = !!n.dormant;
        const daysSince = last[idx]? Math.max(0, (now - (last[idx]||0))/86400) : 999;
        const recency = Math.exp(-daysSince/30); // 1 recently, ->0 older
        const holdDays = Math.max(0, Number(holds[idx]||0));
        const saleScore = Math.min(1, Number(sales[idx]||0)/5);
        // Combine: healthy when active recently and not dormant/frozen; long-hold boosts mild
        let health = 0.6*recency + 0.25*saleScore + 0.15*Math.min(1, Math.sqrt(holdDays)/10);
        if (isDorm) health *= 0.6;
        if (isFrozen) health = -1; // dead zone
        const amp = health>0.5? 0.08 : (health>=0? 0.16 : 0);
        const baseR = 6 + Math.max(0, health)*10;
        let col;
        if (health<0){ col=[0,0,0,220]; }
        else if (health<0.3){ col=[255,0,102,180]; }
        else { col=[0,255,102,160]; }
        data.push({ c:[n.position[0], n.position[1], 0], r:baseR, amp, sick: health>0 && health<0.3, seed: (n.id%97)/97, col });
      }
      const cells = new PolygonLayer({
        id:'health-tissue',
        data,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        stroked:false,
        filled:true,
        getPolygon:d=>{ const seg=24; const out=[]; const t=pulseT; const jitter=d.sick? (Math.sin((t*3 + d.seed)*2)+Math.sin((t*1.7 + d.seed)*3))*0.5 : Math.sin(t*2 + d.seed); const scale= 1 + d.amp*jitter; const rr = d.r*scale; for(let k=0;k<seg;k++){ const ang=k/seg*Math.PI*2; out.push([ d.c[0]+Math.cos(ang)*rr, d.c[1]+Math.sin(ang)*rr, 0 ]); } return out; },
        getFillColor:d=>d.col,
        updateTriggers:{ getPolygon:[pulseT] },
        parameters:{ depthTest:false }
      });
      // Put temperature at very back, then tissue, then base
      return [ tempLayer, cells, ...base ].filter(Boolean);
    } catch { return base; }
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
      const r = await jfetch('/api/transfer-edges?limit=1000&nodes=10000');
      // Map representative tokens to node indices
      const mapIndex = new Map(); nodes.forEach((n,i)=>mapIndex.set(n.tokenId+1, i));
      return r.map(e=>({ a: mapIndex.get(e.a), b: mapIndex.get(e.b), count: e.count||1, type: (e.type||'transfer') })).filter(x=>x.a!=null && x.b!=null);
    } catch { return null; }
  }

  // UI loading bar helpers
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
    // Always try a basic thumbnail so demo mode still shows something
    if (thumb){ thumb.style.display='block'; thumb.onerror=()=>{ try{ thumb.style.display='none'; }catch{} }; thumb.src = `/thumbnails/${id}.jpg`; }
    try {
      const resp = await fetch(API.token(id)+'?v='+Date.now());
      let t = null;
      if (resp && resp.ok){
        try { t = await resp.json(); } catch { t = null; }
      }
      // If we have richer local paths from DB, prefer them
      try { if (t && (t.thumbnail_local || t.image_local) && thumb){ thumb.style.display='block'; thumb.src = `/${t.thumbnail_local||t.image_local}`; } } catch {}
      // Pull story + listings + wallet meta
      const [story, listings, walletMeta] = await Promise.all([
        jfetch(API.story(id)),
        jfetch(`/api/token/${id}/listings`),
        t.owner ? jfetch(`/api/wallet/${t.owner}/meta`) : null
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
        <div class='address'>${(t?.owner||'').slice(0,6)}...${(t?.owner||'').slice(-4)}</div>
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
      // HISTORY feed (compact) if story.events exists
      try {
        const feed = Array.isArray(story?.events) ? story.events.slice(0,10) : [];
        if (feed.length) {
          const items = feed.map(ev => {
            const ts = ev.timestamp ? new Date(ev.timestamp*1000).toISOString().slice(0,10) : '--';
            const txt = (ev.type||'EVENT').toString().toUpperCase();
            const price = (ev.price!=null) ? `${Math.round(ev.price*100)/100} TIA` : '--';
            return `<div class='label'>${ts} • ${txt}</div><div class='value'>${price}</div>`;
          }).join('');
          detailsEl.innerHTML += `<div class='section-label'>HISTORY</div><div class='traits-table'>${items}</div>`;
        }
      } catch {}
      render(nodes, edges, currentMode);
    } catch {
      // Minimal, no-DB fallback so the panel is still useful in demo mode
      try {
        detailsEl.innerHTML = `
          <div class='token-title'>MAMMOTH #${String(id).padStart(4,'0')}</div>
          <div class='section-label'>OWNER</div>
          <div class='address'>--</div>
          <div class='section-label'>TRAITS</div>
          <div class='traits-table'><div class='label'>No data</div><div class='value'>Demo mode</div></div>
        `;
      } catch { detailsEl.innerHTML='Select a node…'; }
    }
  }

  function timeAgo(ms){
    const s = Math.max(1, Math.floor((Date.now()-ms)/1000));
    const d = Math.floor(s/86400); if (d>=1) return `${d} day${d>1?'s':''}`; const h=Math.floor(s/3600); if (h>=1) return `${h} hour${h>1?'s':''}`; const m=Math.floor(s/60); if (m>=1) return `${m} min${m>1?'s':''}`; return `${s}s`;
  }

  // Helpers
  function getChecked(id, fallback){ try { const el=document.getElementById(id); if (!el) return !!fallback; return !!el.checked; } catch { return !!fallback; } }
  async function highlightWallet(address){
    try {
      const r = await jfetch(`/api/wallet/${address}`);
      const ids = new Set((r.tokens||[]).map(Number));
      highlightSet = ids; selectedId=-1; render(nodes,edges,currentMode);
    } catch { highlightSet=null; }
  }
  async function fetchWash(){ try { const r = await jfetch('/api/suspicious-trades'); const s=new Set((r?.tokens||[]).map(t=>Number(t.token_id||t.id))); return s; } catch { return null; } }
  async function fetchDesire(){ try { const r = await jfetch('/api/desire-paths'); const s=new Set((r?.desire_paths||[]).map(t=>Number(t.token_id||t.id))); return s; } catch { return null; } }
  function focusSelect(id){ const obj = nodes.find(n=>n.id===id); if (!obj) return; selectedId=id; // center roughly by resetting viewState target
    try {
      const vs = deckInst?.viewState || {};
      deckInst?.setProps?.({ viewState: { target: [obj.position[0], obj.position[1], 0], zoom: 1.8, transitionDuration: 400 } });
    } catch {}
    try { const se=document.getElementById('search'); if (se) se.value=''; } catch {}
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
      // Best-effort ENS fetch for top owners
      try { fetchTopOwnerLabels(pdata, counts, centers); } catch {}
      // Attach owner center + orbit params to nodes (for holders view)
      nodeList.forEach(n=>{
        const ownerIdx = n.ownerIndex; const c = centers[ownerIdx] || [0,0,0];
        const h = (counts[ownerIdx]||1);
        n.ownerX=c[0]; n.ownerY=c[1];
        n.orbit = (n.id%360) * Math.PI/180;
        n.orbitRadius = 28 + Math.sqrt(h)*8; // larger holdings → larger orbit ring
        // Recompute color now that owner metrics are available
        const nc = nodeColor(n); n.baseColor = nc.slice(); n.color = nc.slice();
      });
    } catch {}
  }

  async function fetchTopOwnerLabels(pdata, counts, centers){
    const owners = pdata?.owners || [];
    const ranked = owners.map((addr,i)=>({ addr:(addr||'').toLowerCase(), i, h: counts[i]||0, c: centers[i] })).filter(x=>x.c).sort((a,b)=>b.h-a.h).slice(0,40);
    for (const r of ranked){
      if (!r.addr || ownerLabels.has(r.addr)) continue;
      try {
        const meta = await jfetch(`/api/wallet/${r.addr}/meta`);
        const label = (meta?.ens_name && meta.ens_name.length>2) ? meta.ens_name : `${r.addr.slice(0,6)}...${r.addr.slice(-4)}`;
        ownerLabels.set(r.addr, label);
      } catch {}
    }
    if (currentMode==='holders') try { render(nodes, edges, currentMode); } catch {}
  }

  function makeHoldersLayers(base){
    try {
      // 0) Atmosphere: recent-activity heat haze (last 7 days only)
      const recent = nodes.filter(n=>{ const t=n.lastActivity||0; return t && (Date.now()/1000 - t) < 7*86400; }).map(n=>({ position:n.position, w:1 }));
      const heat = (recent.length && typeof HeatmapLayer==='function') ? new HeatmapLayer({ id:'activity-haze', data: recent, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getWeight:d=>d.w, radiusPixels: 28, intensity: 0.6, threshold: 0.03, colorRange:[[0,0,0,0],[0,128,51,80],[0,255,102,160]] }) : null;

      // 1) Density heat map using token positions weighted by owner trading volume (buy+sell)
      const buy = presetData?.ownerBuyVol || []; const sell = presetData?.ownerSellVol || [];
      const volPoints = nodes.map(n=>{ const oi=n.ownerIndex; const v=(buy[oi]||0)+(sell[oi]||0); return { position:n.position, w: Math.max(0, v) }; });
      const hexCls = HexagonLayer || ScreenGridLayer;
      const density = new hexCls({
        id: 'ownership-density',
        data: volPoints,
        getPosition: d => d.position,
        radius: 120,
        coverage: 0.7,
        elevationScale: 40,
        extruded: true,
        getColorWeight: d => d.w,
        getElevationWeight: d => d.w,
        colorRange: [[0,0,0,0],[0,255,102,80],[0,255,102,160]]
      });
      // 2) Owner cores (whale suns)
      const cores = (function(){ const out=[]; if(!ownerCenters) return out; for (let i=0;i<ownerCenters.length;i++){ const c=ownerCenters[i]; if(!c) continue; const h=ownerHoldings?.[i]||0; const size = 4 + Math.sqrt(h)*1.2; const addr=(presetData?.owners?.[i]||'').toLowerCase(); const lab=(ownerLabels.get(addr)) || (addr? addr.slice(0,6)+'...'+addr.slice(-4) : ''); out.push({ idx:i, position:c, size, label: lab }); } return out; })();
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
      // 5) Wallet trading highways between owners (curved arcs colored by type)
      let highways = null;
      try {
        if (Array.isArray(flowEdges) && flowEdges.length && ownerCenters && Array.isArray(presetData?.ownerIndex)){
          const ownerIdxArr = presetData.ownerIndex || [];
          const toSegs = flowEdges.slice(0,800).map(e=>{
            const ta = Number(e.a), tb = Number(e.b);
            const oiA = ownerIdxArr[(ta-1)|0];
            const oiB = ownerIdxArr[(tb-1)|0];
            const sa = ownerCenters?.[oiA]; const sb = ownerCenters?.[oiB];
            if (!sa || !sb) return null;
            const w = 0.6 + Math.min(2.4, Math.sqrt(e.count||1));
            const c = (e.type==='mint') ? [0,215,255,180] : (e.type==='sale') ? [255,215,0,180] : [0,255,102,160];
            return { s: sa, t: sb, w, c };
          }).filter(Boolean);
          highways = new ArcLayer({ id:'wallet-highways', data: toSegs, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getSourceColor:d=>d.c, getTargetColor:[0,0,0,0], getWidth:d=>d.w, widthUnits:'pixels' });
        }
      } catch {}

      // 6) Whale identification beacons (TextLayer markers) for known whale types
      const types = presetData?.ownerWalletType || [];
      const whales = []; for (let i=0;i<(ownerCenters?.length||0);i++){ const t=String(types[i]||'').toLowerCase(); if (t==='whale_trader' || t==='diamond_hands'){ const sym = t==='whale_trader' ? '⚡' : '◆'; const vol=(buy[i]||0)+(sell[i]||0); const pos=ownerCenters[i]; if (pos) whales.push({ position:[pos[0], pos[1]-28, 0], text:sym, size: Math.min(24, 10+Math.sqrt(Math.max(1,vol))) }); } }
      const beacons = new TextLayer({ id:'whale-beacons', data: whales, getPosition:d=>d.position, getText:d=>d.text, getSize:d=>d.size, getColor:[0,255,102,220], billboard:true, fontFamily:'IBM Plex Mono', outlineColor:[0,0,0,200], outlineWidth:2 });

      // Gating by toggles
      const showOwn = getChecked('layer-ownership', true);
      const showBub = getChecked('layer-bubbles', true);
      const out = [ heat, density ];
      if (showOwn && highways) out.push(highways);
      out.push(coreLayer, coreLabels, tokens);
      if (showOwn && arcs) out.push(arcs);
      out.push(beacons);
      return [ ...out.filter(Boolean), ...base.filter(Boolean) ];
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
    // Place tokens inside cluster (already improved layout elsewhere)
    nodes.forEach(n=>{ const k=tk[n.tokenId]; const c = clusterPos.get(k) || [0,0,0]; const z=(n.rarity||0)*50; n.position = [ c[0] + ((n.tokenId%20)-10)*12, c[1] + (Math.floor(n.tokenId/20)%10 -5)*12, z]; n.radius = (n.rarity>0.9)?8:4; });

    // Galaxy background: approximate Voronoi territories using soft circles sized inversely to frequency
    const freq = new Map(); keys.forEach(k=>{ freq.set(k, (groups.get(k)||[]).length); });
    const territoriesData = keys.map(k=>{ const c = clusterPos.get(k)||[0,0,0]; const f = freq.get(k)||1; const r = Math.max(40, Math.min(240, 200/Math.sqrt(f))); const rare = f<10; const col = rare? [255,215,0,60] : [0,255,102,30]; return { center:c, r, col }; });
    const territories = new PolygonLayer({ id:'trait-territories', data: territoriesData, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPolygon:d=> circlePath(d.center[0], d.center[1], d.r, 40), stroked:false, filled:true, getFillColor:d=>d.col, parameters:{ depthTest:false } });

    // Points layer
    const points = (typeof PointCloudLayer==='function') ? new PointCloudLayer({ id:'trait-clusters', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getNormal:[0,0,1], getColor:d=> d.rarity>0.95 ? [255,0,255,220] : d.color, pointSize:3, material:{ ambient:0.5, diffuse:1, shininess:30, specularColor:[0,255,102] }, pickable:true, onClick:handleClick }) : new ScatterplotLayer({ id:'trait-clusters', data:nodes, getPosition:d=>[d.position[0],d.position[1],0], getRadius:d=>d.radius, getFillColor:d=> d.rarity>0.95 ? [255,0,255,200] : d.color, radiusUnits:'pixels', pickable:true, onClick:handleClick });

    // Constellation lines within each trait family (by trait type)
    const byType = new Map();
    keys.forEach(k=>{ const key = String(traitKeys[k]||''); const i = key.indexOf(':'); const type = i>0? key.slice(0,i) : key; if(!byType.has(type)) byType.set(type, []); byType.get(type).push(k); });
    const famLines = [];
    for (const [type, arr] of byType.entries()){
      const centers = arr.map(k=>({ k, p: clusterPos.get(k)||[0,0,0], f: freq.get(k)||1 }));
      if (centers.length<3) continue;
      // sort around centroid
      let sx=0,sy=0; centers.forEach(o=>{ sx+=o.p[0]; sy+=o.p[1]; }); const cx=sx/centers.length, cy=sy/centers.length;
      centers.sort((a,b)=> Math.atan2(a.p[1]-cy,a.p[0]-cx) - Math.atan2(b.p[1]-cy,b.p[0]-cx));
      for (let i=0;i<centers.length;i++){ const a=centers[i].p; const b=centers[(i+1)%centers.length].p; famLines.push({ s:a, t:b }); }
    }
    const family = new LineLayer({ id:'trait-families', data:famLines, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,80], getWidth:0.8, widthUnits:'pixels' });

    // DNA strands: similarity connections between rare tokens (fetch-once cache)
    const byId = new Map(nodes.map(n=>[n.id, n]));
    const dnaSegs = [];
    try {
      // sample rare tokens from rare groups (freq<10)
      const rareGroups = keys.filter(k=> (freq.get(k)||0) < 10).slice(0, 20);
      const sample = [];
      for (const k of rareGroups){ const list = (groups.get(k)||[]); for (let i=0;i<Math.min(4, list.length); i++){ sample.push(list[i]); } }
      for (const n of sample){
        if (!dnaCache.has(n.id)){
          jfetch(`/api/token/${n.id}/similar-advanced`).then(j=>{ if (j && Array.isArray(j.similar)) dnaCache.set(n.id, j.similar); });
        }
        const sims = dnaCache.get(n.id) || [];
        for (const s of sims){ const other = byId.get(Number(s.token_id)); if (!other) continue; const a=n.position, b=other.position; const sim=Number(s.similarity)||0.6; const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2 - 20; const path=[a, [mx,my,0], b]; const col=[255,215,0, Math.round(80+sim*120)]; const w= 0.5 + sim*2.0; dnaSegs.push({ path, col, w }); }
      }
    } catch {}
    const dna = (dnaSegs.length && typeof PathLayer==='function') ? new PathLayer({ id:'dna-strands', data: dnaSegs, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPath:d=>d.path, getColor:d=>d.col, getWidth:d=>d.w, widthUnits:'pixels', parameters:{ depthTest:false } }) : null;
    // Particles flowing along DNA (animated)
    const dnaDots = (dnaSegs.length) ? new ScatterplotLayer({ id:'dna-dots', data: dnaSegs.slice(0,200).map((d,i)=>({ d, i })), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:o=>{ const t=( (pulseT*0.3 + (o.i%10)/10) % 1 ); const a=o.d.path[0], m=o.d.path[1], b=o.d.path[2]; const x=(1-t)*(1-t)*a[0] + 2*(1-t)*t*m[0] + t*t*b[0]; const y=(1-t)*(1-t)*a[1] + 2*(1-t)*t*m[1] + t*t*b[1]; return [x,y,0]; }, getRadius:1.8, getFillColor:[255,215,0,200], radiusUnits:'pixels', pickable:false, updateTriggers:{ getPosition:[pulseT] }, parameters:{ depthTest:false } }) : null;

    // Labels: show only when sufficiently zoomed
    const labelsData = (currentZoom>=0.2) ? keys.map(k=>({ k, center: clusterPos.get(k)||[0,0,0] })) : [];
    const labels = new TextLayer({ id:'trait-labels', data: labelsData, getPosition:d=>d.center, getText:d=> traitKeys[d.k]||('Trait '+d.k), getSize:14, getColor:[0,255,102,200], fontFamily:'IBM Plex Mono', getPixelOffset:[0,-20] });

    // Rare particle sparkles
    const rare = new ScatterplotLayer({ id:'rare-spark', data: nodes.filter(n=> (n.rarity||0)>0.95), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius: d=> 2 + 1.2*Math.max(0, Math.sin(pulseT*3 + (d.id||0)*0.3)), getFillColor:[255,0,255,220], radiusUnits:'pixels', pickable:false, updateTriggers:{ getRadius: [pulseT] } });
    return [ territories, family, dna, dnaDots, rare, points, ...base ];
  }

  function helixPath(list){
    if (!list || list.length<3) return [];
    const c = list.reduce((acc,n)=>{acc[0]+=n.position[0];acc[1]+=n.position[1];return acc;},[0,0]); c[0]/=list.length; c[1]/=list.length;
    const ordered = list.map(n=>({n, ang:Math.atan2(n.position[1]-c[1], n.position[0]-c[0])})).sort((a,b)=>a.ang-b.ang).map(o=>o.n);
    const path=[]; for (let i=0;i<ordered.length;i++){ const a=ordered[i].position; const b=ordered[(i+1)%ordered.length].position; const mid=[(a[0]+b[0])/2, (a[1]+b[1])/2, 0]; path.push(a, mid, b); }
    return path;
  }

  function makeWalletsLayers(base){
    // Build ocean positions: X by volume, Y by avg hold days
    const ownersArr = presetData?.owners || [];
    const buy = presetData?.ownerBuyVol || []; const sell = presetData?.ownerSellVol || [];
    const avgHold = presetData?.ownerAvgHoldDays || [];
    const type = presetData?.ownerWalletType || [];
    const holdings = ownerHoldings || [];
    const width = (center.clientWidth||1200), height=(center.clientHeight||800); const padX=100, padY=100;
    const x0=padX, x1=width-padX, y0=padY, y1=height-padY;
    const vols = ownersArr.map((_,i)=> (buy[i]||0)+(sell[i]||0));
    const maxVol = Math.max(1, ...vols);
    const maxHold = Math.max(1, ...avgHold.filter(v=>v!=null).map(Number));
    ownerOceanPos = new Array(ownersArr.length);
    for (let i=0;i<ownersArr.length;i++){
      const v = Math.max(0, vols[i]||0) / maxVol;
      const h = Math.max(0, Math.min(1, Number(avgHold[i]||0)/maxHold));
      const x = x0 + v*(x1-x0);
      const y = y0 + (1-h)*(y1-y0); // deep holders lower (larger y)
      ownerOceanPos[i] = [x,y,0];
    }

    const owners = ownersArr.map((addr,i)=>({ address: addr, position: ownerOceanPos[i]||[0,0,0], vol: vols[i]||0, avgHold: avgHold[i]||0, holdings: holdings[i]||0, type: (type[i]||'').toString().toLowerCase() }));
    const ranked = owners.slice().sort((a,b)=> (b.holdings - a.holdings)).slice(0,12);

    // Ocean depth bands (thermoclines)
    const bandsData = [];
    const bands = 4; for (let k=0;k<bands;k++){ const yTop = y0 + k*(y1-y0)/bands; const yBot = y0 + (k+1)*(y1-y0)/bands; const alpha = 20 + k*10; bandsData.push({ poly: [[x0,yTop,0],[x1,yTop,0],[x1,yBot,0],[x0,yBot,0]], col:[0,100,80, alpha] }); }
    const bandsL = new PolygonLayer({ id:'ocean-bands', data: bandsData, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPolygon:d=>d.poly, stroked:false, filled:true, getFillColor:d=>d.col, parameters:{ depthTest:false } });

    // Ocean currents: wallet relationships
    if (!whalesRelationships){ try { whalesRelationships = jfetch('/api/wallet-relationships?min_trades=3'); } catch {} }
    let currentL = null;
    try {
      // Resolve async cache to concrete rows if it’s a promise and ready
      if (whalesRelationships && typeof whalesRelationships.then==='function'){
        whalesRelationships = null; // avoid double awaiting during layer construction
        // lazy background load
        jfetch('/api/wallet-relationships?min_trades=3').then(j=>{ whalesRelationships = j||{relationships:[]}; render(nodes, edges, currentMode); });
      }
      const data = (whalesRelationships && whalesRelationships.relationships) ? whalesRelationships.relationships : [];
      const map = new Map(ownersArr.map((a,i)=>[(a||'').toLowerCase(), i]));
      const paths = [];
      for (const r of data){
        const a = map.get((r.wallet_a||r.walletA||'').toLowerCase());
        const b = map.get((r.wallet_b||r.walletB||'').toLowerCase());
        if (a==null || b==null) continue; const pa=ownerOceanPos[a], pb=ownerOceanPos[b]; if (!pa||!pb) continue;
        const vol = Number(r.total_volume||r.volume||r.trade_volume||0); const cnt = Number(r.trade_count||r.count||1);
        const mx=(pa[0]+pb[0])/2, my=(pa[1]+pb[1])/2 + 30; const path=[pa, [mx,my,0], pb];
        const w= 0.5 + Math.min(3, Math.log1p(vol || cnt));
        const c=[0,180,200,120];
        paths.push({ path, w, c });
      }
      if (paths.length) currentL = new PathLayer({ id:'ocean-currents', data: paths, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPath:d=>d.path, getColor:d=>d.c, getWidth:d=>d.w, widthUnits:'pixels' });
    } catch {}

    // Sea creatures using Remix Icon via IconLayer (no emoji)
    function iconFor(t){
      const base = 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/icons';
      if (t==='whale_trader') return { url: base + '/animal/whale-line.svg', width:512, height:512, anchorY:256 };
      if (t==='diamond_hands') return { url: base + '/finance/vip-diamond-line.svg', width:512, height:512, anchorY:256 };
      if (t==='flipper') return { url: base + '/animal/fish-line.svg', width:512, height:512, anchorY:256 };
      return { url: base + '/animal/turtle-line.svg', width:512, height:512, anchorY:256 };
    }
    const creatures = new IconLayer({ id:'sea-creatures', data: owners, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getIcon:d=>iconFor(d.type), getSize:d=> 24 + Math.min(28, Math.sqrt(Math.max(1,d.holdings))*2), sizeUnits:'pixels', getColor:[0,255,102,220] });

    // Sonar pulses: light ripples on top whales
    const pulses = new ScatterplotLayer({ id:'sonar-pulses', data: ranked.map((o,i)=>({ p:o.position, i })), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:false, getPosition:d=>d.p, getRadius:d=> 12 + 10*(0.5+0.5*Math.sin(pulseT*2 + d.i)), getFillColor:[0,255,102,30], radiusUnits:'pixels' });

    // Scatter nodes for owners (dots beneath creatures for interaction)
    const nodesL = new ScatterplotLayer({ id:'wallet-dots', data: owners, pickable:true, autoHighlight:true, onClick: async (info)=>{ if(info?.object){ await openWallet(info.object.address);} }, getPosition:d=>d.position, getRadius:d=> 3 + Math.sqrt(Math.max(1,d.holdings))*1.2, getFillColor:[0,255,102,120], radiusUnits:'pixels' });

    return [ bandsL, currentL, nodesL, creatures, pulses, ...base.filter(Boolean) ];
  }

  async function openWallet(addr){
    await highlightWallet(addr);
    try {
      const meta = await jfetch(`/api/wallet/${addr}/meta`);
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
    const r = await jfetch(`/api/traits?v=${Date.now()}`);
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
      const r = await jfetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);
      const ids = new Set((r.tokens||[]).map(Number));
      highlightSet = ids;
      render(nodes, edges, currentMode);

      // Trait summary → sidebar (floor + examples) using preset arrays already loaded
      const prices = (presetData?.tokenPrice||[]);
      let floor = null, count = 0;
      const samples = [];
      ids.forEach(id => {
        const idx = (id-1)|0; const p = prices[idx];
        if (p!=null) floor = (floor==null)? p : Math.min(floor, p);
        if (count < 12) samples.push(id);
        count++;
      });
      const detailsEl = document.getElementById('details');
      const thumbs = samples.map(id=>`<img src="/thumbnails/${id}.jpg" alt="${id}" style="width:48px;height:48px;object-fit:cover;margin:2px;border:1px solid rgba(0,255,102,.2)">`).join('');
      if (detailsEl){
        detailsEl.innerHTML = `
          <div class='token-title'>${type.toUpperCase()}: ${value}</div>
          <div class='card2'>
            <div class='card'><div class='label'>COUNT</div><div class='big-number'>${count}</div></div>
            <div class='card'><div class='label'>FLOOR</div><div class='big-number'>${floor!=null? (Math.round(floor*100)/100 + ' TIA'):'--'}</div></div>
          </div>
          <div class='section-label'>EXAMPLES</div>
          <div class='traits-table' style="display:flex;flex-wrap:wrap">${thumbs || '<div class="label">--</div><div class="value">--</div>'}</div>`;
      }
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
    deckInst.setProps({ viewState: { target:[cx,cy,0], zoom } });
  }

  // Transfers view helpers
  function makeTransfersLayers(base){
    const add = [];
    if (flowEdges && flowEdges.length){
      const showSales = getChecked('layer-sales', true);
      const showTransfers = getChecked('layer-transfers', true);
      const showMints = getChecked('layer-mints', true);
      const segs = flowEdges.slice(0,800).map(e=>{
        const s = nodes[e.a]?.position, t = nodes[e.b]?.position; if (!s||!t) return null;
        const w = 0.6 + Math.min(2.4, Math.sqrt(e.count||1));
        const type = (e.type||'transfer');
        if (type==='sale' && !showSales) return null;
        if (type==='mint' && !showMints) return null;
        if (type==='transfer' && !showTransfers) return null;
        const c = (type==='sale') ? [255,0,102,180] : (type==='mint') ? [255,255,255,160] : [0,160,255,160];
        return { s, t, w, c };
      }).filter(Boolean);
      add.push(new LineLayer({ id:'transfer-highways', data:segs, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:d=>d.c, getWidth:d=>d.w, widthUnits:'pixels' }));
    }
    // Terrain: price contours (topography) using token last-sale data (CPU-safe)
    try {
      const t0 = timeline.start || (timelineLimits?.t0||0); const t1 = timeline.end || (timelineLimits?.t1||t0+1); const dt = (t1-t0)||1;
      const width = (center.clientWidth||1200), height=(center.clientHeight||800);
      const xs = (ts)=> (ts - t0)/dt * (width-160) + 80;
      const parr = presetData?.tokenLastSalePrice || presetData?.tokenPrice || [];
      const tsarr = presetData?.tokenLastSaleTs || presetData?.tokenLastActivity || [];
      const pts = [];
      for (let i=0;i<parr.length;i++){
        const p = parr[i]; const ts = tsarr[i]; if (p==null || !ts) continue;
        const y = (Math.log1p(Math.max(0,p)) / Math.log1p(Math.max(1, Math.max(...parr.filter(v=>v!=null)))) ) * (height-160) + 80;
        pts.push([ xs(ts), y ]);
      }
      if (typeof ContourLayer==='function' && pts.length>50){
        const thresholds = 10;
        add.push(new ContourLayer({ id:'price-contours', data: pts.map(p=>({position:[p[0],p[1],0]})), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, cellSize: 40, thresholds, gpuAggregation:false, contours: [{threshold:1, strokeWidth:1, strokeColor:[0,255,102,80]}]}));
      }
    } catch {}

    // Rapids: hour activity as grid (height=volume) with GPU->CPU fallback
    try {
      if (transfersCache && transfersCache.length){
        const t0 = timeline.start || (timelineLimits?.t0||0); const t1 = timeline.end || (timelineLimits?.t1||t0+1); const dt=(t1-t0)||1;
        const width = (center.clientWidth||1200), height=(center.clientHeight||800);
        const xs = (ts)=> (ts - t0)/dt * (width-160) + 80;
        const pts = transfersCache.map(tr=>({ position:[ xs(tr.timestamp||t0), (Math.log1p(Math.max(0,tr.price||0)))*200, 0 ], w: 1 }));
        if (typeof GPUGridLayer==='function'){
          add.push(new GPUGridLayer({ id:'activity-rapids', data: pts, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getWeight:d=>d.w, cellSizePixels: 28, extruded:true, elevationScale: 8, pickable:false, colorAggregation:'SUM', getColorValue: v=>v, colorRange:[[0,0,0,0],[255,255,255,180]] }));
        } else if (typeof ScreenGridLayer==='function'){
          add.push(new ScreenGridLayer({ id:'activity-rapids', data: pts, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getWeight:d=>d.w, cellSizePixels: 28, opacity:0.3, colorRange:[[0,0,0,0],[255,255,255,180]] }));
        }
      }
    } catch {}

    // Avoid wallet-positioned flows; use timeline-plane particles
    try {
      const showTrades = getChecked('layer-trades', true);
      if (showTrades){
        const dots = buildFlowParticles(800);
        if (dots && dots.length) add.unshift(new ScatterplotLayer({ id:'flow-dots', data:dots, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.p, getRadius:d=> 2.0 + Math.min(4, Math.sqrt(d.price||0)), getFillColor:[0,255,102,140], radiusUnits:'pixels', pickable:false, updateTriggers:{ getPosition:[pulseT] } }));
      }
    } catch {}
    // Trips layer (if available)
    try { const TripsLayer = (window.deck && (window.deck.TripsLayer || window.deck?.GeoLayers?.TripsLayer)) || window.TripsLayer || null; if (TripsLayer){ add.unshift(makeTripsLayer()); } } catch {}
    // Keep a light heat overlay if desired (retained but lower priority)
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
        const r = await jfetch('/api/transfers?limit=3000') || {transfers:[]};
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
    // Make edge-groups and traits collapsible (pure CSS class toggle)
    try {
      document.querySelectorAll('.edge-group').forEach(g=>{
        const h = g.querySelector('.edge-group-header');
        if (!h || h.dataset.bound) return; h.dataset.bound='1';
        const toggle = ()=>{ const open = !g.classList.contains('open'); g.classList.toggle('open', open); h.setAttribute('aria-expanded', open?'true':'false'); };
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' '){ e.preventDefault(); toggle(); } });
      });
      const th = document.querySelector('.traits-header');
      const ts = document.querySelector('.traits-section');
      if (th && ts && !th.dataset.bound){ th.dataset.bound='1'; const toggle=()=>{ const open=!ts.classList.contains('open'); ts.classList.toggle('open', open); th.setAttribute('aria-expanded', open?'true':'false'); }; th.addEventListener('click', toggle); th.addEventListener('keydown', (e)=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } }); }
    } catch {}
