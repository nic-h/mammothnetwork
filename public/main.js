// Minimal front-end per spec: PIXI v7 + three-panel shell

const stageEl = document.getElementById('stage');
const wrapEl = document.querySelector('.center-panel') || stageEl?.parentElement || document.body;
const modeEl = document.getElementById('mode');
const edgesEl = document.getElementById('edges-slider');
const ambientEdgesEl = document.getElementById('ambient-edges');
let focusMode = true; // enable highlight on selection by default
const legendEl = document.getElementById('legend');
const statusEl = null;
const traitsContainer = document.getElementById('traits-container');
const searchEl = document.getElementById('search');
// Optional preview token via URL (?token=1234)
var initialTokenParam = null; // var to be robust in older browsers
try {
  const qp = (typeof window!=='undefined' && window.location && window.location.search) ? window.location.search : '';
  const usp = new URLSearchParams(qp||'');
  const tok = usp.get('token');
  if (tok) initialTokenParam = Number(tok);
} catch {}
const sidebar = document.getElementById('sidebar');
const thumbEl = document.getElementById('thumb');
const detailsEl = document.getElementById('details');

let app, world, nodeContainer, circleTexture, edgesGfx, hullGfx, selectGfx, fxGfx;
let sprites = []; // PIXI.Sprite
let nodes = [];   // server nodes
let edgesData = [];
let idToIndex = new Map();
let worker = null; // disabled physics, keep ref for future
let preset = null;
let presetData = null;
let lastGraph = null;
let lastSelectedWalletMeta = null;
let rarityConstEdges = null; // cached constellation edges for traits view
const PRESET_MODE = { ownership: 'holders', trading: 'transfers', whales: 'wallets', frozen: 'holders', rarity: null, social: 'holders' };
let ethosMin = 0, ethosMax = 1;
let ownerCounts = null;
let highlightSet = null; // Set of ids currently highlighted by filter
let washSet = null; // suspicious wash trade tokens
let desireSet = null; // desire paths tokens
// Spatial index
let spatial = null; // { cell, map }
// Layout transition helpers
let layoutCapture = false; // when true, placeNode() collects into targetPositions instead of mutating sprites
let targetPositions = null; // captured positions for transition
// Centralized brand palette for colors
const BRAND = {
  GREEN: 0x00ff66,
  BLUE:  0x4488ff,
  GRAY:  0x666666,
  WHITE: 0xffffff,
  RED:   0xff3b3b,
  GOLD:  0xffd700,
};
// Edge style mapping (lightweight, perf-friendly)
const EDGE_STYLES = {
  OWNERSHIP:      { kind:'solid',  width:1.0,  color:BRAND.GREEN, opacity:0.9 },
  RECENT_TRADE:   { kind:'solid',  width:1.0,  color:0xff3333,   opacity:0.95 }, // aligns to SALE recent
  OLD_TRADE:      { kind:'dashed', width:0.6,  color:BRAND.GRAY, opacity:0.4 },
  RARE_TRAIT:     { kind:'dotted', width:0.6,  color:0xffaa00,   opacity:0.8 },
  HIGH_VALUE:     { kind:'solid',  width:1.5,  color:BRAND.GOLD, opacity:1.0 },
  SAME_WHALE:     { kind:'double', width:0.8,  color:0x00ccff,   opacity:0.8 }, // ETHOS_LINK like
  // Transaction styles (standardized)
  SALE:           { kind:'arrow',  width:1.0,  color:0xff3333,   opacity:0.95 },
  PURCHASE:       { kind:'arrow',  width:1.0,  color:BRAND.GREEN,opacity:0.95 },
  TRANSFER:       { kind:'dashed', width:0.8,  color:0xffcc00,   opacity:0.9 },
  MINT:           { kind:'dotted', width:0.6,  color:BRAND.WHITE,opacity:0.95 },
  MULTI:          { kind:'solid',  width:1.0,  color:BRAND.GOLD, opacity:0.95 },
};

// Utils
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function lerp(a,b,t){ return a + (b-a)*t; }
function throttle(fn, ms){ let last=0; let t=null; return function(...args){ const now=Date.now(); const run=()=>{ last=now; t=null; fn.apply(this,args); }; if (now-last>=ms){ if (t){ clearTimeout(t); t=null; } run(); } else if (!t){ t=setTimeout(run, ms-(now-last)); } }; }
const CURRENCY = 'TIA';
function fmtAmt(n){ if (n==null || !isFinite(n)) return '--'; const x=Math.round(n*100)/100; return x+" "+CURRENCY; }
function makeCircleTexture(renderer, r=5, color=BRAND.GREEN){
  const g = new PIXI.Graphics();
  g.lineStyle(1, color, 1.0).beginFill(color, 0.85).drawCircle(r, r, r).endFill();
  const t = renderer.generateTexture(g);
  g.destroy(true);
  return t;
}

