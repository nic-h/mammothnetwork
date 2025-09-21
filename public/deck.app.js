// Deck.gl engine mounted into the center panel while keeping left/right UI
// Load with ?engine=deck or localStorage.engine='deck'
if (!window.deck) {
  console.error('deck.app.js: window.deck missing; aborting init');
  throw new Error('Deck UMD not loaded');
}
console.log('deck.app: boot');
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
  const effectiveMode = (mode) => (mode === 'health' ? 'holders' : mode);

  // Deck palette mirrors public/client/styles/tokens.css so the canvas matches the UI
  const TOKENS = {
    fg: [0, 255, 102],            // --fg
    fgDim: [0, 204, 0],           // --fg-dim
    fgBright: [51, 255, 102],     // --fg-bright (#33ff66)
    blue: [68, 136, 255],         // --blue (#4488ff)
    gray: [102, 102, 102]         // --gray (#666666)
  };

  const COLORS = {
    active: [...TOKENS.fg, 190],
    whale: [...TOKENS.fgBright, 220],
    frozen: [...TOKENS.blue, 210],
    dormant: [...TOKENS.gray, 170]
  };

  function nodeColor(d){
    try {
      const types = presetData?.ownerWalletType || [];
      const t = Array.isArray(types) ? types[d.ownerIndex] : null;
      const isWhale = t === 'whale_trader' || t === 'whale';
      const isFrozen = !!d.frozen;
      const now = Math.floor(Date.now()/1000);
      const daysSince = d.lastActivity ? (now - d.lastActivity)/86400 : Infinity;
      const isDormant = !isFrozen && (d.dormant || daysSince >= 90);
      if (isWhale) return COLORS.whale.slice();
      if (isFrozen) return COLORS.frozen.slice();
      if (isDormant) return COLORS.dormant.slice();
      return COLORS.active.slice();
    } catch {
      return COLORS.active.slice();
    }
  }