async function init() {
  const w0 = Math.max(1, (wrapEl?.clientWidth||stageEl.clientWidth||800));
  const h0 = Math.max(1, (wrapEl?.clientHeight||stageEl.clientHeight||600));
  app = new PIXI.Application({ view: stageEl, backgroundColor:0x000000, antialias:true, resolution:Math.min(devicePixelRatio||1,2), width: w0, height: h0 });
  world = new PIXI.Container();
  app.stage.addChild(world);
  nodeContainer = new PIXI.ParticleContainer(10000, { position:true, scale:true, tint:true, alpha:true });
  world.addChild(nodeContainer);
  // Hulls (below nodes) and edges (below nodes, above hulls)
  hullGfx = new PIXI.Graphics();
  world.addChildAt(hullGfx, 0);
  edgesGfx = new PIXI.Graphics();
  world.addChild(edgesGfx);
  // background grid + overlay for selection ring + neighbor edges
  const gridGfx = new PIXI.Graphics();
  app.stage.addChildAt(gridGfx, 0);
  selectGfx = new PIXI.Graphics();
  world.addChild(selectGfx);
  fxGfx = new PIXI.Graphics();
  world.addChild(fxGfx);
  fxGfx = new PIXI.Graphics();
  world.addChild(fxGfx);
  circleTexture = makeCircleTexture(app.renderer, 4, BRAND.GREEN);

  // Resize to grid cell
  const drawGrid = ()=>{
    try{
      gridGfx.clear();
      const w = app.renderer.width, h = app.renderer.height;
      const step = 50;
      const c = BRAND.GREEN; const a = 0.12;
      gridGfx.lineStyle(1, c, a);
      for (let x=0;x<=w;x+=step){ gridGfx.moveTo(x,0); gridGfx.lineTo(x,h); }
      for (let y=0;y<=h;y+=step){ gridGfx.moveTo(0,y); gridGfx.lineTo(w,y); }
    }catch{}
  };
  try { new ResizeObserver(()=>{ const w=Math.max(1,(wrapEl?.clientWidth||stageEl.clientWidth||800)); const h=Math.max(1,(wrapEl?.clientHeight||stageEl.clientHeight||600)); app.renderer.resize(w, h); drawGrid(); }).observe(wrapEl||stageEl); } catch {}
  try {
    const obsEl = document.querySelector('.center-panel') || document.querySelector('.shell') || document.body;
    // On container resize, keep current positions; just resize renderer/grid and clamp view.
    new ResizeObserver(()=>{ try { drawGrid(); drawEdges(); clampWorldToContent(40); } catch {} }).observe(obsEl);
  } catch {}
  drawGrid();
  // Animation ticker for trading dashed offsets and FX
  try {
    let acc=0; app.ticker.add((dt)=>{
      acc += dt/60; if (acc>0.12){ acc=0; if (preset==='trading' && (ambientEdgesEl?.checked??true) && (world?.scale?.x||1) >= 0.35 && selectedIndex<0){ drawEdges(); } }
      updateFx(dt);
    });
  } catch {}
  // (removed duplicate ticker)

  // Load data and start (prefer ownership hierarchy by default)
  modeEl.value = 'holders';
  await load('holders', Number(edgesEl?.value||250));

  // Interactions
  // Install viewport controls (pan/zoom, zoom-at-cursor)
  const viewport = installViewport({ app, world, minScale:0.2, maxScale:5, onZoom: ()=>drawEdges() });
  stageEl.addEventListener('click', onStageClick);
  modeEl.addEventListener('change', ()=> load(modeEl.value, Number(edgesEl?.value||200)));
  // Layer toggles -> redraw edges and overlay
  try {
    const ids = ['layer-ownership','layer-trades','layer-traits','layer-value','layer-sales','layer-transfers','layer-mints','layer-bubbles','layer-wash','layer-desire'];
    ids.forEach(id=>{
      const el = document.getElementById(id);
      if (el){
        const row = el.closest('.layer-toggle');
        if (row) row.classList.toggle('active', !!el.checked);
        if (!el.dataset.bound){
          el.dataset.bound='1';
          el.addEventListener('change', ()=>{
            const r = el.closest('.layer-toggle'); if (r) r.classList.toggle('active', !!el.checked);
            if (el.id==='layer-wash' && el.checked && !washSet) fetchWash();
            if (el.id==='layer-desire' && el.checked && !desireSet) fetchDesire();
            drawEdges(); updateSelectionOverlay();
          });
        }
      }
    });
  } catch {}
  if (ambientEdgesEl && !ambientEdgesEl.dataset.bound) {
    ambientEdgesEl.dataset.bound='1';
    ambientEdgesEl.addEventListener('change', ()=>{ drawEdges(); updateSelectionOverlay(); });
  }
  if (edgesEl){
    const ec = document.getElementById('edge-count');
    edgesEl.addEventListener('input', ()=>{ if (ec) ec.textContent = String(edgesEl.value); load(modeEl.value, Number(edgesEl.value||200)); });
  }
  const clearBtn = document.getElementById('clear-search');
  if (clearBtn){
    clearBtn.addEventListener('click', ()=>{
      searchEl.value='';
      highlightSet = null; // clear any trait filter highlights
      selectedIndex = -1;  // clear selection
      clearSelectionOverlay();
      resetAlpha();
      try { resetView(); } catch {}
      searchEl.focus();
    });
  }
  window.addEventListener('keydown', (e)=>{
    if (e.key==='Escape'){
      selectedIndex = -1; clearSelectionOverlay(); resetAlpha();
      viewport.resetView();
    }
  });
  // Double-click resets selection and view
  stageEl.addEventListener('dblclick', ()=> { selectedIndex=-1; clearSelectionOverlay(); resetAlpha(); resetView(); });
  // Search: token id or wallet address
  searchEl.addEventListener('keydown', async e=>{
    if(e.key!=='Enter') return;
    const val = searchEl.value.trim();
    searchEl.value='';
    // ENS resolution
    if(/\.eth$/i.test(val)){
      try {
        const r = await fetch(`/api/resolve?q=${encodeURIComponent(val)}`).then(x=>x.json());
        if (r && r.address){
          const rr = await fetch(`/api/wallet/${r.address}`).then(x=>x.json());
          const ids = new Set((rr.tokens||[]).map(Number));
          for(let i=0;i<sprites.length;i++){
            const tid = sprites[i].__tokenId;
            const show = ids.has(Number(tid));
            sprites[i].alpha = show?0.95:0.08;
          }
          return;
        }
      } catch {}
    }
    if(/^0x[a-fA-F0-9]{40}$/.test(val)){
      try {
        const r = await fetch(`/api/wallet/${val}`).then(x=>x.json());
        const ids = new Set((r.tokens||[]).map(Number));
        for(let i=0;i<sprites.length;i++){
          const tid = sprites[i].__tokenId;
          const show = ids.has(Number(tid));
          sprites[i].alpha = show?0.95:0.08;
        }
      } catch {}
      return;
    }
    const id = Number(val);
    if(id>0){
      const idx = idToIndex.get(id);
      if (idx!=null) selectNode(idx);
    }
  });

  // Hover feedback
  stageEl.style.cursor = 'move';
  stageEl.addEventListener('mousemove', throttle((e)=>{
    if (!sprites.length) return;
    const rect = stageEl.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const scale = world.scale.x || 1;
    const wx = (sx - world.position.x) / scale;
    const wy = (sy - world.position.y) / scale;
    let best=-1, bestD2=Infinity;
    for(let i=0;i<sprites.length;i++){
      const s=sprites[i]; const dx=s.x-wx, dy=s.y-wy; const d2=dx*dx+dy*dy; if (d2<bestD2){bestD2=d2; best=i;}
    }
    for(let i=0;i<sprites.length;i++){ if (i!==selectedIndex) sprites[i].scale.set(1,1); }
    if (best>=0 && bestD2 < (10/scale)*(10/scale)) { sprites[best].scale.set(1.2,1.2); stageEl.style.cursor='pointer'; } else { stageEl.style.cursor='move'; }
  }, 60));

  // Presets
  setupPresets();
  // Mode chips -> sync with select and trigger loads
  try {
    const chips = document.querySelectorAll('.chip-btn[data-mode]');
    chips.forEach(btn=>{
      const m = btn.getAttribute('data-mode');
      if (m === modeEl.value) btn.classList.add('active');
      btn.addEventListener('click', async ()=>{
        chips.forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        if (modeEl) modeEl.value = m;
        await load(m, Number(edgesEl?.value||200));
      });
    });
  } catch {}
  // Default view: OWNERSHIP with solar layout
  try { document.querySelector('.preset-btn[data-preset="ownership"]').classList.add('active'); } catch {}
  preset = 'ownership';
  await ensurePresetData();
  applyPreset('ownership');
  layoutOwnershipSolar();
  if (legendEl) legendEl.textContent = 'Whale clusters center • Size = holdings • Green=profit • Red=loss • Cyan=high reputation';
  resetAlpha();
  resetView();
  setLegend(preset);
  // Preselect token by URL param (?token=1234)
  if (initialTokenParam && idToIndex && idToIndex.has(initialTokenParam)) {
    const idxP = idToIndex.get(initialTokenParam);
    try { selectNode(idxP); } catch {}
  }

  // Enable unified view selector behavior
  try { document.body.classList.add('view-selector-enabled'); } catch {}
  const viewEl = document.getElementById('view');
  if (viewEl && !viewEl.dataset.bound) {
    viewEl.dataset.bound = '1';
    // Tab buttons sync
    try {
      const tabs = Array.from(document.querySelectorAll('.tab-btn'));
      const setActive = (val)=>{ tabs.forEach(b=> b.classList.toggle('active', b.dataset.view===val)); };
      setActive(viewEl.value);
      tabs.forEach(btn=> btn.addEventListener('click', ()=>{ const v=btn.dataset.view; if (!v) return; setActive(v); viewEl.value=v; viewEl.dispatchEvent(new Event('change')); }));
    } catch {}
    viewEl.addEventListener('change', async ()=>{
      const v = viewEl.value;
      const edges = Number(edgesEl?.value||200);
      // edge group contextual open states
      const rel = document.querySelector('.edge-group[data-group="relationships"]');
      const trx = document.querySelector('.edge-group[data-group="transactions"]');
      const anal = document.querySelector('.edge-group[data-group="analysis"]');
      if (v === 'ownership') {
        modeEl.value = 'holders';
        await load('holders', edges);
        preset = 'ownership';
        await ensurePresetData();
        applyPreset('ownership');
        // Transition to ownership layout
        layoutCapture = true; targetPositions = new Array(sprites.length);
        layoutOwnershipSolar();
        layoutCapture = false; enforceSeparationPositions(targetPositions, 10, 1); animateToTargets(300);
        setLegend('ownership');
        rel?.classList.add('open'); trx?.classList.remove('open'); anal?.classList.remove('open');
      } else if (v === 'trading') {
        modeEl.value = 'transfers';
        await load('transfers', edges);
        preset = 'trading';
        await ensurePresetData();
        applyPreset('trading');
        layoutCapture = true; targetPositions = new Array(sprites.length);
        layoutPreset('trading');
        layoutCapture = false; enforceSeparationPositions(targetPositions, 9, 1); animateToTargets(300);
        setLegend('trading');
        rel?.classList.remove('open'); trx?.classList.add('open'); anal?.classList.remove('open');
        rarityConstEdges = null;
      } else if (v === 'traits') {
        modeEl.value = 'traits';
        await load('traits', edges);
        preset = 'rarity';
        await ensurePresetData();
        applyPreset('rarity');
        layoutCapture = true; targetPositions = new Array(sprites.length);
        layoutPreset('rarity');
        layoutCapture = false; enforceSeparationPositions(targetPositions, 8, 1); animateToTargets(300);
        setLegend('rarity');
        try { rarityConstEdges = computeConstellationEdges(300); } catch { rarityConstEdges = null; }
        rel?.classList.add('open'); trx?.classList.remove('open'); anal?.classList.add('open');
        document.querySelector('.traits-section')?.classList.add('open');
      } else if (v === 'whales') {
        modeEl.value = 'wallets';
        await load('wallets', edges);
        preset = 'whales';
        await ensurePresetData();
        applyPreset('whales');
        layoutCapture = true; targetPositions = new Array(sprites.length);
        layoutPreset('whales');
        layoutCapture = false; enforceSeparationPositions(targetPositions, 10, 1); animateToTargets(300);
        setLegend('whales');
        rel?.classList.add('open'); trx?.classList.add('open'); anal?.classList.remove('open');
        document.querySelector('.traits-section')?.classList.remove('open');
      } else if (v === 'health') {
        modeEl.value = 'holders';
        await load('holders', edges);
        preset = 'frozen';
        await ensurePresetData();
        applyPreset('frozen');
        layoutCapture = true; targetPositions = new Array(sprites.length);
        layoutPreset('frozen');
        layoutCapture = false; enforceSeparationPositions(targetPositions, 9, 1); animateToTargets(300);
        setLegend('frozen');
        rel?.classList.add('open'); trx?.classList.add('open'); anal?.classList.add('open');
        document.querySelector('.traits-section')?.classList.remove('open');
      }
      resetAlpha();
      resetView();
    });
  }

  // Tab buttons sync

  // Click handlers for collapsibles (traits and edge groups) and view tip
  try {
    const th = document.querySelector('.traits-header');
    if (th && !th.dataset.bound){
      th.dataset.bound='1';
      const toggleTraits = ()=>{
        const sec = document.querySelector('.traits-section');
        if (!sec) return;
        const open = sec.classList.toggle('open');
        th.setAttribute('aria-expanded', open? 'true' : 'false');
      };
      th.addEventListener('click', toggleTraits);
      th.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') { e.preventDefault(); toggleTraits(); } });
    }
    document.querySelectorAll('.edge-group').forEach(g=>{
      const h = g.querySelector('.edge-group-header');
      if (h && !h.dataset.bound){
        h.dataset.bound='1';
        const toggle = ()=>{ const open = g.classList.toggle('open'); h.setAttribute('aria-expanded', open? 'true' : 'false'); };
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') { e.preventDefault(); toggle(); } });
      }
    });
    const tip = document.getElementById('view-tip');
    const tipClose = document.getElementById('view-tip-close');
    const dismissed = typeof localStorage !== 'undefined' ? localStorage.getItem('viewTipDismissed') === '1' : true;
    if (tip && tipClose){ if (!dismissed) tip.hidden = false; tipClose.addEventListener('click', ()=>{ tip.hidden = true; try { localStorage.setItem('viewTipDismissed','1'); } catch {} }); }
    const moreBtn = document.getElementById('more-btn');
    const morePanel = document.getElementById('more-panel');
    if (moreBtn && morePanel && !moreBtn.dataset.bound){
      moreBtn.dataset.bound='1';
      const prefersReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const closeMenu = ()=>{ morePanel.hidden = true; moreBtn.setAttribute('aria-expanded','false'); };
      moreBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const isOpen = !morePanel.hidden;
        if (isOpen) closeMenu(); else { 
          morePanel.hidden = false; moreBtn.setAttribute('aria-expanded','true'); 
          const first = morePanel.querySelector('.menu-item'); if (first) first.focus();
        }
      });
      moreBtn.addEventListener('keydown', (e)=>{ if (e.key==='ArrowDown'){ const first = morePanel.querySelector('.menu-item'); if (first){ e.preventDefault(); if (morePanel.hidden){ morePanel.hidden=false; moreBtn.setAttribute('aria-expanded','true'); } first.focus(); } } });
      document.addEventListener('click', (e)=>{
        if (!morePanel.hidden && !morePanel.contains(e.target) && e.target !== moreBtn) closeMenu();
      });
      document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') { closeMenu(); try { moreBtn.focus(); } catch {} } });
      const items = Array.from(morePanel.querySelectorAll('.menu-item'));
      morePanel.addEventListener('keydown', (e)=>{
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        if (e.key==='ArrowDown'){ e.preventDefault(); const n = items[(i+1+items.length)%items.length]; n?.focus(); }
        if (e.key==='ArrowUp'){ e.preventDefault(); const p = items[(i-1+items.length)%items.length]; p?.focus(); }
        if (e.key==='Home'){ e.preventDefault(); items[0]?.focus(); }
        if (e.key==='End'){ e.preventDefault(); items[items.length-1]?.focus(); }
      });
      items.forEach(it=>{
        it.addEventListener('click', ()=>{
          const act = it.dataset.action;
          if (act === 'ambient'){
            const amb = document.getElementById('ambient-edges');
            if (amb){ amb.checked = !amb.checked; drawEdges(); updateSelectionOverlay(); }
          } else if (act === 'scroll'){
            const tgt = it.dataset.target;
            const panel = document.querySelector('.left-panel');
            let el = null;
            if (tgt === 'edges'){ el = document.querySelector('.edge-groups'); if (el) { try { el.closest('.edge-group')?.classList.add('open'); } catch {} } }
            if (tgt === 'traits'){ const ts = document.querySelector('.traits-section'); ts?.classList.add('open'); el = ts; }
            if (panel && el){
              try {
                el.scrollIntoView({ behavior: (prefersReduced ? 'auto' : 'smooth'), block:'start' });
              } catch {
                panel.scrollTop = el.offsetTop - 12;
              }
            }
          }
          closeMenu();
          try { moreBtn.focus(); } catch {}
        });
      });
    }
  } catch {}

  // Compute constellation edges once when entering traits view
  function computeConstellationEdges(maxEdges=300){
    const tk = presetData?.tokenTraitKey || [];
    if (!tk.length) return [];
    // frequency
    const freq = new Map(); for (let i=0;i<tk.length;i++){ const k=tk[i]; if (k>=0) freq.set(k,(freq.get(k)||0)+1); }
    const groups = new Map();
    for (let i=0;i<tk.length;i++){ const k=tk[i]; if (k<0) continue; const f=freq.get(k)||0; if (f>=3 && f<=30){ if (!groups.has(k)) groups.set(k,[]); groups.get(k).push(i); } }
    const edges = [];
    for (const [k, list] of groups){
      if (list.length<3) continue;
      // centroid
      let sx=0, sy=0; for (const i of list){ sx+=sprites[i].x; sy+=sprites[i].y; }
      const cx=sx/list.length, cy=sy/list.length;
      // sort by angle and connect ring
      const ordered = list.map(i=>({i, ang: Math.atan2(sprites[i].y-cy, sprites[i].x-cx)})).sort((a,b)=>a.ang-b.ang).map(o=>o.i);
      for (let j=0;j<ordered.length && edges.length<maxEdges; j++){
        const a = ordered[j], b = ordered[(j+1)%ordered.length];
        edges.push([a,b]);
        if (edges.length>=maxEdges) break;
      }
      if (edges.length>=maxEdges) break;
    }
    return edges;
  }
}

async function load(mode, edges){
  const data = await fetchGraph(mode, edges).catch(()=> lastGraph || {nodes:[],edges:[]});
  nodes = data.nodes||[]; edgesData = data.edges||[];
  buildSprites(nodes.map(n=>n.color||BRAND.GREEN));
  rebuildSpatial();
  if (mode === 'transfers') {
  try {
    const det = await fetch(`/api/transfer-edges?limit=${encodeURIComponent(edges||200)}&nodes=10000`, { cache:'no-store' }).then(r=>r.json());
    if (Array.isArray(det) && det.length) edgesData = det;
  } catch {}
  }
  // If no nodes loaded, attempt a recovery fetch
  if (!nodes || !nodes.length) {
    try {
      const r = await fetch(`/api/network-graph?mode=holders&nodes=10000&edges=0&v=${Date.now()}`, { cache:'no-store' });
      if (r.ok) {
        const j = await r.json();
        nodes = j.nodes||[]; edgesData = j.edges||[]; lastGraph = j;
        buildSprites(nodes.map(n=>n.color||BRAND.GREEN));
      }
    } catch {}
    // Still empty: only log to console (no UI banner per design)
    if (!nodes || !nodes.length) {
      try { const h = await fetch('/api/health', { cache:'no-store' }).then(r=>r.json()); console.warn('No nodes loaded', h); } catch {}
    }
  }
  // No physics: static grid layout
  layoutGrid();
  rebuildSpatial();
  resetView();
  // Traits list (build groups)
  await loadTraits();
  // Re-apply preset coloring/forces after reload
  if (preset) {
    await ensurePresetData();
    applyPreset(preset);
  }
  rebuildSpatial();
}

async function fetchGraph(mode, edges){
  const q = new URLSearchParams({ mode, edges:String(edges), nodes:'10000' });
  const r = await fetch(`/api/graph?${q}`, { cache: 'default' }).catch(()=>null);
  if(!r) throw new Error('graph fetch failed');
  if (r.status === 304) { if (!lastGraph) throw new Error('not-modified'); return lastGraph; }
  if(!r.ok) throw new Error('graph fetch failed');
  const j = await r.json();
  lastGraph = j;
  return j;
}

function buildSprites(colors){
  // clear
  sprites.forEach(s=>s.destroy()); sprites=[]; nodeContainer.removeChildren(); idToIndex = new Map();
  const count = Math.min(colors.length, 10000);
  for(let i=0;i<count;i++){
    const sp = new PIXI.Sprite(circleTexture);
    sp.anchor.set(0.5);
    sp.tint = colors[i]||BRAND.GREEN;
    sp.alpha=0.95;
    sp.scale.set(1,1);
    sp.x=0; sp.y=0;
    const tokenId = nodes[i]?.id ?? (i+1);
    sp.__tokenId = tokenId;
    sprites.push(sp);
    if (tokenId!=null) idToIndex.set(Number(tokenId), i);
  }
  nodeContainer.addChild(...sprites);
}

// Static grid layout (no physics)
function layoutGrid(){
  const n = sprites.length; if (!n) return;
  const cols = Math.ceil(Math.sqrt(n));
  const maxDim = Math.max(200, Math.min(app.renderer.width, app.renderer.height) - 160);
  const gap = Math.max(8, Math.min(20, maxDim/cols));
  const rows = Math.ceil(n / cols);
  // compute total size to center
  const w = (cols-1)*gap;
  const h = (rows-1)*gap;
  const ox = -w/2, oy = -h/2;
  for (let i=0;i<n;i++){
    const c = i % cols; const r = Math.floor(i / cols);
    placeNode(i, ox + c*gap + app.renderer.width/2, oy + r*gap + app.renderer.height/2);
  }
  enforceSeparation(Math.max(8, gap*0.9));
  drawEdges();
  clearSelectionOverlay();
}

// Lightweight non-overlap relaxer using spatial hashing (grid-based)
function enforceSeparation(minDist=10, passes=2){
  try{
    const cell = Math.max(6, Math.floor(minDist));
    for (let p=0; p<passes; p++){
      const map = new Map();
      for (let i=0;i<sprites.length;i++){
        const s = sprites[i];
        const gx = Math.floor(s.x / cell), gy = Math.floor(s.y / cell);
        const key = gx+','+gy;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(i);
      }
      for (const [key, list] of map){
        const [gx,gy] = key.split(',').map(Number);
        // neighbor cells including self
        for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++){
          const nb = map.get((gx+dx)+","+(gy+dy)); if (!nb) continue;
          for (let a of list){ for (let b of nb){ if (b<=a) continue; const sa=sprites[a], sb=sprites[b]; const dx2=sb.x-sa.x, dy2=sb.y-sa.y; const d2=dx2*dx2+dy2*dy2; if (d2>0 && d2 < minDist*minDist){ const d=Math.sqrt(d2); const push=(minDist-d)/2; const ux=dx2/d, uy=dy2/d; sa.x-=ux*push; sa.y-=uy*push; sb.x+=ux*push; sb.y+=uy*push; } } }
        }
      }
    }
  } catch {}
}

// Assign or capture a node position (used by transitions)
function placeNode(i, x, y){
  if (layoutCapture){ if (!targetPositions) targetPositions = new Array(sprites.length); targetPositions[i] = {x,y}; }
  else { const s = sprites[i]; s.x = x; s.y = y; }
}

function enforceSeparationPositions(pos, minDist=10, passes=1){
  try{
    const cell = Math.max(6, Math.floor(minDist));
    for (let p=0;p<passes;p++){
      const map = new Map();
      for (let i=0;i<pos.length;i++){ const pt=pos[i]; if (!pt) continue; const gx=Math.floor(pt.x/cell), gy=Math.floor(pt.y/cell); const key=gx+','+gy; if (!map.has(key)) map.set(key,[]); map.get(key).push(i); }
      for (const [key, list] of map){ const [gx,gy]=key.split(',').map(Number); for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++){ const nb=map.get((gx+dx)+','+(gy+dy)); if (!nb) continue; for (const a of list){ for (const b of nb){ if (b<=a) continue; const pa=pos[a], pb=pos[b]; if (!pa||!pb) continue; const dx2=pb.x-pa.x, dy2=pb.y-pa.y; const d2=dx2*dx2+dy2*dy2; if (d2>0 && d2<minDist*minDist){ const d=Math.sqrt(d2); const push=(minDist-d)/2; const ux=dx2/d, uy=dy2/d; pa.x-=ux*push; pa.y-=uy*push; pb.x+=ux*push; pb.y+=uy*push; } } } }
      }
    }
  } catch {}
}

function animateToTargets(duration=300){
  if (!targetPositions) return;
  const starts = sprites.map(s=>({x:s.x,y:s.y}));
  const t0 = performance.now ? performance.now() : Date.now();
  const ease = t=> t<0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
  const tick = ()=>{
    const now = performance.now ? performance.now() : Date.now();
    const u = Math.min(1, (now - t0)/duration);
    const e = ease(u);
    for (let i=0;i<sprites.length;i++){ const to=targetPositions[i]; if (!to) continue; const st=starts[i]; sprites[i].x = st.x + (to.x - st.x)*e; sprites[i].y = st.y + (to.y - st.y)*e; }
    drawEdges();
    if (u<1) requestAnimationFrame(tick); else { targetPositions=null; }
  };
  requestAnimationFrame(tick);
}

function rebuildSpatial(cell=24){
  try {
    spatial = { cell, map: new Map() };
    for (let i=0;i<sprites.length;i++){
      const s = sprites[i]; const gx=Math.floor(s.x/cell), gy=Math.floor(s.y/cell); const key=gx+','+gy;
      if (!spatial.map.has(key)) spatial.map.set(key, []);
      spatial.map.get(key).push(i);
    }
  } catch {}
}
function querySpatial(x, y, radius){
  if (!spatial || !spatial.map) return [...Array(sprites.length).keys()];
  const cell = spatial.cell; const gx=Math.floor(x/cell), gy=Math.floor(y/cell); const r=Math.ceil(radius/cell);
  const out=[]; for (let dx=-r; dx<=r; dx++) for (let dy=-r; dy<=r; dy++){ const key=(gx+dx)+','+(gy+dy); const a=spatial.map.get(key); if (a) out.push(...a); }
  return out;
}

// Ownership solar layout defined below (replaces old clusters)
function layoutOwnershipSolar(){
  const n = sprites.length; if (!n) return;
  const ownerIdxArr = presetData?.ownerIndex || [];
  const byOwner = new Map();
  for (let i=0;i<n;i++){ const oi = ownerIdxArr[i] ?? -1; if (oi>=0){ if (!byOwner.has(oi)) byOwner.set(oi, []); byOwner.get(oi).push(i); } }
  const owners = Array.from(byOwner.entries()).sort((a,b)=> (b[1].length - a[1].length));
  const cx = app.renderer.width/2, cy = app.renderer.height/2;
  const whaleCount = Math.min(5, owners.length);
  const hubs = new Map();
  for (let k=0; k<owners.length; k++){
    const [oi, idxs] = owners[k]; const hold = idxs.length;
    let hx, hy;
    if (k < whaleCount && hold > 20){
      const ang = (k / whaleCount) * Math.PI*2 - Math.PI/2;
      hx = cx + Math.cos(ang) * 180; hy = cy + Math.sin(ang) * 160;
    } else if (hold > 5){
      const ang = (k / Math.max(8, owners.length)) * Math.PI*2;
      hx = cx + Math.cos(ang) * 380; hy = cy + Math.sin(ang) * 320;
    } else {
      const ang = (k / Math.max(12, owners.length)) * Math.PI*2;
      const r  = 520 + (k%5)*60; hx = cx + Math.cos(ang) * r; hy = cy + Math.sin(ang) * r;
    }
    hubs.set(oi, {x:hx,y:hy,hold});
  }
  for (const [oi, idxs] of owners){
    const hub = hubs.get(oi); if (!hub) continue; const hold = idxs.length;
    let orbitBase = hold>20? 26 : hold>5? 18 : 12;
    for (let i=0;i<idxs.length;i++){
      const sp = sprites[idxs[i]]; if (!sp) continue;
      if (i===0){ placeNode(idxs[i], hub.x, hub.y); sp.scale.set(hold>50?3.0:(hold>20?2.2:(hold>5?1.5:1.0))); }
      else {
        const level = Math.floor(Math.log2(i+1)); const ang = ((i*0.618)%1) * Math.PI*2; const rad = orbitBase + level * (hold>20? 20:14);
        placeNode(idxs[i], hub.x + Math.cos(ang) * rad, hub.y + Math.sin(ang) * rad); sp.scale.set(0.8);
      }
      const ethos = presetData?.ownerEthos?.[oi] ?? null; const pnl = presetData?.ownerPnl?.[oi] ?? 0;
      if (pnl > 0) sp.tint = 0x00ff66; else if (pnl < 0) sp.tint = 0xff6644; else if (ethos && ethos > 1500) sp.tint = 0x66ddff; else sp.tint = 0x227744;
    }
  }
  enforceSeparation(10);
  drawEdges();
}