const center = document.querySelector('.center-panel');
  if (!center) { console.error('deck.app: .center-panel not found'); }
  const stage = document.getElementById('stage');
  if (stage) stage.style.display = 'none';
  if (!center) return;

  const {Deck, ScatterplotLayer, LineLayer, TextLayer, PolygonLayer, ArcLayer, ScreenGridLayer, HexagonLayer, HeatmapLayer, PathLayer, PointCloudLayer, GPUGridLayer, ContourLayer, OrthographicView, COORDINATE_SYSTEM, BrushingExtension} = window.deck || {};
  if (!Deck) { console.error('Deck.gl UMD not found'); return; }

  const API = {
    graph: '/api/graph',
    preset: '/api/preset-data',
    token: id => `/api/token/${id}`,
    story: id => `/api/token/${id}/story`
  };

  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  // Canvas for deck (ensure non-zero backing store)
  const canvas = document.createElement('canvas');
  canvas.id = 'deck-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  try { center.appendChild(canvas); console.log('deck.app: canvas appended'); } catch(e){ console.error('deck.app: append canvas failed', e?.message||e); }

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
  let edgeCount = 200; // default UI slider value
  let ownerCenters = null; // computed per owner (holders view)
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
  // Activity caches for rhythm view (interval -> buckets)
  const rhythmActivity = new Map();
  const rhythmActivityPending = new Map();
  let heatmapLoading = false;
  // Binary attribute backing store for node positions (auto-resized per render)
  let positionAttribute = null;

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
  };

  const SIMPLE_VIEW_CONFIG = {
    dots: {
      baseMode: 'holders',
      modeSelect: 'holders',
      toggles: {
        'layer-ownership': true,
        'layer-transfers': false,
        'layer-sales': false,
        'layer-trades': false
      }
    },
    flow: {
      baseMode: 'holders',
      modeSelect: 'holders',
      toggles: {
        'layer-ownership': true,
        'layer-transfers': true,
        'layer-sales': true,
        'layer-trades': true
      }
    },
    tree: {
      baseMode: 'wallets',
      modeSelect: 'wallets',
      toggles: {
        'layer-ownership': true,
        'layer-transfers': false,
        'layer-sales': false,
        'layer-trades': false
      }
    },
    rhythm: {
      baseMode: 'transfers',
      modeSelect: 'transfers',
      toggles: {
        'layer-ownership': true,
        'layer-transfers': true,
        'layer-sales': true,
        'layer-trades': true
      }
    }
  };
  const SIMPLE_VIEW_NAMES = new Set(Object.keys(SIMPLE_VIEW_CONFIG));
  let currentSimpleView = null;

  // Minimal hover handler to avoid runtime errors in simple views
  function onHoverThrottled(info){ /* no-op; selection handled onClick */ }

  // Resize: let Deck handle DPR; only trigger a props update
  try { new ResizeObserver(()=>{ deckInst?.setProps?.({}); }).observe(center); } catch {}

  init().catch(console.error);

  async function init(){
    startUILoad();
    presetData = await jfetch(API.preset) || null;
    let __firstDrawn = false;
    try { window.__mammothDrawnFrame = false; } catch {}
    deckInst = new Deck({
      canvas: 'deck-canvas',
      controller: true,
      useDevicePixels: true,
      pickingRadius: 6,
      views:[ new (OrthographicView||window.deck.OrthographicView)({ id:'ortho' }) ],
      initialViewState:{ target:[0,0,0], zoom:0 },
      onViewStateChange: ({viewState}) => { currentZoom = viewState.zoom; },
      onAfterRender: () => {
        if (!__firstDrawn && Array.isArray(nodes) && nodes.length > 0) {
          __firstDrawn = true;
          try { window.__mammothDrawnFrame = true; } catch {}
        }
      }
    });
    try { window.deckInst = deckInst; } catch {}
    // no DPR clamps; Deck manages device pixels
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
        if (SIMPLE_VIEW_NAMES.has(v)) { await applySimpleView(v); return; }
        currentSimpleView = null;
        if (v==='ownership') await loadMode('holders', edgeCount);
        else if (v==='trading') await loadMode('transfers', edgeCount);
        else if (v==='traits') await loadMode('traits', edgeCount);
        else if (v==='whales') await loadMode('wallets', edgeCount);
        else if (v==='health') await loadMode('health', edgeCount);
      });
    }
    // Mode select (fallback)
    const modeEl = document.getElementById('mode');
    if (modeEl && !modeEl.dataset.deckBound){
      modeEl.dataset.deckBound='1';
      modeEl.addEventListener('change', ()=>{
        currentSimpleView = null;
        loadMode(modeEl.value||'holders', edgeCount);
      });
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
          if (effectiveMode(currentMode)==='transfers') render(nodes, edges, effectiveMode(currentMode));
          updateLabel();
        }
      });
      timeEl.addEventListener('change', ()=>{ timeline.playing = true; });
      setInterval(()=>{
        if (!timeline.playing || timeline.start==null || timeline.end==null) return;
        const p = ((parseInt(timeEl.value||'0',10)+1)%101);
        timeEl.value = String(p);
        const frac=p/100; timeline.value = Math.round(timeline.start + (timeline.end - timeline.start)*frac);
        if (effectiveMode(currentMode)==='transfers') render(nodes, edges, effectiveMode(currentMode));
        updateLabel();
      }, 2000);
    }
    // Layer toggles -> re-render
    const ids = ['ambient-edges','layer-ownership','layer-traits','layer-trades','layer-sales','layer-transfers','layer-mints','layer-bubbles'];
    ids.forEach(id=>{ const el=document.getElementById(id); if (el && !el.dataset.deckBound){ el.dataset.deckBound='1'; el.addEventListener('change', async ()=>{
      render(nodes, edges, effectiveMode(currentMode));
    }); }});
    // Search behavior
    const searchEl = document.getElementById('search');
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
    const graphMode = effectiveMode(mode);
    const usp = new URLSearchParams(location.search);
    const full = usp.has('full');
    const forceReload = usp.has('force');
    const params = new URLSearchParams({ mode: graphMode, nodes:'10000', edges: full ? '5000' : String(edgesWanted ?? edgeCount) });
    if (forceReload) params.set('force', '1');
    startUILoad();
    const graph = await jfetch(`${API.graph}?${params}`) || {nodes:[],edges:[]};
    const pdata = presetData || {};
    nodes = buildNodes(graph.nodes||[], pdata);
    try { window.__mammothNodes = nodes.slice(0, 50); } catch {}
    if (!nodes || nodes.length===0){ stopUILoad(); console.warn('API returned zero nodes'); return; }
    edges = buildEdges(graph.edges||[], nodes);
    computeOwnerMetrics(pdata, nodes);
    applyLayout(nodes, graphMode, pdata);
    try { relaxWithinOwners(nodes, ownerHoldings, 2, 6); } catch {}
    // lazy fetch flow/activity data
    if ((graphMode==='transfers' || graphMode==='holders') && !flowEdges) flowEdges = await fetchFlowEdges(nodes).catch(()=>null);
    // Pull raw transfers for particles if we don't have them yet; also seed the timeline
    if (graphMode==='transfers' && !transfersCache){
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
    if (graphMode==='holders' || graphMode==='frozen'){ if (!activityBuckets) activityBuckets = await jfetch('/api/activity') || null; }
    render(nodes, edges, graphMode);
    // (re)start tiny animation for holders and traits if applicable
    if (animReq) cancelAnimationFrame(animReq);
    const start = performance.now? performance.now(): Date.now();
    const tick = ()=>{
      const now = (performance.now? performance.now(): Date.now());
      const t = (now - start)/1000;
      pulseT = t; // global pulse time
      const activeMode = effectiveMode(currentMode);
      if (activeMode==='holders') animateHolders(t);
      else if (activeMode==='traits') animateTraits(t);
      else if (activeMode==='transfers') { if (timeline.playing) render(nodes, edges, activeMode); }
      animReq = requestAnimationFrame(tick);
    };
    animReq = requestAnimationFrame(tick);
    stopUILoad();
  }

  // Expose tiny control API for automated tests/screenshots
  try {
    window.mammoths = {
      focusToken: (id)=>{ try { focusSelect(Number(id)); } catch {} },
      setSimpleView: (name)=>{ try { return applySimpleView(name); } catch {} }
    };
  } catch {}

  function buildNodes(apiNodes, pdata){
    const ownerIndex = pdata.ownerIndex||[];
    const ownerEthos = pdata.ownerEthos||[];
    const tokenLastActivity = pdata.tokenLastActivity||[];
    const tokenPrice = pdata.tokenPrice||[];
    const rarity = pdata.rarity||[];
    const tokenLastSalePrice = pdata.tokenLastSalePrice || [];
    const tokenSaleCount = pdata.tokenSaleCount || [];
    const tokenLastSaleTs = pdata.tokenLastSaleTs || [];
    return apiNodes.map((n,i)=>{
      const idx = (n.id-1>=0)?(n.id-1):i;
      const rawOi = ownerIndex[idx];
      // Fallback grouping when DB ownerIndex is missing: spread into 12 clusters
      const oi = (rawOi!=null && rawOi>=0) ? rawOi : (i % 12);
      const ethos=oi>=0?(ownerEthos[oi]||0):0;
      const baseColor = COLORS.active.slice();
      const lastSalePrice = Number.isFinite(tokenLastSalePrice[idx]) ? tokenLastSalePrice[idx] : (tokenPrice[idx]||0);
      return {
        id: n.id, tokenId: idx,
        position: [0,0,0],
        ownerIndex: oi,
        lastActivity: tokenLastActivity[idx]||0,
        price: tokenPrice[idx]||0,
        lastSalePrice,
        lastSaleTs: tokenLastSaleTs[idx]||0,
        saleCount: tokenSaleCount[idx]||0,
        rarity: rarity[idx]||0.5,
        frozen: !!n.frozen,
        dormant: !!n.dormant,
        color: baseColor.slice(),
        baseColor,
        radius: 2,
      };
    }).map(d=>{ const c=nodeColor(d); d.baseColor=c.slice(); d.color=c.slice(); return d; });
  }

  function buildEdges(apiEdges, nodes){
    const full = new URLSearchParams(location.search).has('full');
    const cap = full ? 1e9 : 5000;
    return (apiEdges||[]).slice(0,cap).map(e=>{
      const a = Array.isArray(e)?e[0]:e.a; const b = Array.isArray(e)?e[1]:e.b; const ia = (a-1); const ib=(b-1);
      const na = nodes[ia]; const nb = nodes[ib]; if (!na||!nb) return null;
      return { sourceIndex: ia, targetIndex: ib, color:[TOKENS.fgDim[0], TOKENS.fgDim[1], TOKENS.fgDim[2]], width:1 };
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
      const priceMax = parr.reduce((max,val)=> (Number.isFinite(val) && val>max) ? val : max, 1);
      const vmaxLog = Math.log1p(Math.max(1, priceMax));
      const ly = (p)=>{ const v=Math.log1p(Math.max(0, p||0)); const y = (1 - v/(vmaxLog||1))*(h-160) + 80; return y; };
      basePositions = nodes.map(d=>{
        const idx = d.tokenId;
        const t = tarrRaw[idx] ?? t0;
        const p = parr[idx] ?? 0;
        const pos=[lx(t), ly(p), 0];
        d.position = pos;
        d.timelineTs = t;
        d.lastSalePrice = p;
        const saleC = Number(pdata.tokenSaleCount?.[idx] ?? d.saleCount ?? 0);
        d.saleCount = saleC;
        d.radius = clamp(2.2 + Math.min(5, Math.sqrt(Math.max(1, saleC))), 2, 9);
        return pos.slice();
      });
    } else {
      // Default grid
      const grid=100; nodes.forEach((d,i)=>{ d.position=[(i%grid)*20-1000, Math.floor(i/grid)*20-1000, 0]; }); basePositions = nodes.map(d=>d.position.slice());
    }
    hasFittedOnce = false; // trigger fit on next render
  }

  // colorFor removed in favor of nodeColor

  function render(nodes, edges, mode){
    const w = center.clientWidth||1200, h=center.clientHeight||800;
    // Zoom-derived fades instead of hard gating so layers ease in/out smoothly
    const zoomNorm = (currentZoom==null)
      ? 1
      : clamp((currentZoom - (-2)) / (4 - (-2)), 0, 1); // deck orthographic zoom typically spans ~[-2,4]
    const overlayFade = (currentZoom==null)
      ? 1
      : clamp((currentZoom - (-1)) / (4 - (-1)), 0, 1);
    const simpleFlow = currentSimpleView === 'flow';
    const simpleDots = currentSimpleView === 'dots';
    const simpleTree = currentSimpleView === 'tree';
    const simpleRhythm = currentSimpleView === 'rhythm';

    const showEdges = (mode==='holders' && ui.ownership && ui.ambient && !simpleFlow);
    const showFlows = (mode==='holders' && (ui.transfers || simpleFlow));
    const showOverlays = overlayFade > 0;
    const showHulls = overlayFade > 0;
    const baseEdgeAlpha = 180 + (zoomNorm * 40);
    const edgeAlpha = Math.round(baseEdgeAlpha * zoomNorm);
    const overlayAlpha = Math.round(160 * overlayFade);
    // Apply highlight filter dimming
    if (highlightSet && highlightSet.size){ nodes.forEach(n=>{ const on = highlightSet.has(n.id); const c=n.baseColor.slice(); c[3] = on? Math.max(160, c[3]||160) : 35; n.color=c; }); }
    else { nodes.forEach(n=> n.color = n.baseColor.slice()); }

    const computeEdgeColor = (edge)=>{
      const base = Array.isArray(edge?.color) ? edge.color : null;
      const r = base?.[0] ?? TOKENS.fgBright[0];
      const g = base?.[1] ?? TOKENS.fgBright[1];
      const b = base?.[2] ?? TOKENS.fgBright[2];
      const baseAlpha = clamp(base?.[3] ?? baseEdgeAlpha, 0, 255);
      const alpha = Math.round(baseAlpha * zoomNorm);
      return [r, g, b, alpha];
    };

    // Selection ring data (persistent after click)
    const selObj = selectedId>0 ? nodes.find(n=>n && n.id===selectedId) : null;

    ensurePositionAttribute();
    const nodePositionProps = positionAttribute ? { attributes: { instancePositions: positionAttribute } } : null;

    let layers = [];
    if (mode==='holders'){
      layers = buildOwnershipDotLayers({
        nodes,
        edges,
        selObj,
        showEdges,
        overlayAlpha,
        edgeColorFn: computeEdgeColor,
        nodePositionProps,
        showOverlays,
        showFlows,
        zoomNorm
      });
    } else {
      const grid = makeGridLines(w, h, 50);
      const holdersHulls = (mode==='holders' && ui.bubbles) ? computeHulls(nodes, presetData) : [];
      const showSalesFlows = getChecked('layer-sales', true);
      const showTransferFlows = getChecked('layer-transfers', true);
      const showMintFlows = getChecked('layer-mints', true);
      const flowCap = Math.max(1, Math.min(edgeCount || 200, 400));
      const flowLayer = (showFlows && Array.isArray(flowEdges) && flowEdges.length)
        ? buildMarketFlowLayer({
            id: 'flows-market',
            flows: flowEdges,
            nodes,
            zoomNorm,
            maxEdges: flowCap,
            filters: { sale: showSalesFlows, transfer: showTransferFlows, mint: showMintFlows }
          })
        : null;
      layers = [
        // Grid lines behind everything
        new LineLayer({ id:'grid', data:grid, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], 25], getWidth:1, widthUnits:'pixels' }),
        // Ownership hull rings gated by zoom (soft fill + stroke)
        (showHulls && holdersHulls.length) && new PolygonLayer({ id:'hulls', data:holdersHulls, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPolygon:d=>d.path, stroked:true, filled:true, getFillColor:[TOKENS.fgDim[0], TOKENS.fgDim[1], TOKENS.fgDim[2], 14], getLineColor:[TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], 55], getLineWidth:1, lineWidthUnits:'pixels' }),
        // Fancy ownership multi-rings (top owners), also gated by zoom
        (showHulls && mode==='holders' && ui.bubbles) && new PolygonLayer({ id:'owner-rings', data: buildOwnerRings(), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, stroked:true, filled:false, getPolygon:d=>d.path, getLineColor:d=>d.color, getLineWidth:d=>d.width, lineWidthUnits:'pixels', parameters:{ depthTest:false }, updateTriggers:{ getLineColor: [pulseT] } }),
        // Optional density underlay (GPU aggregator)
        (Array.isArray(nodes) && nodes.length) && new (ScreenGridLayer||window.deck.ScreenGridLayer)({ id:'density', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, cellSizePixels:12, gpuAggregation:true, opacity:0.35, minColor:[0,0,0,0], maxColor:[TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], 255], pickable:false, parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
        // Ownership edges (thicker, additive blending)
        showEdges && new LineLayer({ id:'edges', data:edges, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>nodes[d.sourceIndex]?.position||[0,0,0], getTargetPosition:d=>nodes[d.targetIndex]?.position||[0,0,0], getColor:computeEdgeColor, widthUnits:'pixels', widthMinPixels:2.5, parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
        flowLayer,
        new ScatterplotLayer({ id:'glow', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(3, (d.radius||3)*2.4), getFillColor:d=>[d.color[0],d.color[1],d.color[2], Math.round(16 * overlayFade)], radiusUnits:'pixels', parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 } }),
        // Neighbor edges on click
        (selectedId>0) && new LineLayer({ id:'click-edges', data: buildClickEdges(selectedId), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,180], getWidth:1.2, widthUnits:'pixels', parameters:{ depthTest:false } }),
        new ScatterplotLayer({ id:'nodes', data:nodes, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:true, autoHighlight:true, highlightColor:[255,255,255,80], getPosition:d=>d.position, getRadius:d=> (d.radius||3), radiusUnits:'pixels', radiusMinPixels:2, radiusMaxPixels:7, stroked:true, getLineWidth:0.5, lineWidthUnits:'pixels', lineWidthMinPixels:0.5, getFillColor:d=>d.color, onClick: handleClick, parameters:{ blend:true, depthTest:false, blendFunc:[770,1], blendEquation:32774 }, extensions:[ new (BrushingExtension||window.deck.BrushingExtension)() ], brushingEnabled:true, brushingRadius:60, ...(nodePositionProps||{}) }),
        // Subtle pulse rings for recently active tokens
        (showOverlays) && new ScatterplotLayer({ id:'pulses', data: nodes.filter(n=>recentActive(n)), coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, pickable:false, stroked:true, filled:false, getPosition:d=>d.position, getRadius:d=> (d.radius||4) * (1.6 + 0.4*Math.sin(pulseT*2 + (d.id||0))), getLineColor:[TOKENS.fgBright[0], TOKENS.fgBright[1], TOKENS.fgBright[2], Math.max(0, Math.min(255, overlayAlpha))], lineWidthMinPixels:1, radiusUnits:'pixels', updateTriggers:{ getRadius: [pulseT] }, parameters:{ depthTest:false } }),
        (selObj) && new ScatterplotLayer({ id:'selection-ring', data:[selObj], coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getPosition:d=>d.position, getRadius:d=>Math.max(10,(d.radius||4)+8), getFillColor:[0,0,0,0], getLineColor:[TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], Math.max(140, Math.min(255, overlayAlpha+100))], lineWidthMinPixels:2, stroked:true, filled:false, radiusUnits:'pixels' })
      ].filter(Boolean);
    }
    // View-specific adds
    try {
      if (mode==='traits' && ui.traits) layers = makeTraitsLayers(layers);
      if (mode==='wallets' || mode==='whales') layers = makeWalletsLayers(layers, { zoomNorm, zoom: currentZoom });
      if (mode==='transfers') layers = makeTransfersLayers(layers, { zoomNorm, zoom: currentZoom });
      if (mode==='transfers' && timelineLimits){
        // Scanning line at current time
        const t0=timelineLimits.t0||0, t1=timelineLimits.t1||1; const w=center.clientWidth||1200; const h=center.clientHeight||800;
        const x = (timeline.value||t1); const px = (x - t0)/(t1 - t0) * (w-160) + 80;
        const scan = [{ s:[px,80,0], t:[px,h-80,0] }];
        layers.unshift(new LineLayer({ id:'scanline', data:scan, coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[0,255,102,120], getWidth:1.5, widthUnits:'pixels', parameters:{ depthTest:false }, updateTriggers:{ data: [timeline.value] } }));
      }
      // Health/Activity view keys off select state while using holders data
      if (currentMode==='health' && mode==='holders') layers = makeActivityLayers(layers);
    } catch {}
    if (mode==='traits' && ui.traits){
      const paths = computeConstellationPaths(nodes, presetData);
      if (paths.length) layers.unshift(new LineLayer({ id:'trait-constellations', data:paths, getSourcePosition:d=>d.s, getTargetPosition:d=>d.t, getColor:[255,215,0,160], getWidth:0.8, widthUnits:'pixels', opacity:0.6 }));
    }
    // LOD: stronger gating for heavy visuals
    const lodEdges = true;
    if (!lodEdges) layers = layers.filter(l=> l && l.id!=='edges');
    deckInst.setProps({ layers });
    if (!hasFittedOnce) {
      try {
        if (fitViewToNodes(nodes)) {
          hasFittedOnce = true;
        }
      } catch {}
    }
  }

  function buildOwnershipDotLayers({ nodes, edges, selObj, showEdges, overlayAlpha, edgeColorFn, nodePositionProps, showOverlays, showFlows, zoomNorm = 1 }){
    const layers = [];
    if (showEdges && Array.isArray(edges) && edges.length){
      layers.push(new LineLayer({
        id: 'edges',
        data: edges,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        getSourcePosition: d => nodes[d.sourceIndex]?.position || [0,0,0],
        getTargetPosition: d => nodes[d.targetIndex]?.position || [0,0,0],
        getColor: edgeColorFn,
        widthUnits: 'pixels',
        widthMinPixels: 1.4,
        parameters: { depthTest: false }
      }));
    }

    if (showFlows && Array.isArray(flowEdges) && flowEdges.length){
      const showSales = getChecked('layer-sales', true);
      const showTransfers = getChecked('layer-transfers', true);
      const showMints = getChecked('layer-mints', true);
      const cap = Math.max(1, Math.min(edgeCount || 200, 400));
      const flowLayer = buildMarketFlowLayer({
        id: 'flows-market',
        flows: flowEdges,
        nodes,
        zoomNorm,
        maxEdges: cap,
        filters: { sale: showSales, transfer: showTransfers, mint: showMints }
      });
      if (flowLayer) layers.push(flowLayer);
    }

    const baseScatterProps = {
      id: 'nodes',
      data: nodes,
      coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 80],
      getPosition: d => d.position,
      getRadius: d => d.radius || 2,
      radiusUnits: 'pixels',
      radiusMinPixels: 2,
      radiusMaxPixels: 7,
      stroked: true,
      getLineWidth: 0.5,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 0.5,
      getFillColor: d => d.color,
      onClick: handleClick,
      parameters: { blend: true, depthTest: false, blendFunc: [770, 1], blendEquation: 32774 },
      extensions: [ new (BrushingExtension||window.deck.BrushingExtension)() ],
      brushingEnabled: true,
      brushingRadius: 60
    };
    layers.push(new ScatterplotLayer(nodePositionProps ? { ...baseScatterProps, ...nodePositionProps } : baseScatterProps));

    if (showOverlays){
      const recent = nodes.filter(recentActive);
      if (recent.length){
        layers.push(new ScatterplotLayer({
          id: 'pulse-outline',
          data: recent,
          coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
          pickable: false,
          stroked: true,
          filled: false,
          getPosition: d => d.position,
          getRadius: d => (d.radius || 2) + 2,
          radiusUnits: 'pixels',
          getLineColor: [0, 255, 102, 140],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          updateTriggers: { getRadius: [pulseT] },
          parameters: { depthTest: false }
        }));
      }
    }

    if (selObj){
      layers.push(new ScatterplotLayer({
        id: 'selection-ring',
        data: [selObj],
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        getPosition: d => d.position,
        getRadius: d => Math.max(10, (d.radius || 4) + 8),
        getFillColor: [0, 0, 0, 0],
        getLineColor: [TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], Math.max(140, Math.min(255, overlayAlpha + 100))],
        lineWidthMinPixels: 2,
        stroked: true,
        filled: false,
        radiusUnits: 'pixels'
      }));
    }

    return layers.filter(Boolean);
  }

  function ensurePositionAttribute(){
    try {
      const count = Array.isArray(nodes) ? nodes.length : 0;
      if (!count){ positionAttribute = null; return; }
      const expected = count * 3;
      if (!positionAttribute || !positionAttribute.value || positionAttribute.value.length !== expected){
        positionAttribute = { value: new Float32Array(expected), size: 3 };
      }
      const arr = positionAttribute.value;
      for (let i=0;i<count;i++){
        const p = nodes[i].position || [0,0,0];
        const o = i*3;
        arr[o] = p[0] ?? 0;
        arr[o+1] = p[1] ?? 0;
        arr[o+2] = p[2] ?? 0;
      }
    } catch {
      positionAttribute = null;
    }
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
    render(nodes, edges, effectiveMode(currentMode));
  }
  function animateTraits(t){
    if (!basePositions) return;
    const out = nodes.map((d,i)=>{ const bp=basePositions[i]; const ny = bp[1] + Math.sin((i*0.1)+t)*1.5; return [bp[0], ny, 0]; });
    nodes.forEach((d,i)=> d.position=out[i]);
    render(nodes, edges, effectiveMode(currentMode));
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
          jfetch('/api/heatmap').then(j=>{ heatmapCache=j||{grid:[]}; render(nodes, edges, effectiveMode(currentMode)); });
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
    const hours = (Date.now()/1000 - last) / 3600; return hours < 24;
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
      const response = await jfetch('/api/transfer-edges?limit=1000&nodes=10000');
      if (!Array.isArray(response) || !Array.isArray(nodes)) return null;

      const idToIndex = new Map();
      nodes.forEach((node, idx) => {
        if (!node) return;
        const idVariants = [node.id, node.tokenId, node.tokenId != null ? node.tokenId + 1 : null];
        for (const key of idVariants){
          if (key == null) continue;
          const num = Number(key);
          if (Number.isFinite(num)) idToIndex.set(num, idx);
        }
      });

      const toIndex = (key) => {
        const num = Number(key);
        if (!Number.isFinite(num)) return null;
        const idx = idToIndex.get(num);
        return (idx != null && nodes[idx]) ? idx : null;
      };

      const toPoint = (key) => {
        const idx = toIndex(key);
        if (idx == null) return null;
        const p = nodes[idx]?.position;
        if (!Array.isArray(p)) return null;
        return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
      };

      const mapPath = (raw) => {
        if (!Array.isArray(raw) || raw.length < 2) return null;
        const out = [];
        for (const step of raw){
          let pos = null;
          if (Array.isArray(step)){
            const finite = step.every(v => Number.isFinite(v));
            if (finite && step.length >= 2){
              const [x, y, z = 0] = step;
              pos = [x, y, z];
            } else if (step.length === 1 && Number.isFinite(step[0])){
              pos = toPoint(step[0]);
            }
          } else if (typeof step === 'number'){
            pos = toPoint(step);
          } else if (step && typeof step === 'object'){
            const tokenId = Number(step.tokenId ?? step.id);
            if (Number.isFinite(tokenId)){
              pos = toPoint(tokenId);
            } else if (Number.isFinite(step.x) && Number.isFinite(step.y)){
              const z = Number.isFinite(step.z) ? step.z : 0;
              pos = [step.x, step.y, z];
            }
          }
          if (pos) out.push(pos);
        }
        return out.length >= 2 ? out : null;
      };

      return response.map(edge => {
        const sourceIndex = toIndex(edge?.a);
        const targetIndex = toIndex(edge?.b);
        if (sourceIndex == null || targetIndex == null) return null;

        const valueTia = Number(edge?.value_tia ?? edge?.valueTia ?? 0);
        const valueUsd = Number(edge?.value_usd ?? edge?.valueUsd ?? 0);
        const count = Number(edge?.count ?? edge?.cnt ?? 0);
        const weightRaw = Number.isFinite(valueTia) && valueTia > 0
          ? valueTia
          : (Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : count || 1);
        const weight = Math.max(1e-6, weightRaw);
        const type = (edge?.type || 'transfer').toString().toLowerCase();
        const path = mapPath(edge?.path);

        return {
          sourceIndex,
          targetIndex,
          type,
          count: count || 0,
          weight,
          valueTia: Number.isFinite(valueTia) ? valueTia : 0,
          valueUsd: Number.isFinite(valueUsd) ? valueUsd : 0,
          path
        };
      }).filter(Boolean);
    } catch {
      return null;
    }
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
      render(nodes, edges, effectiveMode(currentMode));
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
  function setCheckbox(id, value){
    try {
      const el = document.getElementById(id);
      if (!el || typeof value !== 'boolean') return;
      if (el.checked === value) return;
      el.checked = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
  }
  async function applySimpleView(name){
    try {
      const key = (name||'').toString().toLowerCase();
      const cfg = SIMPLE_VIEW_CONFIG[key];
      if (!cfg) return;
      currentSimpleView = key;
      const viewEl = document.getElementById('view');
      if (viewEl) viewEl.value = key;
      const modeEl = document.getElementById('mode');
      if (modeEl && cfg.modeSelect) modeEl.value = cfg.modeSelect;
      if (cfg.toggles){
        Object.entries(cfg.toggles).forEach(([id, val])=> setCheckbox(id, !!val));
      }
      await loadMode(cfg.baseMode || 'holders', edgeCount);
      try { render(nodes, edges, effectiveMode(currentMode)); } catch {}
    } catch {}
  }
  async function highlightWallet(address){
    try {
      const r = await jfetch(`/api/wallet/${address}`);
      const ids = new Set((r.tokens||[]).map(Number));
      highlightSet = ids; selectedId=-1; render(nodes,edges,currentMode);
    } catch { highlightSet=null; }
  }
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
      updateNodeSizing(pdata);
    } catch {}
  }

  function updateNodeSizing(pdata){
    try {
      if (!Array.isArray(nodes) || !nodes.length) return;
      const holdingsArr = Array.isArray(ownerHoldings) ? ownerHoldings : [];
      const buyArr = Array.isArray(pdata?.ownerBuyVol) ? pdata.ownerBuyVol : [];
      const sellArr = Array.isArray(pdata?.ownerSellVol) ? pdata.ownerSellVol : [];
      for (const n of nodes){
        const oi = n.ownerIndex;
        const hold = Math.max(0, Number(holdingsArr[oi] ?? 0));
        const buy = Math.max(0, Number(buyArr[oi] ?? 0));
        const sell = Math.max(0, Number(sellArr[oi] ?? 0));
        const sum = hold + buy + sell;
        const metric = Math.log10(Math.max(1, sum));
        n.radius = clamp(2 + metric, 2, 7);
      }
    } catch {}
  }

  async function fetchTopOwnerLabels(pdata, counts, centers){
    const owners = pdata?.owners || [];
    const ranked = owners.map((addr,i)=>({ addr:(addr||'').toLowerCase(), i, h: counts[i]||0, c: centers[i] })).filter(x=>x.c).sort((a,b)=>b.h-a.h).slice(0,40);
    const need = ranked.filter(r=> r.addr && !ownerLabels.has(r.addr)).slice(0, 24);
    if (!need.length) return;
    const tasks = need.map(r => jfetch(`/api/wallet/${r.addr}/meta`).then(meta => ({ r, meta })).catch(()=>null));
    const settled = await Promise.allSettled(tasks);
    for (const entry of settled){
      if (entry.status !== 'fulfilled' || !entry.value) continue;
      const { r, meta } = entry.value;
      const label = (meta?.ens_name && meta.ens_name.length>2) ? meta.ens_name : `${r.addr.slice(0,6)}...${r.addr.slice(-4)}`;
      ownerLabels.set(r.addr, label);
    }
    if (effectiveMode(currentMode)==='holders') try { render(nodes, edges, effectiveMode(currentMode)); } catch {}
  }

  function helixPath(list){
    if (!list || list.length<3) return [];
    const c = list.reduce((acc,n)=>{acc[0]+=n.position[0];acc[1]+=n.position[1];return acc;},[0,0]); c[0]/=list.length; c[1]/=list.length;
    const ordered = list.map(n=>({n, ang:Math.atan2(n.position[1]-c[1], n.position[0]-c[0])})).sort((a,b)=>a.ang-b.ang).map(o=>o.n);
    const path=[]; for (let i=0;i<ordered.length;i++){ const a=ordered[i].position; const b=ordered[(i+1)%ordered.length].position; const mid=[(a[0]+b[0])/2, (a[1]+b[1])/2, 0]; path.push(a, mid, b); }
    return path;
  }

  function buildLifecycleTree({ zoom = 0, zoomNorm = 1 }){
    const result = { nodes: [], edges: [], labels: [] };
    try {
      if (!Array.isArray(nodes) || !nodes.length || !presetData) return result;
      const owners = Array.isArray(presetData?.owners) ? presetData.owners : [];
      if (!owners.length) return result;
      const ownerTypesRaw = Array.isArray(presetData?.ownerWalletType) ? presetData.ownerWalletType : [];
      const buyVol = Array.isArray(presetData?.ownerBuyVol) ? presetData.ownerBuyVol : [];
      const sellVol = Array.isArray(presetData?.ownerSellVol) ? presetData.ownerSellVol : [];
      const width = center?.clientWidth || 1200;
      const height = center?.clientHeight || 800;
      const cx = width / 2;
      const cy = height / 2;
      const dim = Math.max(400, Math.min(width, height));
      const rootRadius = clamp(dim * 0.18, 80, 260);
      const level1Radius = clamp(dim * 0.34, rootRadius + 40, rootRadius + 240);
      const level2Radius = clamp(dim * 0.48, level1Radius + 50, level1Radius + 280);
      const nowSec = Date.now() / 1000;
      const ownerTypes = owners.map((_, i) => (ownerTypesRaw[i] || '').toString().toLowerCase());
      const holdings = Array.isArray(ownerHoldings) ? ownerHoldings : [];

      const tokensByOwner = new Map();
      nodes.forEach(token => {
        const oi = token.ownerIndex;
        if (oi == null || oi < 0) return;
        if (!tokensByOwner.has(oi)) tokensByOwner.set(oi, []);
        tokensByOwner.get(oi).push(token);
      });

      let whaleIndices = owners
        .map((_, idx) => ((ownerTypes[idx] === 'whale' || ownerTypes[idx] === 'whale_trader') ? idx : -1))
        .filter(idx => idx >= 0);
      if (!whaleIndices.length){
        whaleIndices = owners
          .map((_, idx) => ({ idx, weight: holdings[idx] || 0 }))
          .sort((a,b)=> (b.weight - a.weight))
          .slice(0, Math.min(8, owners.length))
          .map(o=>o.idx);
      }
      if (!whaleIndices.length) return result;

      const angleStep = (Math.PI * 2) / whaleIndices.length;
      const baseAngleOffset = -Math.PI / 2;
      const baseSpread = Math.min(Math.PI / 1.8, angleStep * 0.9 + 0.3);
      const activeLimit = zoom < 1.05 ? 14 : (zoom < 1.5 ? 40 : 120);
      const leafLimit = zoom < 1.05 ? 28 : (zoom < 1.5 ? 90 : 260);

      const shortAddress = (addr) => {
        if (!addr || typeof addr !== 'string') return '—';
        const lower = addr.toLowerCase();
        const cached = ownerLabels.get(lower);
        if (cached) return cached;
        if (lower.length <= 10) return lower;
        return `${lower.slice(0, 6)}...${lower.slice(-4)}`;
      };

      const tokenStatus = (token) => {
        const frozen = !!token.frozen;
        const last = Number(token.lastActivity || 0);
        const daysSince = last > 0 ? (nowSec - last) / 86400 : Infinity;
        const dormant = !frozen && (!!token.dormant || daysSince >= 90);
        return { frozen, dormant };
      };

      const bundleList = (list, limit, classifier) => {
        const arr = Array.isArray(list) ? list.slice() : [];
        if (!arr.length) return [];
        arr.sort((a,b)=> Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
        const buckets = [];
        if (arr.length <= limit){
          for (const token of arr){
            const status = classifier ? classifier([token]) : {};
            buckets.push({
              ids: [token.id],
              primaryId: token.id,
              tokens: [token],
              weight: 1,
              status
            });
          }
          return buckets;
        }
        const size = Math.max(1, Math.ceil(arr.length / limit));
        for (let i=0;i<arr.length;i+=size){
          const chunk = arr.slice(i, i+size);
          const status = classifier ? classifier(chunk) : {};
          buckets.push({
            ids: chunk.map(t=>t.id),
            primaryId: chunk[0]?.id,
            tokens: chunk,
            weight: chunk.length,
            status
          });
        }
        return buckets;
      };

      whaleIndices.forEach((ownerIdx, order) => {
        if (result.edges.length >= 1500) return;
        const angle = baseAngleOffset + order * angleStep;
        const rootPos = [
          cx + Math.cos(angle) * rootRadius,
          cy + Math.sin(angle) * rootRadius,
          0
        ];
        const addressRaw = owners[ownerIdx] || '';
        const addressLower = addressRaw.toLowerCase();
        const ownedTokens = tokensByOwner.get(ownerIdx) || [];
        const rootWeight = Math.max(1, (holdings[ownerIdx] || 0) + Number(buyVol[ownerIdx] || 0) + Number(sellVol[ownerIdx] || 0));
        const rootNode = {
          id: `tree-root-${ownerIdx}`,
          level: 0,
          angle,
          position: rootPos,
          ownerIndex: ownerIdx,
          address: addressLower,
          addressRaw,
          tokens: ownedTokens.map(t=>t.id),
          frozen: false,
          dormant: false,
          whale: true,
          weight: rootWeight,
          displayRadius: clamp(6 + Math.log1p(rootWeight), 6, 12),
          label: shortAddress(addressRaw)
        };
        result.nodes.push(rootNode);
        result.labels.push({ position: [rootPos[0], rootPos[1] - 18, 0], label: rootNode.label, ownerIndex });

        const activeTokens = [];
        const frozenTokens = [];
        const dormantTokens = [];
        for (const token of ownedTokens){
          const status = tokenStatus(token);
          if (status.frozen) frozenTokens.push(token);
          else if (status.dormant) dormantTokens.push(token);
          else activeTokens.push(token);
        }

        const classifyActive = () => ({ frozen: false, dormant: false });
        const classifyInactive = (chunk) => {
          let frozenCount = 0;
          let dormantCount = 0;
          for (const tok of chunk){
            const status = tokenStatus(tok);
            if (status.frozen) frozenCount++;
            else if (status.dormant) dormantCount++;
          }
          return {
            frozen: frozenCount >= dormantCount && frozenCount > 0,
            dormant: dormantCount > 0 && dormantCount >= frozenCount
          };
        };

        const activeBuckets = bundleList(activeTokens, activeLimit, classifyActive);
        const inactiveBuckets = bundleList([...frozenTokens, ...dormantTokens], leafLimit, classifyInactive);

        const activeSpread = activeBuckets.length > 1
          ? baseSpread
          : baseSpread * 0.45;

        const activeNodes = [];
        activeBuckets.forEach((bucket, idx) => {
          if (result.edges.length >= 1500) return;
          const offset = activeBuckets.length <= 1
            ? 0
            : ((idx / (activeBuckets.length - 1)) - 0.5) * activeSpread;
          const nodeAngle = angle + offset;
          const pos = [
            cx + Math.cos(nodeAngle) * level1Radius,
            cy + Math.sin(nodeAngle) * level1Radius,
            0
          ];
          const node = {
            id: `tree-active-${ownerIdx}-${idx}`,
            level: 1,
            position: pos,
            angle: nodeAngle,
            ownerIndex,
            tokens: bucket.ids,
            primaryTokenId: bucket.primaryId,
            frozen: false,
            dormant: false,
            aggregated: bucket.weight > 1,
            weight: bucket.weight,
            displayRadius: clamp(bucket.weight > 1 ? 4 + Math.log1p(bucket.weight) : 4, 3.5, 8)
          };
          activeNodes.push(node);
          result.nodes.push(node);
          result.edges.push({ s: rootPos, t: pos, w: bucket.weight, type: 'active', ownerIndex });
        });

        const parents = activeNodes.length ? activeNodes : [rootNode];
        const leavesPerParent = parents.map(()=>[]);
        inactiveBuckets.forEach((bucket, idx) => {
          const target = parents.length ? (idx % parents.length) : 0;
          leavesPerParent[target].push(bucket);
        });

        parents.forEach((parentNode, parentIdx) => {
          if (result.edges.length >= 1500) return;
          const assigned = leavesPerParent[parentIdx];
          if (!assigned || !assigned.length) return;
          const leafSpread = assigned.length > 1 ? baseSpread * 0.65 : baseSpread * 0.4;
          assigned.forEach((bucket, leafIdx) => {
            if (result.edges.length >= 1500) return;
            const offset = assigned.length <= 1
              ? 0
              : ((leafIdx / (assigned.length - 1)) - 0.5) * leafSpread;
            const leafAngle = parentNode.angle + offset;
            const pos = [
              cx + Math.cos(leafAngle) * level2Radius,
              cy + Math.sin(leafAngle) * level2Radius,
              0
            ];
            const frozenFlag = !!bucket.status?.frozen;
            const dormantFlag = !frozenFlag && !!bucket.status?.dormant;
            const node = {
              id: `tree-leaf-${ownerIdx}-${parentIdx}-${leafIdx}`,
              level: 2,
              position: pos,
              angle: leafAngle,
              ownerIndex,
              tokens: bucket.ids,
              primaryTokenId: bucket.primaryId,
              frozen: frozenFlag,
              dormant: dormantFlag,
              aggregated: bucket.weight > 1,
              weight: bucket.weight,
              displayRadius: clamp(bucket.weight > 1 ? 3 + Math.log1p(bucket.weight) : 3, 2.5, 6)
            };
            result.nodes.push(node);
            result.edges.push({ s: parentNode.position, t: pos, w: bucket.weight, type: frozenFlag ? 'frozen' : 'dormant', ownerIndex });
          });
        });
      });

      return result;
    } catch {
      return result;
    }
  }

  function makeWalletsLayers(base, opts = {}){
    try {
      const zoomNorm = Number.isFinite(opts?.zoomNorm) ? opts.zoomNorm : 1;
      const zoom = Number.isFinite(opts?.zoom) ? opts.zoom : currentZoom;
      const tree = buildLifecycleTree({ zoom, zoomNorm });
      if (!tree || !tree.nodes.length) return base;

      const fade = clamp(0.55 + zoomNorm * 0.45, 0.35, 1);

      const branches = new LineLayer({
        id: 'tree-branches',
        data: tree.edges,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        getSourcePosition: d => d.s,
        getTargetPosition: d => d.t,
        getWidth: d => 1 + Math.min(3, Math.log1p(Math.max(1e-6, d.w || 1))),
        widthUnits: 'pixels',
        getColor: d => {
          const alpha = Math.round(140 * fade);
          if (d.type === 'frozen') return [68, 136, 255, alpha];
          if (d.type === 'dormant') return [110, 110, 110, Math.round(alpha * 0.9)];
          return [90, 180, 120, alpha];
        },
        parameters: { depthTest: false }
      });

      const handleTreeClick = async (info) => {
        const obj = info?.object;
        if (!obj) return;
        try {
          if (obj.level === 0 && obj.addressRaw){
            await openWallet(obj.addressRaw);
            return;
          }
          const primary = obj.primaryTokenId || (Array.isArray(obj.tokens) ? obj.tokens[0] : null);
          if (primary) focusSelect(primary);
        } catch {}
      };

      const nodeLayer = new ScatterplotLayer({
        id: 'tree-nodes',
        data: tree.nodes,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        getPosition: d => d.position,
        getRadius: d => d.displayRadius ?? (d.level === 0 ? 6 : d.level === 1 ? 4 : 3),
        radiusUnits: 'pixels',
        stroked: true,
        getLineWidth: 0.75,
        lineWidthUnits: 'pixels',
        getFillColor: d => {
          if (d.level === 0) return [0, 255, 160, Math.round(210 * fade)];
          if (d.frozen) return [68, 136, 255, Math.round(220 * fade)];
          if (d.dormant) return [102, 102, 102, Math.round(205 * fade)];
          return [0, 255, 102, Math.round(210 * fade)];
        },
        onClick: handleTreeClick,
        parameters: { depthTest: false }
      });

      const layersOut = [branches, nodeLayer];

      if (tree.labels.length && typeof TextLayer === 'function' && zoom >= 2){
        layersOut.push(new TextLayer({
          id: 'tree-labels',
          data: tree.labels,
          coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
          getPosition: d => d.position,
          getText: d => d.label,
          getSize: 16,
          getColor: [255, 255, 255, Math.round(220 * fade)],
          fontFamily: 'IBM Plex Mono, monospace',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [0, -8],
          outlineColor: [0, 0, 0, 160],
          outlineWidth: 2
        }));
      }

      return layersOut;
    } catch {
      return base;
    }
  }

  function getRhythmBuckets(interval='hour'){
    try {
      if (rhythmActivity.has(interval)) return rhythmActivity.get(interval);
      if (!rhythmActivityPending.has(interval)){
        const promise = jfetch(`/api/activity?interval=${interval}`).then(res => {
          rhythmActivityPending.delete(interval);
          const buckets = Array.isArray(res?.buckets)
            ? res.buckets.filter(b => Number.isFinite(b?.t))
            : [];
          rhythmActivity.set(interval, buckets);
          try { render(nodes, edges, effectiveMode(currentMode)); } catch {}
          return buckets;
        }).catch(()=>{
          rhythmActivityPending.delete(interval);
        });
        rhythmActivityPending.set(interval, promise);
      }
      return [];
    } catch {
      return [];
    }
  }

  function rhythmDotColor(d, fade){
    const base = Array.isArray(d?.color) ? d.color : COLORS.active;
    const mix = (v)=> clamp(Math.round(40 + v * 0.65), 0, 255);
    const r = mix(base[0] ?? 0);
    const g = mix(base[1] ?? 0);
    const b = mix(base[2] ?? 0);
    const alpha = clamp(Math.round((base[3] ?? 200) * fade), 40, 235);
    return [r, g, b, alpha];
  }

  function rhythmDotStroke(d, fade){
    const base = Array.isArray(d?.color) ? d.color : COLORS.active;
    const r = clamp(Math.round((base[0] ?? 0) * 0.75 + 30), 0, 255);
    const g = clamp(Math.round((base[1] ?? 0) * 0.75 + 30), 0, 255);
    const b = clamp(Math.round((base[2] ?? 0) * 0.75 + 30), 0, 255);
    const alpha = clamp(Math.round((base[3] ?? 180) * Math.max(0.35, fade * 0.9)), 40, 230);
    return [r, g, b, alpha];
  }

  function ensureHeatmap(){
    try {
      if (heatmapCache || heatmapLoading) return;
      heatmapLoading = true;
      jfetch('/api/heatmap').then(j=>{
        heatmapCache = j || { grid: [] };
        heatmapLoading = false;
        try { render(nodes, edges, effectiveMode(currentMode)); } catch {}
      }).catch(()=>{ heatmapLoading = false; });
    } catch {}
  }

  function buildRhythmLayers({ zoom = 0, zoomNorm = 1 }){
    const before = [];
    const after = [];
    try {
      if (!Array.isArray(nodes) || !nodes.length) return { before, after };
      const width = center?.clientWidth || 1200;
      const height = center?.clientHeight || 800;
      const x0 = 80;
      const x1 = width - 80;
      const y0 = 80;
      const y1 = height - 80;
      let t0 = timelineLimits?.t0;
      let t1 = timelineLimits?.t1;
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0){
        const arr = Array.isArray(presetData?.tokenLastActivity)
          ? presetData.tokenLastActivity.filter(v => Number.isFinite(v))
          : [];
        if (arr.length){
          t0 = Math.min(...arr);
          t1 = Math.max(...arr);
        } else {
          const now = Math.floor(Date.now()/1000);
          t1 = now;
          t0 = now - 86400;
        }
      }
      const dt = (t1 - t0) || 1;
      const priceArr = Array.isArray(presetData?.tokenLastSalePrice) && presetData.tokenLastSalePrice.length
        ? presetData.tokenLastSalePrice
        : (presetData?.tokenPrice || []);
      const priceMax = priceArr.reduce((max,val)=> (Number.isFinite(val) && val>max) ? val : max, 1);
      const vmaxLog = Math.log1p(Math.max(1, priceMax));
      const mapX = (sec)=>{
        const ratio = (sec - t0) / dt;
        const clamped = clamp(ratio, 0, 1);
        return x0 + clamped * (x1 - x0);
      };
      const mapY = (price)=>{
        const v = Math.log1p(Math.max(0, price || 0));
        const ratio = vmaxLog > 0 ? (v / vmaxLog) : 0;
        return y0 + (1 - ratio) * (y1 - y0);
      };

      // Heatmap backdrop (zoomed out)
      if (zoomNorm < 0.45){
        if (!heatmapCache) ensureHeatmap();
        const grid = heatmapCache?.grid;
        if (Array.isArray(grid) && grid.length){
          const cellWidth = (x1 - x0) / 24;
          const cellHeight = (y1 - y0) / 7;
          let maxW = 0;
          const cells = [];
          for (let r=0;r<grid.length;r++){
            const row = grid[r] || [];
            for (let c=0;c<24;c++){
              const cell = row[c] || { count:0, volume:0 };
              const weight = Number(cell.count||0) + Number(cell.volume||0) * 0.2;
              if (weight <= 0) continue;
              if (weight > maxW) maxW = weight;
              const x = x0 + c * cellWidth;
              const y = y0 + r * cellHeight;
              cells.push({
                path: [
                  [x, y, 0],
                  [x + cellWidth, y, 0],
                  [x + cellWidth, y + cellHeight, 0],
                  [x, y + cellHeight, 0]
                ],
                weight
              });
            }
          }
          if (cells.length && maxW>0){
            before.push(new PolygonLayer({
              id: 'rhythm-heatmap',
              data: cells,
              coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
              stroked: false,
              filled: true,
              getPolygon: d => d.path,
              getFillColor: d => {
                const ratio = clamp(d.weight / maxW, 0, 1);
                const alpha = Math.round(45 + ratio * 55);
                return [40, 120, 90, alpha];
              },
              parameters: { depthTest: false }
            }));
          }
        }
      }

      // Activity buckets (adaptive interval)
      const interval = (zoomNorm < 0.4) ? 'day' : 'hour';
      const buckets = getRhythmBuckets(interval);
      if (Array.isArray(buckets) && buckets.length > 1){
        const metrics = buckets.map(b => {
          const vol = Number(b.volume || 0);
          const cnt = Number(b.count || 0);
          return Number.isFinite(vol) && vol>0 ? vol : cnt;
        });
        const maxMetric = metrics.reduce((m,v)=> (Number.isFinite(v) && v>m) ? v : m, 0);
        if (maxMetric > 0){
          const pathPoints = [];
          const pointData = [];
          buckets.forEach((bucket, idx) => {
            const metric = metrics[idx] || 0;
            if (metric <= 0) return;
            const sec = Number(bucket.t) / 1000;
            if (!Number.isFinite(sec)) return;
            const x = mapX(sec);
            if (!Number.isFinite(x)) return;
            const ratio = clamp(metric / maxMetric, 0, 1);
            const y = y1 - ratio * (y1 - y0) * 0.35;
            pathPoints.push([x, y, 0]);
            pointData.push({ position:[x, y, 0], ratio, bucket });
          });
          const lineFade = clamp(0.35 + zoomNorm * 0.65, 0.35, 1);
          if (pathPoints.length > 1 && typeof PathLayer === 'function'){
            after.push(new PathLayer({
              id: 'rhythm-volume-line',
              data: [{ path: pathPoints }],
              coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
              getPath: d => d.path,
              getColor: [90, 200, 150, Math.round(150 * lineFade)],
              getWidth: 2,
              widthUnits: 'pixels',
              parameters: { depthTest: false }
            }));
          }
          if (pointData.length){
            after.push(new ScatterplotLayer({
              id: 'rhythm-volume-points',
              data: pointData,
              coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
              pickable: false,
              getPosition: d => d.position,
              getRadius: d => 2.5 + d.ratio * 10,
              radiusUnits: 'pixels',
              stroked: false,
              getFillColor: d => [90, 200, 150, Math.round(120 * clamp(d.ratio, 0.2, 1))],
              parameters: { depthTest: false }
            }));
          }
        }
      }

      // Transfer particles (subtle motion)
      try {
        if (getChecked('layer-trades', true)){
          const particleLimit = Math.round(200 + zoomNorm * 400);
          const particles = buildFlowParticles(clamp(particleLimit, 100, 700));
          if (particles.length){
            after.push(new ScatterplotLayer({
              id: 'rhythm-trace',
              data: particles,
              coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
              pickable: false,
              getPosition: d => d.p,
              getRadius: d => 1.4 + Math.min(2.6, Math.sqrt(Math.max(0, d.price || 0)) * 0.25),
              radiusUnits: 'pixels',
              getFillColor: [0, 255, 102, Math.round(90 + 80 * zoomNorm)],
              parameters: { depthTest: false },
              updateTriggers: { getPosition: [pulseT] }
            }));
          }
        }
      } catch {}

      // Flow bundles (optional)
      if (Array.isArray(flowEdges) && flowEdges.length){
        const showSales = getChecked('layer-sales', true);
        const showTransfers = getChecked('layer-transfers', true);
        const showMints = getChecked('layer-mints', true);
        const cap = Math.max(1, Math.min(edgeCount || 200, 400));
        const flowLayer = buildMarketFlowLayer({
          id: 'rhythm-flows',
          flows: flowEdges,
          nodes,
          zoomNorm,
          maxEdges: cap,
          filters: { sale: showSales, transfer: showTransfers, mint: showMints }
        });
        if (flowLayer) after.push(flowLayer);
      }

      // Token dots (primary chronograph layer)
      const pointFade = clamp(0.35 + zoomNorm * 0.65, 0.35, 1);
      after.push(new ScatterplotLayer({
        id: 'rhythm-dots',
        data: nodes,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        getPosition: d => d.position,
        getRadius: d => {
          const saleC = Number(d.saleCount || 0);
          const base = 2 + Math.min(5, Math.sqrt(Math.max(1, saleC)));
          const scale = 0.85 + zoomNorm * 0.4;
          return base * scale;
        },
        radiusUnits: 'pixels',
        radiusMinPixels: 1.6,
        radiusMaxPixels: 10,
        stroked: true,
        getLineWidth: 0.7,
        lineWidthUnits: 'pixels',
        getFillColor: d => rhythmDotColor(d, pointFade),
        getLineColor: d => rhythmDotStroke(d, pointFade),
        onClick: handleClick,
        parameters: { depthTest: false, blend: true, blendFunc: [770, 1], blendEquation: 32774 },
        updateTriggers: { getFillColor: [pointFade], getRadius: [zoomNorm] }
      }));

      return { before, after };
    } catch {
      return { before, after };
    }
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
      render(nodes, edges, effectiveMode(currentMode));

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
    try {
      if (!list || !list.length) return false;
      const w = center?.clientWidth || 0;
      const h = center?.clientHeight || 0;
      const pad = 120;
      if (!(w > pad * 2 && h > pad * 2)) return false;

      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      for (const n of list){
        const p = n?.position;
        if (!p) continue;
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return false;

      const contentW = Math.max(1, maxX - minX);
      const contentH = Math.max(1, maxY - minY);
      const scale = Math.min((w - pad * 2) / contentW, (h - pad * 2) / contentH);
      if (!Number.isFinite(scale) || scale <= 0) return false;

      const zoom = Math.log2(scale) - 0.5;
      if (!Number.isFinite(zoom)) return false;

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      deckInst.setProps({ viewState: { target: [cx, cy, 0], zoom } });
      return true;
    } catch {
      return false;
    }
  }

  // Transfers view helpers
  function buildMarketFlowLayer({ id = 'flows', flows, nodes, zoomNorm = 1, maxEdges = 300, filters = {} }){
    try {
      if (!Array.isArray(flows) || !flows.length || !Array.isArray(nodes)) return null;
      const saleEnabled = filters.sale !== false;
      const transferEnabled = filters.transfer !== false;
      const mintEnabled = filters.mint !== false;
      const mixedEnabled = filters.mixed != null ? !!filters.mixed : (saleEnabled || transferEnabled);

      const filtered = [];
      for (const edge of flows){
        if (!edge) continue;
        const type = (edge.type || 'transfer').toString().toLowerCase();
        const srcNode = nodes[edge.sourceIndex];
        const tgtNode = nodes[edge.targetIndex];
        if (!srcNode || !tgtNode || !Array.isArray(srcNode.position) || !Array.isArray(tgtNode.position)) continue;
        if (type === 'sale' && !saleEnabled) continue;
        if (type === 'transfer' && !transferEnabled) continue;
        if (type === 'mint' && !mintEnabled) continue;
        if (type === 'mixed' && !mixedEnabled) continue;
        filtered.push(edge);
      }
      if (!filtered.length) return null;

      const limit = Math.max(1, Math.min(maxEdges, filtered.length));
      const data = filtered.slice(0, limit);
      const hasPath = data.some(e => Array.isArray(e.path) && e.path.length >= 2);
      const usePath = hasPath && typeof PathLayer === 'function';
      const FlowLayerCtor = usePath ? PathLayer : ArcLayer;
      if (typeof FlowLayerCtor !== 'function') return null;

      const fade = clamp(0.25 + zoomNorm * 0.75, 0, 1);
      const fallbackPath = (edge) => {
        const s = nodes[edge.sourceIndex]?.position;
        const t = nodes[edge.targetIndex]?.position;
        if (!Array.isArray(s) || !Array.isArray(t)) return null;
        const sp = [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
        const tp = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
        return [sp, tp];
      };

      const colorForEdge = (edge) => {
        const type = (edge.type || '').toString().toLowerCase();
        let base;
        if (type === 'sale') base = [255, 32, 64, 180];
        else if (type === 'mint') base = [255, 255, 255, 180];
        else if (type === 'transfer') base = [32, 128, 255, 160];
        else if (type === 'mixed') base = [160, 96, 255, 170];
        else base = [TOKENS.fg[0], TOKENS.fg[1], TOKENS.fg[2], 140];
        const alpha = Math.round(base[3] * fade);
        return [base[0], base[1], base[2], alpha];
      };

      const props = {
        id,
        data,
        coordinateSystem: COORDINATE_SYSTEM?.CARTESIAN,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        parameters: { blend: true, depthTest: false, blendFunc: [770, 1], blendEquation: 32774 },
        getWidth: edge => {
          const w = Math.sqrt(Math.max(1e-6, Number(edge.weight || edge.count || 1)));
          return 1 + Math.min(4, w);
        }
      };

      if (usePath){
        Object.assign(props, {
          getPath: edge => edge.path || fallbackPath(edge) || [],
          capRounded: true,
          jointRounded: true,
          dashJustified: true,
          getDashArray: edge => (edge.type === 'mint') ? [4, 3] : [1, 0],
          getColor: colorForEdge,
          updateTriggers: { getColor: [zoomNorm] }
        });
      } else {
        Object.assign(props, {
          getSourcePosition: edge => nodes[edge.sourceIndex]?.position || [0,0,0],
          getTargetPosition: edge => nodes[edge.targetIndex]?.position || [0,0,0],
          getSourceColor: colorForEdge,
          getTargetColor: colorForEdge,
          updateTriggers: { getSourceColor: [zoomNorm], getTargetColor: [zoomNorm] }
        });
      }

      return new FlowLayerCtor(props);
    } catch {
      return null;
    }
  }

  function makeTransfersLayers(base, opts = {}){
    try {
      const zoomNorm = Number.isFinite(opts?.zoomNorm) ? opts.zoomNorm : 1;
      const zoom = Number.isFinite(opts?.zoom) ? opts.zoom : currentZoom;
      const retained = [];
      let selectionLayer = null;
      if (Array.isArray(base)){
        for (const layer of base){
          if (!layer) continue;
          const id = layer.id;
          if (id === 'nodes' || id === 'glow' || id === 'pulses' || id === 'density') continue;
          if (id === 'selection-ring'){ selectionLayer = layer; continue; }
          retained.push(layer);
        }
      }
      const rhythm = buildRhythmLayers({ zoom, zoomNorm });
      const combined = [...rhythm.before, ...retained, ...rhythm.after];
      if (selectionLayer) combined.push(selectionLayer);
      return combined;
    } catch {
      return base;
    }
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