function drawEdges(){
  try {
    const maxDraw = 500;
    edgesGfx.clear();
    try { hullGfx.clear(); } catch {}
    try { if (fxGfx) fxGfx.clear(); } catch {}
    const s = world?.scale?.x || 1;
    // LOD: keep edges visible more often; only skip when very far out
    if (s < 0.35) return;
    // If a node is selected, defer to selection overlay only (avoid clutter)
    if (selectedIndex >= 0) return;
    // Ambient toggle: when off, skip drawing ambient edges
    if (ambientEdgesEl && !ambientEdgesEl.checked) return;
    const mode = modeEl?.value || 'holders';
    // Draw trading heat bands in hull layer for readability
    if (preset === 'trading'){
      try {
        const pad = 80; const bands = 5;
        // compute world-space rect covering the viewport
        const w = app.renderer.width, h = app.renderer.height;
        const x1 = (pad - world.position.x) / s;
        const x2 = ((w - pad) - world.position.x) / s;
        const y1 = (pad - world.position.y) / s;
        const y2 = ((h - pad) - world.position.y) / s;
        const bh = (y2 - y1) / bands;
        for (let i=0;i<bands;i++){
          const yb = y1 + i*bh;
          const alpha = 0.04 + (i%2?0.02:0);
          hullGfx.beginFill(0x00ff66, alpha);
          hullGfx.drawRect(x1, yb, (x2-x1), bh*0.9);
          hullGfx.endFill();
        }
      } catch {}
    }
    // Constellation lines in traits mode (precomputed pairs)
    if (preset === 'rarity' && Array.isArray(rarityConstEdges) && rarityConstEdges.length){
      try {
        for (let k=0;k<rarityConstEdges.length;k++){
          const [i,j] = rarityConstEdges[k];
          const x1 = sprites[i].x, y1 = sprites[i].y; const x2 = sprites[j].x, y2 = sprites[j].y;
          lineDashed(hullGfx, x1, y1, x2, y2, { width:0.8, color:0xffd700, opacity:0.6 }, 4, 4, 0);
        }
      } catch {}
    }
    // Overlay markers: wash trades (red ring) and desire paths (gold star)
    try {
      const showWash = !!document.getElementById('layer-wash')?.checked;
      const showDesire = !!document.getElementById('layer-desire')?.checked;
      if (fxGfx && (showWash || showDesire)){
        for (let i=0;i<sprites.length;i++){
          const tid = sprites[i].__tokenId;
          if (showWash && washSet && washSet.has(Number(tid))){ fxGfx.lineStyle({ width:1.5, color:0xff3333, alpha:0.95 }); fxGfx.drawCircle(sprites[i].x, sprites[i].y, 11); }
          if (showDesire && desireSet && desireSet.has(Number(tid))){ drawStar(fxGfx, sprites[i].x+10, sprites[i].y-10, 5, BRAND.GOLD); }
        }
      }
    } catch {}
    // Ownership: draw optional hulls (desktop-only, ambient-gated), then hub→child tree edges
    if (mode === 'holders'){
      // Hulls: only on desktop (hover:fine) and when ambient edges are enabled, and when no selection
      try {
        const isDesktop = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (isDesktop && (!ambientEdgesEl || ambientEdgesEl.checked) && selectedIndex < 0){
          drawOwnershipHulls();
        }
      } catch {}
      const ownerIdxArr = presetData?.ownerIndex || [];
      const clusters = new Map();
      const n = sprites.length;
      for (let i=0;i<n;i++){ const oi = ownerIdxArr[i]??-1; if (oi>=0){ if(!clusters.has(oi)) clusters.set(oi, []); clusters.get(oi).push(i); } }
      clusters.forEach(tokens => {
        if (!tokens || tokens.length<2) return;
        const hub = sprites[tokens[0]]; if (!hub) return;
        const width = tokens.length>20 ? 1.2 : 0.6;
        for (let k=1;k<tokens.length;k++){
          const child = sprites[tokens[k]]; if (!child) continue;
          const x1 = hub.x, y1 = hub.y; const x2 = child.x, y2 = child.y;
          const mx = (x1+x2)/2; const my = (y1+y2)/2 - 12; // subtle curve
          edgesGfx.lineStyle({ width, color: 0x00ff66, alpha: 0.28, cap:'round' });
          edgesGfx.moveTo(x1, y1);
          edgesGfx.quadraticCurveTo(mx, my, x2, y2);
        }
      });
      return;
    }
    if ((edgesData?.length||0) && edgesData.length <= maxDraw) {
      // scale factors for width/alpha based on zoom (gentler falloff)
      const aF = Math.max(0, Math.min(1, (s - 0.3) / 0.8));
      const wF = 0.8 + aF * 0.6; // slightly thicker so dashed/dotted remain visible
      for (let e=0;e<edgesData.length;e++){
        const item = edgesData[e];
        const a = Array.isArray(item)? item[0] : (item.a ?? item.source ?? item.from ?? 0);
        const b = Array.isArray(item)? item[1] : (item.b ?? item.target ?? item.to   ?? 0);
        const i = idToIndex.get(Number(a));
        const j = idToIndex.get(Number(b));
        if (i==null || j==null) continue;
        const x1 = sprites[i].x, y1 = sprites[i].y;
        const x2 = sprites[j].x, y2 = sprites[j].y;
        let style = pickEdgeStyle(mode, i, j, item);
        if (!layerEnabled(style, item)) continue;
        // Ambient edges: still light, but ensure patterns are readable
        const baseW = (style.kind==='dotted'||style.kind==='dashed'||style.kind==='arrow') ? 0.9 : 0.6;
        const minW = (style.kind==='dotted'||style.kind==='dashed') ? 0.8 : 0.5;
        const alphaBoost = (style.kind==='dotted'||style.kind==='dashed'||style.kind==='arrow') ? 0.35 : 0.25;
        style = {
          ...style,
          width: Math.max(minW, Math.min(1.8, (style.width || baseW) * wF)),
          opacity: Math.max(0.12, (style.opacity ?? 0.8) * alphaBoost)
        };
        strokeEdge(edgesGfx, x1, y1, x2, y2, style);
      }
    }
  } catch {}
}

// FX: simple bubbles for whales tier (recent activity)
let bubbles = [];
function updateFx(dt){
  try {
    if (!fxGfx) return;
    fxGfx.clear();
    if (preset !== 'whales') return;
    const bubblesOn = !!document.getElementById('layer-bubbles')?.checked;
    if (!bubblesOn) return;
    // Spawn lightly
    if (Math.random() < 0.12) spawnBubble();
    // Update
    const toKeep = [];
    for (let i=0;i<bubbles.length;i++){
      const b = bubbles[i]; b.y -= b.vy; b.alpha -= 0.005; b.r += 0.02; if (b.alpha>0.02){ toKeep.push(b); }
      fxGfx.lineStyle({ width:1, color:0x66ddff, alpha:Math.max(0, b.alpha) });
      fxGfx.drawCircle(b.x, b.y, b.r);
    }
    bubbles = toKeep.slice(0, 100);
  } catch {}
}
function spawnBubble(){
  try {
    const ownerIndex = presetData?.ownerIndex || []; const tokenLast = presetData?.tokenLastActivity || [];
    const counts = ownerCounts || [];
    const whales = [];
    const vols = {}; // owner volume weighting
    const buy = presetData?.ownerBuyVol || []; const sell = presetData?.ownerSellVol || [];
    for (let i=0;i<ownerIndex.length;i++){ const oi=ownerIndex[i]; if (oi>=0 && (counts[oi]||0)>50){ const last=tokenLast[i]||0; const days = last? ((Date.now()/1000 - last)/86400) : 999; if (days<30){ whales.push(i); const v=(buy[oi]||0)+(sell[oi]||0); vols[oi]=v; } } }
    if (!whales.length) return;
    const pick = whales[Math.floor(Math.random()*whales.length)]; const s = sprites[pick]; if (!s) return;
    const oi = ownerIndex[pick]; const weight = Math.min(1, ((vols[oi]||0)/Math.max(1, Math.max(...Object.values(vols)||[1]))));
    bubbles.push({ x:s.x + (Math.random()-0.5)*6, y:s.y - 6, vy: 0.6+Math.random()*0.8*weight, r: 2+Math.random()*2, alpha: 0.4+0.5*weight });
  } catch {}
}

// Draw subtle translucent hulls around top owner clusters (desktop-only)
function drawOwnershipHulls(){
  try {
    const ownerIdxArr = presetData?.ownerIndex || [];
    const byOwner = new Map();
    for (let i=0;i<sprites.length;i++){
      const oi = ownerIdxArr[i] ?? -1; if (oi<0) continue;
      if (!byOwner.has(oi)) byOwner.set(oi, []);
      byOwner.get(oi).push(i);
    }
    const clusters = Array.from(byOwner.entries()).sort((a,b)=> (b[1].length - a[1].length)).slice(0, 12);
    for (const [oi, idxs] of clusters){
      if (idxs.length < 4) continue;
      // compute centroid
      let sx=0, sy=0; for (const i of idxs){ sx += sprites[i].x; sy += sprites[i].y; }
      const cx = sx/idxs.length, cy = sy/idxs.length;
      // compute radius as quantile distance
      const dists = idxs.map(i=> Math.hypot(sprites[i].x - cx, sprites[i].y - cy)).sort((a,b)=>a-b);
      const r = (dists[Math.floor(dists.length*0.8)] || 20) * 1.15 + 18;
      // draw soft ring (fill + stroke) with brand green
      hullGfx.lineStyle({ width: 1, color: 0x00ff66, alpha: 0.18, cap:'round' });
      hullGfx.beginFill(0x00ff66, 0.035);
      hullGfx.drawCircle(cx, cy, r);
      hullGfx.endFill();
    }
  } catch {}
}

function pickEdgeStyle(mode, i, j, item){
  // Prefer explicit type if provided
  const type = (item && typeof item==='object' && item.type) ? String(item.type).toUpperCase() : null;
  if (type && EDGE_STYLES[type]) {
    const count = Number(item.count||item.weight||0);
    if (count>=3) return { ...EDGE_STYLES.MULTI, width: Math.min(1.2, 0.6 + Math.log2(count+1)*0.2) };
    return EDGE_STYLES[type];
  }
  // Infer from mode + recency/price when possible
  if (mode === 'holders') return EDGE_STYLES.OWNERSHIP;
  if (mode === 'wallets') return EDGE_STYLES.SAME_WHALE;
  if (mode === 'traits')  return EDGE_STYLES.RARE_TRAIT;
  if (mode === 'transfers'){
    const now = Math.floor(Date.now()/1000);
    const la = (presetData?.tokenLastActivity?.[i] || 0);
    const lb = (presetData?.tokenLastActivity?.[j] || 0);
    const last = Math.max(la, lb);
    const days = last? (now-last)/86400 : 9999;
    if (days <= 14) return EDGE_STYLES.RECENT_TRADE;
    return EDGE_STYLES.OLD_TRADE;
  }
  return EDGE_STYLES.OWNERSHIP;
}

function strokeEdge(g, x1, y1, x2, y2, st){
  const s = st || EDGE_STYLES.OWNERSHIP;
  const baseW = Math.max(0.3, Math.min(1.2, s.width||0.6));
  if (s.kind === 'double'){
    const nx = y2 - y1, ny = -(x2 - x1);
    const len = Math.max(1, Math.hypot(nx, ny));
    const off = Math.max(1, s.width*1.2);
    const ox = (nx/len)*off, oy = (ny/len)*off;
    lineSolid(g, x1-ox, y1-oy, x2-ox, y2-oy, s);
    lineSolid(g, x1+ox, y1+oy, x2+ox, y2+oy, s);
    return;
  }
  const t = (performance.now? performance.now(): Date.now()) * 0.001;
  const offset = (preset==='trading') ? (t*40) : 0;
  if (s.kind === 'dashed') return lineDashed(g, x1, y1, x2, y2, { ...s, width: baseW }, 8, 6, offset);
  if (s.kind === 'dotted') return lineDashed(g, x1, y1, x2, y2, { ...s, width: baseW }, 2, 4, offset);
  if (s.kind === 'arrow')  return lineArrow(g, x1, y1, x2, y2, { ...s, width: baseW });
  return lineSolid(g, x1, y1, x2, y2, { ...s, width: baseW });
}

function lineSolid(g, x1, y1, x2, y2, s){
  g.lineStyle({ width:s.width||0.6, color:s.color||BRAND.GREEN, alpha:s.opacity??0.8, cap:'round' });
  g.moveTo(x1, y1); g.lineTo(x2, y2);
}

function lineDashed(g, x1, y1, x2, y2, s, dash=6, gap=4, offset=0){
  const dx = x2-x1, dy = y2-y1; const len = Math.hypot(dx,dy);
  const ux = dx/len, uy = dy/len;
  // Keep dash pattern legible across zoom levels
  const z = (world?.scale?.x || 1);
  const d = Math.max(4, dash * (1/z));
  const gsz = Math.max(3, gap * (1/z));
  g.lineStyle({ width:s.width||0.8, color:s.color||BRAND.GRAY, alpha:s.opacity??0.7, cap:'butt' });
  let dist = ((offset % (d+gsz)) + (d+gsz)) % (d+gsz);
  let cx = x1 + ux*dist, cy = y1 + uy*dist;
  let on=true;
  while (dist < len){
    const step = on? d : gsz; const nx = cx + ux*step; const ny = cy + uy*step;
    if (on){ g.moveTo(cx, cy); g.lineTo(Math.min(nx, x2), Math.min(ny, y2)); }
    cx = nx; cy = ny; dist += step; on = !on;
  }
}

function lineArrow(g, x1, y1, x2, y2, s){
  const w = Math.max(0.9, s.width || 0.9);
  g.lineStyle({ width:w, color:s.color||BRAND.RED, alpha:s.opacity??0.95, cap:'round' });
  g.moveTo(x1, y1); g.lineTo(x2, y2);
  const dx = x2 - x1, dy = y2 - y1; const len = Math.hypot(dx, dy) || 1;
  const ux = dx/len, uy = dy/len;
  const z = (world?.scale?.x || 1);
  const size = Math.max(10, Math.min(16, (10*w+4) * (1/z)));
  const bx = x2 - ux*size, by = y2 - uy*size;
  const nx = -uy, ny = ux;
  g.lineStyle({ width:w, color:s.color||BRAND.RED, alpha:s.opacity??0.95, join:'miter' });
  g.moveTo(x2, y2); g.lineTo(bx + nx*(size*0.4), by + ny*(size*0.4));
  g.moveTo(x2, y2); g.lineTo(bx - nx*(size*0.4), by - ny*(size*0.4));
  // Pulse overlay for trading view
  try {
    if (preset==='trading'){
      const t = (performance.now? performance.now(): Date.now()) * 0.001;
      const offset = (t*80) % Math.max(8, len*0.2);
      lineDashed(g, x1, y1, x2, y2, { width: Math.max(0.6, w*0.6), color: 0xffaa66, opacity: 0.9 }, 6, 10, offset);
    }
  } catch {}
}

function clearSelectionOverlay(){ selectGfx?.clear?.(); }
// Map style or transaction type to layer toggles
function layerEnabled(style, item){
  try {
    const q = id => document.getElementById(id);
    const sales = q('layer-sales');
    const transfers = q('layer-transfers');
    const mints = q('layer-mints');
    const own = q('layer-ownership');
    const trd = q('layer-trades');
    const rar = q('layer-traits');
    const val = q('layer-value');
    const t = (item && item.type) ? String(item.type).toLowerCase() : null;
    if (t){
      if (t==='sale' || t==='purchase') return sales ? !!sales.checked : true;
      if (t==='transfer') return transfers ? !!transfers.checked : true;
      if (t==='mint') return mints ? !!mints.checked : true;
      if (t==='mixed') return ((sales?!!sales.checked:false) || (transfers?!!transfers.checked:false));
    }
    // Fallback by style mapping
    if (!style) return true;
    if (style === EDGE_STYLES.OWNERSHIP) return own ? !!own.checked : true;
    if (style === EDGE_STYLES.RARE_TRAIT) return rar ? !!rar.checked : true;
    if (style === EDGE_STYLES.HIGH_VALUE) return val ? !!val.checked : true;
    if (style === EDGE_STYLES.RECENT_TRADE || style === EDGE_STYLES.OLD_TRADE) return trd ? !!trd.checked : true;
  } catch {}
  return true;
}
function setLegend(p){
  if (!legendEl) return;
  const text = {
    ownership: 'Color by wallet type; size by hold days; PnL pulls inward.',
    trading: 'X=recent sale, Y=turnover; Red arrows=sales, dashed=transfers, dotted=mints.',
    rarity: 'Spiral by rarity; size by last sale; highlight active rares.',
    social: 'Radial by Ethos; color blends PnL (red loss/blue profit).',
    whales: 'Proximity/size by wallet volume; whale types colored.',
    frozen: 'Blue=frozen, Gray=dormant, Green=active; alpha by recent sale.'
  }[p] || '';
  legendEl.textContent = text;
}

// Pan/zoom now handled by installViewport() in viewport.js

// Selection
function onStageClick(e){
  const rect = stageEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const scale = world.scale.x || 1;
  const wx = (sx - world.position.x) / scale;
  const wy = (sy - world.position.y) / scale;
  let best=-1, bestD2=Infinity;
  for(let i=0;i<sprites.length;i++){
    const s=sprites[i];
    const dx=s.x-wx, dy=s.y-wy; const d2=dx*dx+dy*dy;
    if(d2<bestD2){bestD2=d2; best=i;}
  }
  const pxTol = 8; // tolerance in screen pixels
  const worldTol2 = (pxTol/scale)*(pxTol/scale);
  if(best>=0 && bestD2 <= worldTol2) selectNode(best);
}

async function selectNode(index){
  const id = sprites[index]?.__tokenId || (index+1);
  // Ensure right panel is visible; always-on layout
  if (selectedIndex>=0 && sprites[selectedIndex]) sprites[selectedIndex].scale.set(1,1);
  selectedIndex = index;
  if (sprites[selectedIndex]) sprites[selectedIndex].scale.set(1.6,1.6);
  updateSelectionOverlay();
  let t = null;
  try {
    t = await fetch(`/api/token/${id}?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.json());
    if (t && (t.thumbnail_local||t.image_local)) {
      thumbEl.style.display='block';
      const primary = `/${t.thumbnail_local||t.image_local}`;
      thumbEl.onerror = ()=>{ thumbEl.onerror=null; thumbEl.src = `/thumbnails/${id}.jpg`; };
      thumbEl.src = primary;
    } else {
      // fallback to /thumbnails/{id}.jpg
      thumbEl.style.display='block';
      thumbEl.onerror = ()=>{ thumbEl.onerror=null; thumbEl.style.display='none'; };
      thumbEl.src = `/thumbnails/${id}.jpg`;
    }
    let meta = null;
    try { if (t.owner) meta = await fetch(`/api/wallet/${t.owner}/meta?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.json()); } catch {}
    lastSelectedWalletMeta = meta || null;
    const ethos = (meta && meta.ethos_score!=null) ? meta.ethos_score : null;
    const cred = (meta && meta.ethos_credibility!=null) ? meta.ethos_credibility : null;
    let ens = meta?.ens_name || null;
    if (ens && /^0x[a-fA-F0-9]{40}$/.test(ens)) ens = null; // avoid address shown twice
    // same-owner holdings (for WHALES/OWNERSHIP context and overlay)
    let holdings = null;
    try { if (t.owner) { const w = await fetch(`/api/wallet/${t.owner}?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.json()); holdings = w?.tokens || null; } } catch {}
    selectedWalletSet = holdings ? new Set(holdings.map(Number)) : null;
    updateSelectionOverlay();
    if (focusMode) applyFocus();
    // Center view on selected sprite (avoid dependency on viewport local var)
    try { centerOn(sprites[selectedIndex].x, sprites[selectedIndex].y, 1.2); } catch {}
    // rarity score from preset data
    await ensurePresetData();
    const idx2 = idToIndex.get(id);
    const rScore = (idx2!=null && presetData?.rarity) ? presetData.rarity[idx2] : null;
    const addrShort = (t.owner||'--').slice(0,6)+'...'+(t.owner||'').slice(-4);
    const ethosValid = (typeof ethos==='number' && ethos>0);
    const ethosBar = ethosValid ? '█'.repeat(Math.min(10, Math.round((ethos-ethosMin)/(ethosMax-ethosMin)*10))) + '░'.repeat(10 - Math.min(10, Math.round((ethos-ethosMin)/(ethosMax-ethosMin)*10))) : '';
    const trades = meta?.trade_count ?? null;
    const actLabel = trades!=null ? (trades>40?'Very Active':trades>10?'Active':'Low') : '';
    const lastSeen = meta?.last_activity ? timeAgo(meta.last_activity*1000) : 'Never traded';
    // Wallet volumes and PnL (TIA)
    const buyVol = (meta && meta.buy_volume_tia!=null) ? Number(meta.buy_volume_tia) : null;
    const sellVol = (meta && meta.sell_volume_tia!=null) ? Number(meta.sell_volume_tia) : null;
    const pnlTIA = (meta && meta.realized_pnl_tia!=null) ? Number(meta.realized_pnl_tia) : null;
    const avgBuy = (meta && meta.avg_buy_tia!=null) ? Number(meta.avg_buy_tia) : null;
    const avgSell = (meta && meta.avg_sell_tia!=null) ? Number(meta.avg_sell_tia) : null;
    const status = t.frozen ? 'FROZEN' : (t.dormant ? 'DORMANT' : 'ACTIVE');
    // Listings + advanced similarity
    let listings = [];
    let similarAdv = [];
    try {
      const [ls, sa] = await Promise.all([
        fetch(`/api/token/${id}/listings?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.ok?r.json():{listings:[]}).catch(()=>({listings:[]})),
        fetch(`/api/token/${id}/similar-advanced?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.ok?r.json():{similar:[]}).catch(()=>({similar:[]})),
      ]);
      listings = Array.isArray(ls?.listings) ? ls.listings : [];
      similarAdv = Array.isArray(sa?.similar) ? sa.similar : [];
    } catch {}
    // Same-owner chips
    const sameOwnerChips = (holdings||[]).slice(0,12).filter(x=>x!==id).map(n=>`<span class='chip' data-token='${n}'>#${String(n).padStart(4,'0')}</span>`).join('');
    const listingRows = (listings||[]).slice(0,6).map(l=>{
      const when = l.listed_at ? (timeAgo(Number(l.listed_at)*1000)+' ago') : '';
      const plat = (l.platform||'').toUpperCase();
      const st = (l.status||'').toUpperCase();
      return `<div class='label'>${plat}</div><div class='value'>${fmtAmt(Number(l.price)||0)} <span class='small-meta'>${[st, when].filter(Boolean).join(' · ')}</span></div>`;
    }).join('');
    const advChips = (similarAdv||[]).slice(0,12).map(x=>`<span class='chip' data-token='${x.token_id}'>#${String(x.token_id).padStart(4,'0')}</span>`).join('');
    const traitsRows = (t.traits||[]).slice(0,24).map(a=>`<div class='label'>${a.trait_type}</div><div class='value'>${a.trait_value}</div>`).join('');
    // token-level metrics
    const lastSaleTs = t.last_sale_ts ? Number(t.last_sale_ts) : null;
    const lastBuyTs  = t.last_acquired_ts ? Number(t.last_acquired_ts) : null;
    const lastSaleWhen = lastSaleTs ? (timeAgo(lastSaleTs*1000)+' ago') : '';
    const lastBuyWhen  = lastBuyTs  ? (timeAgo(lastBuyTs*1000)+' ago') : '';
    const holdDaysTxt = (t.hold_days!=null && isFinite(t.hold_days)) ? String(Math.round(Number(t.hold_days))) : '--';
    const ethosCard = ethosValid ? `
        <div class='card'>
          <div class='label'>ETHOS</div>
          <div class='big-number'>${Math.round(ethos)}</div>
          <div class='small-meta'>${ethosBar}</div>
        </div>` : `
        <div class='card'>
          <div class='label'>ETHOS</div>
          <div class='big-number'>N/A</div>
          <div class='small-meta'>No verified profile</div>
        </div>`;
    detailsEl.innerHTML = `
      <div class='token-title'>MAMMOTH #${id.toString().padStart(4,'0')} <span class='token-close' id='close-detail'><i class="ri-close-line"></i></span></div>
      <div class='section-label'>OWNER</div>
      ${ens? `<div class='ens-name'>${ens} ✓</div>`:`<div class='address'>${addrShort}</div>`}
      <div class='card2'>
        ${ethosCard}
        <div class='card'>
          <div class='label'>HOLDINGS</div>
          <div class='big-number'>${holdings? holdings.length : '--'}</div>
          <div class='small-meta'>${holdings&&ownerCounts? rankLabel(ownerCounts, t.owner, presetData): ''}</div>
        </div>
      </div>
      <div class='card2'>
        <div class='card'>
          <div class='label'>SPEND</div>
          <div class='big-number'>${buyVol!=null?fmtAmt(buyVol):'--'}</div>
          <div class='small-meta'>Avg buy ${avgBuy!=null?fmtAmt(avgBuy):'--'}</div>
        </div>
        <div class='card'>
          <div class='label'>REVENUE</div>
          <div class='big-number'>${sellVol!=null?fmtAmt(sellVol):'--'}</div>
          <div class='small-meta'>Avg sell ${avgSell!=null?fmtAmt(avgSell):'--'}</div>
        </div>
      </div>
      <div class='card'>
        <div class='label'>REALIZED PNL</div>
        <div class='big-number' style='color:${(pnlTIA!=null && pnlTIA<0)?'var(--danger)':'var(--fg)'}'>${pnlTIA!=null?fmtAmt(pnlTIA):'--'}</div>
        <div class='small-meta'>Based on token buy→sell pairs</div>
      </div>
      <div class='card2'>
        <div class='card'>
          <div class='label'>LAST BUY</div>
          <div class='big-number'>${(t.last_buy_price!=null)?fmtAmt(Number(t.last_buy_price)):'--'}</div>
          <div class='small-meta'>${lastBuyWhen}</div>
        </div>
        <div class='card'>
          <div class='label'>LAST SALE</div>
          <div class='big-number'>${(t.last_sale_price!=null)?fmtAmt(Number(t.last_sale_price)):'--'}</div>
          <div class='small-meta'>${lastSaleWhen}</div>
        </div>
      </div>
      <div class='card'>
        <div class='label'>HOLD DAYS</div>
        <div class='big-number'>${holdDaysTxt}</div>
        <div class='small-meta'>Days since last buy</div>
      </div>
      <div class='card2'>
        <div class='card'>
          <div class='label'>WALLET TRADES</div>
          <div class='big-number'>${trades!=null?trades:'--'}</div>
          <div class='small-meta'>${actLabel}</div>
        </div>
        <div class='card'>
          <div class='label'>LAST SEEN</div>
          <div class='big-number'>${lastSeen||'--'}</div>
          <div class='small-meta'>${lastSeen==='Never traded'?'':'ago'}</div>
        </div>
      </div>
      <div class='card'>
        <div class='label'>STATUS</div>
        <div class='big-number'>${status}</div>
        <div class='small-meta'>Blue=frozen Gray=dormant</div>
      </div>
      <div class='section-label'>LISTINGS</div>
      <div class='traits-table'>${listingRows || `<div class='label'>NO LISTINGS</div><div class='value'>--</div>`}</div>
      <div class='section-label'>TRAITS</div>
      <div class='traits-table'>${traitsRows}</div>
      <div class='section-label'>SIMILAR TOKENS</div>
      <div class='label'>Same Owner (${holdings?holdings.length-1:0})</div>
      <div class='chip-row' id='chips-owner'>${sameOwnerChips||''}</div>
      <div class='label'>Similar by Traits</div>
      <div class='chip-row' id='chips-sim-adv'>${advChips||''}</div>
    `;
  // chip events
  detailsEl.querySelectorAll('.chip').forEach(el=> el.addEventListener('click', ()=>{ const tok = Number(el.dataset.token); const idx = idToIndex.get(tok); if (idx!=null) selectNode(idx); }));
  const closeBtn = document.getElementById('close-detail'); if (closeBtn) closeBtn.onclick = ()=>{ selectedIndex=-1; clearSelectionOverlay(); detailsEl.innerHTML='Select a node…'; thumbEl.style.display='none'; resetAlpha(); };
  // No background ETHOS injection; details already gated to real profiles
    // Append STORY card
    try {
      const story = await fetch(`/api/token/${id}/story`).then(r=>r.ok?r.json():null).catch(()=>null);
      if (story){
        const birth = story.birth_date ? (timeAgo(Number(story.birth_date)*1000)+' ago') : '--';
        const owners = story.total_owners ?? '--';
        const peak = story.peak_price!=null? fmtAmt(Number(story.peak_price)) : '--';
        const low  = story.lowest_price!=null? fmtAmt(Number(story.lowest_price)) : '--';
        const status = story.status || '';
        const html = `
          <div class='section-label'>STORY</div>
          <div class='card2'>
            <div class='card'><div class='label'>BIRTH</div><div class='big-number'>${birth}</div><div class='small-meta'>Mint</div></div>
            <div class='card'><div class='label'>OWNERS</div><div class='big-number'>${owners}</div><div class='small-meta'>Distinct holders</div></div>
          </div>
          <div class='card2'>
            <div class='card'><div class='label'>PEAK</div><div class='big-number'>${peak}</div></div>
            <div class='card'><div class='label'>LOW</div><div class='big-number'>${low}</div></div>
          </div>
          <div class='card'><div class='label'>STATUS</div><div class='big-number'>${status}</div></div>
        `;
        detailsEl.insertAdjacentHTML('beforeend', html);
      }
    } catch {}
  } catch (e) {
    try {
      // Minimal, never-fail fallback details rendering
      const name = (t && t.id!=null) ? `MAMMOTH #${String(t.id).padStart(4,'0')}` : `TOKEN #${id}`;
      const owner = (t && t.owner) ? t.owner : '';
      const addrShort = owner ? (owner.slice(0,6)+'...'+owner.slice(-4)) : '--';
      const traitsRows = (t?.traits||[]).slice(0,12).map(a=>`<div class='label'>${a.trait_type}</div><div class='value'>${a.trait_value}</div>`).join('') || `<div class='label'>TRAITS</div><div class='value'>--</div>`;
      detailsEl.innerHTML = `
        <div class='token-title'>${name}</div>
        <div class='section-label'>OWNER</div>
        <div class='address'>${addrShort}</div>
        <div class='section-label'>TRAITS</div>
        <div class='traits-table'>${traitsRows}</div>
      `;
    } catch { detailsEl.innerHTML = '<div>NO DATA</div>'; }
  }
}

function updateSelectionOverlay(){
  if (!selectGfx) return;
  selectGfx.clear();
  const idx = selectedIndex; if (idx<0 || idx>=sprites.length) return;
  const s = sprites[idx];
  // Wide, fine selection target ring + inner glow
  selectGfx.lineStyle({ width: 1, color: BRAND.WHITE, alpha: 0.9, cap: 'round', join: 'round' });
  selectGfx.drawCircle(s.x, s.y, 18);
  selectGfx.lineStyle({ width: 2, color: BRAND.GREEN, alpha: 1, cap: 'round', join: 'round' });
  selectGfx.drawCircle(s.x, s.y, 9);
  selectGfx.lineStyle({ width: 6, color: BRAND.GREEN, alpha: 0.12 });
  selectGfx.drawCircle(s.x, s.y, 11);
  // node indicators: ethos ring (gold) if high ethos; whale ring (cyan dashed) if large holdings
  const i = idx;
  try {
    const oi = presetData?.ownerIndex?.[i] ?? -1;
    const ethos = (oi>=0)? (presetData?.ownerEthos?.[oi] ?? null) : null;
    const high = (typeof ethos==='number' && ethos > (ethosMin + (ethosMax-ethosMin)*0.8));
  if (high){ selectGfx.lineStyle({ width:2, color:BRAND.GOLD, alpha:1 }); selectGfx.drawCircle(s.x, s.y, 14); }
    if (ownerCounts && oi>=0){
      const hold = ownerCounts[oi] || 0; const maxHold = Math.max(...ownerCounts);
      if (hold >= Math.max(5, maxHold*0.5)){
        // dashed cyan ring
        dashedCircle(selectGfx, s.x, s.y, 14, 0x00ccff, 0.9, 10, 6, 3);
      }
    }
  } catch {}
  // profitability badge when realized PnL > 0
  try {
    const profit = Number(lastSelectedWalletMeta?.realized_pnl_tia ?? 0);
    if (isFinite(profit) && profit > 0) {
      drawStar(selectGfx, s.x+12, s.y-12, 5, BRAND.GOLD);
    }
  } catch {}
  // neighbor edges from the active edges set
  const tid = s.__tokenId;
  if (edgesData && edgesData.length){
    for (let e=0;e<edgesData.length;e++){
      const item = edgesData[e];
      const a = Array.isArray(item)? item[0] : (item.a ?? item.source ?? item.from ?? 0);
      const b = Array.isArray(item)? item[1] : (item.b ?? item.target ?? item.to   ?? 0);
      if (a==tid || b==tid){
        const ia = idToIndex.get(Number(a));
        const ib = idToIndex.get(Number(b));
        if (ia==null || ib==null) continue;
        const base = pickEdgeStyle(modeEl?.value||'holders', ia, ib, item);
        if (!layerEnabled(base, item)) continue;
        // Emphasize on selection: thicker, brighter; reflect weight modestly
        const weight = Number(item?.count || item?.weight || (Array.isArray(item)? item[2] : 1)) || 1;
        const bump = Math.min(1.2, 0.4 + Math.log2(weight+1)*0.25);
        const style = { ...base, width: Math.min(2.2, (base.width||0.8) * (1.2 + bump)), opacity: 1.0 };
        strokeEdge(selectGfx, sprites[ia].x, sprites[ia].y, sprites[ib].x, sprites[ib].y, style);
      }
    }
  }
  // same-owner links (if fetched)
  if (selectedWalletSet && selectedWalletSet.size){
    selectGfx.lineStyle({ width: 1.5, color: 0x11ff99, alpha: 0.85, cap: 'round' });
    selectedWalletSet.forEach(t => {
      if (t===tid) return;
      const j = idToIndex.get(Number(t)); if (j==null) return;
      selectGfx.moveTo(s.x, s.y);
      selectGfx.lineTo(sprites[j].x, sprites[j].y);
    });
  }
}

function drawStar(g, cx, cy, r, color){
  const points = 5; const step = Math.PI/points; const r2 = r*0.5;
  g.lineStyle({ width:1.5, color: color, alpha:1, cap:'round', join:'round' });
  for (let i=0;i<points*2;i++){
    const ang1 = -Math.PI/2 + i*step;
    const ang2 = -Math.PI/2 + (i+1)*step;
    const rad1 = (i%2===0)? r : r2;
    const rad2 = ((i+1)%2===0)? r : r2;
    g.moveTo(cx + Math.cos(ang1)*rad1, cy + Math.sin(ang1)*rad1);
    g.lineTo(cx + Math.cos(ang2)*rad2, cy + Math.sin(ang2)*rad2);
  }
}

function dashedCircle(g, cx, cy, r, color, alpha, segLen=8, gap=6, width=2){
  g.lineStyle({ width, color, alpha, cap:'butt' });
  const circ = 2*Math.PI*r; const steps = Math.max(8, Math.floor(circ/(segLen+gap)));
  for (let k=0;k<steps;k++){
    const a1 = (k/steps)*2*Math.PI; const a2 = ((k+segLen/(segLen+gap))/steps)*2*Math.PI;
    g.moveTo(cx + Math.cos(a1)*r, cy + Math.sin(a1)*r);
    g.lineTo(cx + Math.cos(a2)*r, cy + Math.sin(a2)*r);
  }
}

// centerOnSprite handled via viewport.centerOn

function timeAgo(ms){
  const s = Math.max(1, Math.floor((Date.now()-ms)/1000));
  const d = Math.floor(s/86400); if (d>=1) return `${d} day${d>1?'s':''}`;
  const h = Math.floor(s/3600); if (h>=1) return `${h} hour${h>1?'s':''}`;
  const m = Math.floor(s/60); if (m>=1) return `${m} min${m>1?'s':''}`;
  return `${s}s`;
}

function rankLabel(ownerCounts, ownerAddr, data){
  try {
    if (!data || !Array.isArray(data.ownerIndex) || !Array.isArray(data.owners)) return '';
    const idx = (nodes[selectedIndex]?.id ? idToIndex.get(nodes[selectedIndex].id) : -1);
    // fallback: compute owner index using selected sprite
    const oi = (idx!=null && idx>=0) ? data.ownerIndex[idx] : -1;
    const count = (oi>=0 && ownerCounts) ? ownerCounts[oi] : null;
    if (!count) return '';
    const sorted = ownerCounts.slice().sort((a,b)=>b-a);
    const rank = sorted.findIndex(x=>x===count) + 1;
    const pct = Math.round((rank/sorted.length)*100);
    if (pct<=5) return 'Top 5%';
    if (pct<=10) return 'Top 10%';
    return '';
  } catch { return ''; }
}

// Traits
async function loadTraits(){
  if (!traitsContainer) return;
  const r = await fetch(`/api/traits?v=${Date.now()}`, { cache:'no-store' }).catch(()=>null);
  if(!r||!r.ok) { traitsContainer.innerHTML=''; return; }
  const j = await r.json(); const traits=j.traits||[];
  traitsContainer.innerHTML = '';
  // Clear button
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', ()=>{
      document.querySelectorAll('.trait-value.active').forEach(el=>el.classList.remove('active'));
      for (let i=0;i<sprites.length;i++) sprites[i].alpha = 0.95;
    });
  }
  for (const t of traits) {
    const group = document.createElement('div');
    group.className = 'trait-group';
    const header = document.createElement('div'); header.className = 'trait-header'; header.innerHTML = `<span class="twist">▶</span><span>${t.type}</span>`; group.appendChild(header);
    const valuesWrap = document.createElement('div'); valuesWrap.className = 'trait-values'; valuesWrap.style.display='none'; group.appendChild(valuesWrap);
    const list = (t.values||[]);
    for (let i=0;i<list.length;i++){
      const v = list[i];
      const row = document.createElement('div'); row.className = 'trait-value'; row.dataset.type=t.type; row.dataset.value=v.value;
      row.innerHTML = `<span>${v.value}</span><span class="trait-count">${v.count}</span>`;
      row.addEventListener('click', async ()=>{
        document.querySelectorAll('.trait-value.active').forEach(el=>el.classList.remove('active'));
        row.classList.add('active');
        const rr = await fetch(`/api/trait-tokens?type=${encodeURIComponent(t.type)}&value=${encodeURIComponent(v.value)}&v=${Date.now()}`, { cache:'no-store' }).then(x=>x.json()).catch(()=>({tokens:[]}));
        const ids = new Set((rr.tokens||[]).map(Number));
        highlightSet = ids;
        for(let k=0;k<sprites.length;k++){
          const tid = sprites[k].__tokenId;
          const show = ids.has(Number(tid));
          sprites[k].alpha = show?0.95:0.1;
        }
        fitToVisible();
      });
      valuesWrap.appendChild(row);
      if (i>120) break;
    }
    let open = false; const tw0 = header.querySelector('.twist'); if (tw0) tw0.textContent='▶';
    header.addEventListener('click', ()=>{
      open = !open;
      valuesWrap.style.display = open ? 'block' : 'none';
      const tw = header.querySelector('.twist'); if (tw) tw.textContent = open ? '▼' : '▶';
    });
    traitsContainer.appendChild(group);
  }
}

function setupPresets(){
  document.querySelectorAll('.preset-btn').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const p = e.currentTarget.dataset.preset;
      document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      preset = p;
      const targetMode = PRESET_MODE[preset];
      if (targetMode && modeEl.value !== targetMode) {
        modeEl.value = targetMode;
        await load(targetMode, 200);
      }
      await ensurePresetData();
      applyPreset(preset);
      layoutPreset(preset);
      resetAlpha();
      resetView();
      clearSelectionOverlay();
    });
  });
}

async function ensurePresetData(){
  if (presetData) return;
  try { presetData = await fetch('/api/preset-data?nodes=10000').then(r=>r.json()); } catch { presetData = null; }
  if (worker && presetData) worker.postMessage({ type:'setPresetData', payload: presetData });
  // compute ethos range for better contrast
  if (presetData && Array.isArray(presetData.ownerEthos)){
    const vals = presetData.ownerEthos.filter(v=>v!=null && isFinite(v));
    if (vals.length){ ethosMin = Math.min(...vals); ethosMax = Math.max(...vals); if (ethosMin===ethosMax){ ethosMin=0; ethosMax=ethosMin+1; } }
  }
  // compute global ownerCounts for rank labels and selection indicators
  try {
    const oi = presetData?.ownerIndex || [];
    if (Array.isArray(oi) && oi.length) {
      ownerCounts = new Array(Math.max(...oi)+1).fill(0);
      for (let i=0;i<oi.length;i++){ const k = oi[i]; if (k>=0) ownerCounts[k] = (ownerCounts[k]||0)+1; }
    }
  } catch {}
}

function applyPreset(p){
  if (!sprites.length) return;
  if (!p) { // reset
    for(let i=0;i<sprites.length;i++) sprites[i].tint = nodes[i]?.color||BRAND.GREEN;
    return;
  }
  for (let i=0;i<sprites.length;i++){
    switch(p){
      case 'frozen': {
        // DB flags first, else infer by last activity
        let frozen = nodes[i]?.frozen ? 1 : 0;
        let dormant = nodes[i]?.dormant ? 1 : 0;
        if (!frozen && !dormant) {
          const last = presetData?.tokenLastActivity?.[i] || 0;
          if (last) {
            const days = (Date.now()/1000 - last) / 86400;
            if (days > 180) dormant = 1; // >6 months dormant
            else if (days > 60) dormant = 1; // 2-6 months = dormant as well
          }
        }
        sprites[i].tint = frozen ? BRAND.BLUE : (dormant ? BRAND.GRAY : BRAND.GREEN); // blue frozen, gray dormant, green active
        break;
      }
      case 'rarity': {
        const r = presetData?.rarity?.[i] ?? 0;
        const g = Math.max(0, Math.min(255, Math.floor(r*255)));
        sprites[i].tint = (g<<16) | (g<<8) | g; // grayscale by rarity
        break;
      }
      case 'social': {
        const oi = presetData?.ownerIndex?.[i] ?? -1;
        const ethos = oi>=0 ? (presetData?.ownerEthos?.[oi] ?? null) : null;
        const n = ethos==null ? 0.2 : (ethos-ethosMin)/(ethosMax-ethosMin);
        const g = Math.max(0, Math.min(255, Math.floor(n*255)));
        sprites[i].tint = (0<<16) | (g<<8) | Math.floor(g*0.6);
        break;
      }
      case 'whales': {
        // approximate by owner frequency bucket
        const oi = presetData?.ownerIndex?.[i] ?? -1;
        let bucket = 0;
        if (oi>=0) bucket = (oi % 10);
        const col = [0x66ff66,0x55ee55,0x44dd44,0x33cc33,0x22bb22,0x11aa11,0x009900,0x008800,0x007700,0x006600][bucket];
        sprites[i].tint = col;
        break;
      }
      case 'trading': {
        // Make stale tokens still visible (avoid near-black on black)
        const t = presetData?.tokenLastActivity?.[i] ?? 0;
        const fresh = t ? ((Date.now()/1000 - t) < 30*24*3600) : false;
        sprites[i].tint = fresh ? BRAND.GREEN : 0x117744; // dim green, not gray
        break;
      }
      case 'ownership': {
        const oi = presetData?.ownerIndex?.[i] ?? -1;
        const hue = (oi>=0 ? (oi * 137) % 360 : 120);
        const col = hslToRgb(hue/360, 0.6, 0.5);
        sprites[i].tint = col;
        break;
      }
      default:
        sprites[i].tint = nodes[i]?.color||BRAND.GREEN;
    }
    // Status override: frozen -> blue, dormant -> gray, active -> existing tint
    try {
      const n = nodes[i]||{};
      if (n.frozen) sprites[i].tint = BRAND.BLUE; else if (n.dormant) sprites[i].tint = BRAND.GRAY;
    } catch {}
  }
}

function hslToRgb(h, s, l){
  const f = (n, k=(n+h*12)%12) => l - s*Math.min(l,1-l)*Math.max(-1, Math.min(k-3, Math.min(9-k,1)));
  const r = Math.round(255*f(0));
  const g = Math.round(255*f(8));
  const b = Math.round(255*f(4));
  return (r<<16)|(g<<8)|b;
}

function prng(i){ // simple deterministic jitter
  let x = (i+1) * 1103515245 + 12345; x = (x>>>0) / 4294967296; return x - Math.floor(x);
}

// Lightweight value noise for layout shaping
function noise2(x, y){
  const n1 = Math.sin(x*2.3 + y*1.7)*0.5 + 0.5;
  const n2 = Math.sin(x*5.1 - y*3.7)*0.5 + 0.5;
  const n3 = Math.sin(x*11.7 + y*9.1)*0.5 + 0.5;
  return (n1*0.5 + n2*0.35 + n3*0.15);
}

function layoutPreset(p){
  if (!sprites.length) return;
  const cw = app.renderer.width, ch = app.renderer.height;
  const cx = cw/2, cy = ch/2;
  const n = sprites.length;
  const ownerIndex = presetData?.ownerIndex || [];
  const ownerEthos = presetData?.ownerEthos || [];
  const tokenLast = presetData?.tokenLastActivity || [];
  const tokenPrice = presetData?.tokenPrice || [];
  const tokenSaleCount = presetData?.tokenSaleCount || [];
  const tokenLastSaleTs = presetData?.tokenLastSaleTs || [];
  const tokenLastSalePrice = presetData?.tokenLastSalePrice || [];
  const tokenHoldDays = presetData?.tokenHoldDays || [];
  const tokenTraitKey = presetData?.tokenTraitKey || [];
  const traitKeys = presetData?.traitKeys || [];
  const rarity = presetData?.rarity || [];
  const ownerWalletType = presetData?.ownerWalletType || [];
  const ownerPnl = presetData?.ownerPnl || [];
  const ownerBuyVol = presetData?.ownerBuyVol || [];
  const ownerSellVol = presetData?.ownerSellVol || [];
  const ownerAvgHoldDays = presetData?.ownerAvgHoldDays || [];
  const ownerFlipRatio = presetData?.ownerFlipRatio || [];

  // precompute owner frequencies for whales layout
  let ownerCounts = null;
  if (ownerIndex && ownerIndex.length) {
    ownerCounts = new Array(Math.max(...ownerIndex)+1).fill(0);
    for (let i=0;i<ownerIndex.length;i++){ const oi=ownerIndex[i]; if (oi>=0) ownerCounts[oi] = (ownerCounts[oi]||0)+1; }
  }

  const place = placeNode;

  switch(p){
    case 'ownership': {
      const owners = Math.max(1, (ownerCounts?.length||12));
      for (let i=0;i<n;i++){
        const oi = ownerIndex[i] ?? -1;
        const ang = ((oi>=0?oi: (i%owners)) / owners) * Math.PI*2;
        const baseRing = 200 + ((oi>=0? (oi%6): (i%6)) * 36);
        // Pull profitable wallets closer to center
        const pnl = (oi>=0) ? (ownerPnl[oi] ?? 0) : 0;
        const profitBonus = pnl>0 ? Math.min(120, Math.log(1+Math.abs(pnl))*40) : 0;
        const ring = Math.max(80, baseRing - profitBonus);
        const jitter = (prng(i)-0.5)*18;
        // Color by wallet type (if present)
        const wtype = (oi>=0) ? (ownerWalletType[oi] || 'casual') : 'casual';
        const typeColors = { flipper: 0xff6600, diamond_hands: 0x00ffff, whale_trader: 0x0066ff, collector: 0x9966ff, holder: 0x66ff66, accumulator: 0xffcc00 };
        sprites[i].tint = typeColors[wtype] ?? (nodes[i]?.color||BRAND.GREEN);
        // Size by hold days (token-level)
        const hd = tokenHoldDays[i] ?? 0; const scl = 0.7 + Math.min(2.0, Math.max(0, hd)/365);
        sprites[i].scale.set(scl, scl);
        place(i, cx + Math.cos(ang)*(ring+jitter), cy + Math.sin(ang)*(ring+jitter));
      }
      break;
    }
    case 'trading': {
      // If no trading data available, fall back to a compact grid so the view is never empty
      const hasSaleCounts = Array.isArray(tokenSaleCount) && tokenSaleCount.some(v=>Number(v)>0);
      const hasLastTs     = (Array.isArray(tokenLastSaleTs) && tokenLastSaleTs.some(v=>v!=null && Number(v)>0)) ||
                            (Array.isArray(tokenLast) && tokenLast.some(v=>v!=null && Number(v)>0));
      if (!hasSaleCounts && !hasLastTs) { layoutGrid(); break; }
      const tiers = { bigProfit: [], profit: [], breakeven: [], loss: [], bigLoss: [] };
      for (let i=0;i<n;i++){
        const lastPrice = Number(tokenLastSalePrice?.[i] ?? tokenPrice?.[i] ?? 0);
        const buyPrice  = Number((presetData?.tokenLastBuyPrice||[])[i] ?? lastPrice);
        const profit = lastPrice - buyPrice;
        if (profit > 5) tiers.bigProfit.push(i);
        else if (profit > 0) tiers.profit.push(i);
        else if (profit > -0.5) tiers.breakeven.push(i);
        else if (profit > -5) tiers.loss.push(i);
        else tiers.bigLoss.push(i);
      }
      const order = ['bigProfit','profit','breakeven','loss','bigLoss'];
      const tierH = Math.max(100, ch/5); const cx2 = cw/2;
      let curY = 70;
      for (const key of order){
        const arr = tiers[key]; const poolW = Math.min(arr.length*3 + 200, cw - 160);
        for (let j=0;j<arr.length;j++){
          const i = arr[j]; const s = sprites[i]; const col = j % 50; const row = Math.floor(j/50);
          const x = cx2 - poolW/2 + (col+0.5) * (poolW/50);
          const y = curY + row*18 + Math.sin(((performance.now?performance.now():Date.now())*0.001) + j*0.1) * 4;
          place(i, x, y);
          s.tint = key==='bigProfit'?0x00ff00: key==='profit'?0x00ff66: key==='breakeven'?0xffff66: key==='loss'?0xff6666:0xff0000;
          const lastTs = Number(tokenLastSaleTs[i] || tokenLast[i] || 0);
          const days = lastTs ? ((Date.now()/1000 - lastTs)/86400) : 999;
          s.scale.set(days < 7 ? 1.5 : days < 30 ? 1.0 : 0.5);
          s.alpha = Math.max(0.3, 1.0 - days/100);
        }
        curY += tierH;
      }
      enforceSeparation(8,1); try { fitToVisible(); } catch {}
      break;
    }
    case 'rarity': {
      const tk = tokenTraitKey || [];
      const freq = new Map(); for (let i=0;i<tk.length;i++){ const k=tk[i]; if (k>=0) freq.set(k, (freq.get(k)||0)+1); }
      const keys = Array.from(freq.keys()).sort((a,b)=> (freq.get(a)-freq.get(b)));
      const centers = new Map();
      for (let i=0;i<keys.length;i++){
        const k = keys[i]; const f = freq.get(k)||1; const ang = (i*0.618)%1 * Math.PI*2;
        const rad = Math.min(cx,cy) * Math.max(0.15, Math.min(0.9, 0.08 + Math.sqrt(Math.min(1, f/200))));
        centers.set(k, { x: cx + Math.cos(ang)*rad, y: cy + Math.sin(ang)*rad });
      }
      for (let i=0;i<n;i++){
        const k = tk[i]; const c0 = (k>=0 && centers.has(k)) ? centers.get(k) : {x: cx + (prng(i)-0.5)*cx*1.4, y: cy + (prng(i*7)-0.5)*cy*1.4};
        const rs = Math.max(0, Math.min(1, rarity[i]||0));
        const jitterR = 12 + (1-rs)*40; const ang = (i*1.77)% (Math.PI*2);
        const x = c0.x + Math.cos(ang)*jitterR*(prng(i*11));
        const y = c0.y + Math.sin(ang)*jitterR*(prng(i*13));
        let sz = Math.min(2.5, 0.5 + rs*2.5); sprites[i].scale.set(sz, sz);
        const alpha = 0.2 + rs*0.8; sprites[i].alpha = alpha;
        let col = 0x447744; if (rs > 0.9) col = 0xfffacd; else if (rs > 0.7) col = 0xffff66; else if (rs > 0.4) col = 0xffaa00;
        sprites[i].tint = col; place(i, x, y);
      }
      enforceSeparation(8, 1); try { fitToVisible(); } catch {}
      break;
    }
    case 'social': {
      const owners = Math.max(1, (ownerCounts?.length||12));
      for (let i=0;i<n;i++){
        const oi = ownerIndex[i] ?? -1;
        const ang = ((oi>=0?oi:(i%owners))/owners)*Math.PI*2;
        const e = oi>=0 ? (ownerEthos[oi] ?? null) : null;
        const en = (e==null) ? 0.2 : (e - ethosMin) / (ethosMax - ethosMin + 1e-9);
        const pnl = (oi>=0) ? (ownerPnl[oi] ?? 0) : 0;
        const pnlBonus = pnl>0 ? 0.12 : (pnl<0 ? -0.06 : 0);
        const rad = 80 + (1 - Math.max(0, Math.min(1, en + pnlBonus))) * Math.min(cx,cy)*0.9;
        // RGB by ethos/pnl
        const green = Math.floor(100 + Math.max(0, Math.min(1, en))*155);
        const red = pnl<0 ? Math.min(120, Math.round(Math.log(1+Math.abs(pnl))*60)) : 0;
        const blue = pnl>0 ? Math.min(155, Math.round(Math.log(1+pnl)*80)) : 0;
        sprites[i].tint = (red<<16)|(green<<8)|blue;
        const jitter = (prng(i)-0.5)*16;
        place(i, cx + Math.cos(ang)*(rad+jitter), cy + Math.sin(ang)*(rad+jitter));
      }
      break;
    }
    case 'whales': {
      const owners = Math.max(1, (ownerCounts?.length||12));
      const ownerVol = new Array(owners).fill(0);
      for (let oi=0; oi<owners; oi++){ ownerVol[oi] = (ownerBuyVol[oi]||0) + (ownerSellVol[oi]||0); }
      const maxVol = Math.max(1e-6, ...ownerVol);
      const maxHold = ownerCounts && ownerCounts.length ? Math.max(...ownerCounts) : 0;
      const bandH = ch/3; const padX=80; const innerW=cw-padX*2;
      for (let i=0;i<n;i++){
        const oi = ownerIndex[i] ?? -1; const hold = (oi>=0 && ownerCounts)? (ownerCounts[oi]||0) : 0;
        let tier=0; if (hold>50) tier=2; else if (hold>=5) tier=1; else tier=0;
        const voln = (oi>=0)? Math.max(0, Math.min(1, ownerVol[oi]/maxVol)) : 0;
        const x = padX + voln * innerW + (prng(i)-0.5)*12;
        const y = tier*bandH + bandH*0.5 + (prng(i*7)-0.5)* (bandH*0.6);
        const scl = tier===2? 3.0 : tier===1? 1.5 : 0.5; const a = tier===2? 1.0 : tier===1? 0.8 : 0.5;
        sprites[i].scale.set(scl, scl); sprites[i].alpha = a;
        const wtype = (oi>=0) ? (ownerWalletType[oi] || 'holder') : 'holder';
        const typeColors = { diamond_hands: 0x0066ff, flipper: 0xff6600, accumulator: 0xffcc00, profit: 0x00ff00, loss: 0x990000 };
        sprites[i].tint = typeColors[wtype] || 0x66ff66;
        place(i, x, y);
      }
      enforceSeparation(10, 2);
      break;
    }
    case 'frozen': {
      // Stratify by status and activity
      for (let i=0;i<n;i++){
        const frozen = nodes[i]?.frozen ? 1 : 0;
        const dormant = nodes[i]?.dormant ? 1 : 0;
        const hd = Number(tokenHoldDays[i] || 0);
        const sc = Number(tokenSaleCount[i] || 0);
        let layer = 3; let color = BRAND.GREEN; let xPos = 100 + (i%60)*15; let yJitter=0;
        if (frozen) { layer=0; color=BRAND.BLUE; xPos = 100 + (i%40)*20; }
        else if (dormant || hd>180) { layer=1; color=0x888888; xPos = 100 + Math.min(1, hd/365)*(cw-200); yJitter = Math.sin(i*0.1)*10; }
        else if (sc>3) { layer=2; color=0xff6633; xPos = 100 + Math.min(1, sc/20)*(cw-200); yJitter = Math.sin(Date.now()*0.002 + i)*12; }
        const yBase = 100 + layer*150;
        sprites[i].tint = color; place(i, xPos, yBase + yJitter);
        // Alpha by recent sale recency
        const lastTs = Number(tokenLastSaleTs[i] || tokenLast[i] || 0);
        const daysSince = lastTs ? ((Date.now()/1000 - lastTs)/86400) : 999;
        sprites[i].alpha = daysSince < 30 ? 0.95 : 0.6;
      }
      break;
    }
    default: layoutGrid(); return;
  }
  drawEdges();
}

// Toast (console-based minimal)
function showToast(msg){ console.log('[toast]', msg); }

// Status banner removed per design; use console for diagnostics
let selectedIndex = -1;
let selectedWalletSet = null;

function resetAlpha(){ for (let i=0;i<sprites.length;i++) sprites[i].alpha = 0.95; }
function resetView(){
  const s = 1.2; // slightly zoomed-in default for visibility
  world.scale.set(s);
  // keep the world center anchored to screen center when scaling
  const cx = app.renderer.width/2, cy = app.renderer.height/2;
  world.position.set((1-s)*cx, (1-s)*cy);
}

// Center world on a world-space point (x,y) at optional target scale
function centerOn(x, y, targetScale){
  try {
    if (targetScale) world.scale.set(clamp(targetScale, 0.2, 5));
    const s = world.scale.x || 1;
    const cx = app.renderer.width/2, cy = app.renderer.height/2;
    world.position.x = cx - x*s;
    world.position.y = cy - y*s;
  } catch {}
}

function computeContentBounds(){
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9; const n=sprites.length;
  for(let i=0;i<n;i++){ const sp=sprites[i]; if (sp.x<minx) minx=sp.x; if (sp.x>maxx) maxx=sp.x; if (sp.y<miny) miny=sp.y; if (sp.y>maxy) maxy=sp.y; }
  if (minx===1e9) return null; return {minx,miny,maxx,maxy};
}

function clampWorldToContent(pad=40){
  const b = computeContentBounds(); if (!b) return;
  const s = world.scale.x||1; const w=app.renderer.width, h=app.renderer.height;
  // Compute content bbox in screen coords
  const sx1 = world.position.x + b.minx*s - pad;
  const sy1 = world.position.y + b.miny*s - pad;
  const sx2 = world.position.x + b.maxx*s + pad;
  const sy2 = world.position.y + b.maxy*s + pad;
  let dx=0, dy=0;
  if (sx1>0) dx = -sx1; if (sx2<w && dx===0) dx = w-sx2;
  if (sy1>0) dy = -sy1; if (sy2<h && dy===0) dy = h-sy2;
  world.position.x += dx; world.position.y += dy;
}

function ensureSpriteOnScreen(sp, pad=60){
  const s = world.scale.x||1; const w=app.renderer.width, h=app.renderer.height;
  const sx = world.position.x + sp.x*s; const sy = world.position.y + sp.y*s;
  let dx=0, dy=0;
  if (sx < pad) dx = pad - sx; else if (sx > w-pad) dx = (w-pad) - sx;
  if (sy < pad) dy = pad - sy; else if (sy > h-pad) dy = (h-pad) - sy;
  world.position.x += dx; world.position.y += dy;
}

function fitToVisible(){
  const pad = 40;
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity, n=0;
  for (let i=0;i<sprites.length;i++){
    const sp = sprites[i];
    if (sp.alpha >= 0.9){
      if (sp.x<minx) minx=sp.x; if (sp.x>maxx) maxx=sp.x;
      if (sp.y<miny) miny=sp.y; if (sp.y>maxy) maxy=sp.y; n++;
    }
  }
  if (!n || !isFinite(minx)) return;
  const w = maxx-minx, h = maxy-miny;
  const vw = app.renderer.width - pad*2, vh = app.renderer.height - pad*2;
  const sx = vw / Math.max(1, w), sy = vh / Math.max(1, h);
  const s = Math.min(4, Math.max(0.2, Math.min(sx, sy)));
  world.scale.set(s);
  world.position.x = pad - minx*s + (vw - w*s)/2;
  world.position.y = pad - miny*s + (vh - h*s)/2;
}

function applyFocus(){
  if (!focusMode || selectedIndex<0){ resetAlpha(); return; }
  const tid = sprites[selectedIndex].__tokenId;
  const neighbors = new Set();
  for (const [a,b] of edgesData){ if (a===tid) neighbors.add(b); else if (b===tid) neighbors.add(a); }
  for (let i=0;i<sprites.length;i++){
    const id = sprites[i].__tokenId;
    const isSel = (i===selectedIndex);
    const keep = isSel || neighbors.has(id) || (selectedWalletSet && selectedWalletSet.has(id));
    sprites[i].alpha = keep? 0.98 : 0.25;
  }
}

// Robust PIXI bootstrap
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = ()=>reject(new Error('failed '+src)); document.head.appendChild(s);
  });
}

async function ensurePixi(){
  if (typeof window !== 'undefined' && typeof window.PIXI !== 'undefined') return;
  const tries = [
    '/lib/pixi.min.js',
    '/lib/pixi.js',
    '/lib/browser/pixi.js',
    'https://cdn.jsdelivr.net/npm/pixi.js@7.4.0/dist/pixi.min.js'
  ];
  for (const u of tries){
    try { await loadScript(u); if (typeof window.PIXI !== 'undefined') return; } catch {}
  }
  throw new Error('PIXI failed to load from all sources');
}

function showFatal(err){
  console.error('Init failed:', err);
  const el = document.createElement('div');
  el.style.cssText = 'color:#ff5555;padding: var(--pad-16); font: var(--fs-12)/1.5 var(--font-mono); background: #111; border-bottom: 1px solid rgba(0,0,0,.6)';
  el.innerHTML = `<b>Failed to initialize</b><br>${(err&&err.message)||err}`;
  document.body.prepend(el);
}

window.addEventListener('load', async ()=>{
  try { await ensurePixi(); await init(); }
  catch(e){ showFatal(e); }
});
