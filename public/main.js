// Minimal front-end per spec: PIXI v7 + three-panel shell

const stageEl = document.getElementById('stage');
const modeEl = document.getElementById('mode');
const edgesEl = document.getElementById('edges-slider');
let focusMode = false; // keyboard 'f' or header toggle
const legendEl = document.getElementById('legend');
const statusEl = null;
const traitsContainer = document.getElementById('traits-container');
const searchEl = document.getElementById('search');
const sidebar = document.getElementById('sidebar');
const thumbEl = document.getElementById('thumb');
const detailsEl = document.getElementById('details');

let app, world, nodeContainer, circleTexture, edgesGfx, selectGfx, heatGfx;
let sprites = []; // PIXI.Sprite
let nodes = [];   // server nodes
let edgesData = [];
let idToIndex = new Map();
let worker = null; // disabled physics, keep ref for future
let preset = null;
let presetData = null;
let lastGraph = null;
const PRESET_MODE = { ownership: 'holders', trading: 'transfers', whales: 'wallets', frozen: 'holders', rarity: null, social: 'holders' };
let ethosMin = 0, ethosMax = 1;
let ownerCounts = null;
let highlightSet = null; // Set of ids currently highlighted by filter
// Camera state
let camMin = 0.15, camMax = 4;
let camAnimating = false, camManual = false;
let camManualTimer = null;
let pointerDown = false;
let dragging = false;
let down = { x:0, y:0 };
let startPos = { x:0, y:0 };

// Convert screen to world (using current transform)
function camToWorld(x, y){
  const rect = stageEl.getBoundingClientRect();
  const sx = x - rect.left, sy = y - rect.top;
  const s = world?.scale?.x || 1;
  return new PIXI.Point((sx - world.position.x)/s, (sy - world.position.y)/s);
}

// Set scale with pivot compensation
function camSetScale(next, pivot){
  const s = Math.min(camMax, Math.max(camMin, next));
  if (pivot){
    const rect = stageEl.getBoundingClientRect();
    const sx = pivot.x - rect.left;
    const sy = pivot.y - rect.top;
    const old = world.scale.x || 1;
    const wx = (sx - world.position.x)/old;
    const wy = (sy - world.position.y)/old;
    world.scale.set(s);
    world.position.x = sx - wx * s;
    world.position.y = sy - wy * s;
  } else {
    world.scale.set(s);
  }
}

// Set position
function camSetPos(x, y){ world.position.set(x, y); }

// Allow auto-fit again after user stops interacting
function camAllowAutoSoon(){ clearTimeout(camManualTimer); camManualTimer = setTimeout(()=>{ camManual=false; }, 600); }
// Edge style mapping (lightweight, perf-friendly)
const EDGE_STYLES = {
  OWNERSHIP:      { kind:'solid',  width:2,   color:0x00ff66, opacity:1.0 },
  RECENT_TRADE:   { kind:'solid',  width:1.5, color:0x00ffaa, opacity:0.8 },
  OLD_TRADE:      { kind:'dashed', width:1,   color:0x666666, opacity:0.4 },
  RARE_TRAIT:     { kind:'dotted', width:1,   color:0xffaa00, opacity:0.6 },
  HIGH_VALUE:     { kind:'solid',  width:3,   color:0xffd700, opacity:1.0 },
  SAME_WHALE:     { kind:'double', width:2,   color:0x00ccff, opacity:0.7 },
};

// Respect left-panel layer toggles
function layerEnabled(style){
  try {
    const own = document.getElementById('layer-ownership');
    const trd = document.getElementById('layer-trades');
    const rar = document.getElementById('layer-traits');
    const val = document.getElementById('layer-value');
    if (!own && !trd && !rar && !val) return true;
    if (!style) return true;
    if (style === EDGE_STYLES.OWNERSHIP || style === EDGE_STYLES.SAME_WHALE || style.kind === 'double') return own ? !!own.checked : true;
    if (style === EDGE_STYLES.RECENT_TRADE || style === EDGE_STYLES.OLD_TRADE) return trd ? !!trd.checked : true;
    if (style === EDGE_STYLES.RARE_TRAIT || style.kind === 'dotted') return rar ? !!rar.checked : true;
    if (style === EDGE_STYLES.HIGH_VALUE) return val ? !!val.checked : true;
  } catch {}
  return true;
}

// Utils
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function lerp(a,b,t){ return a + (b-a)*t; }
function lerpColor(c1, c2, t){
  t = Math.max(0, Math.min(1, t));
  const r1=(c1>>16)&255, g1=(c1>>8)&255, b1=c1&255;
  const r2=(c2>>16)&255, g2=(c2>>8)&255, b2=c2&255;
  const r=Math.round(lerp(r1,r2,t));
  const g=Math.round(lerp(g1,g2,t));
  const b=Math.round(lerp(b1,b2,t));
  return (r<<16)|(g<<8)|b;
}
function throttle(fn, ms){ let last=0; let t=null; return function(...args){ const now=Date.now(); const run=()=>{ last=now; t=null; fn.apply(this,args); }; if (now-last>=ms){ if (t){ clearTimeout(t); t=null; } run(); } else if (!t){ t=setTimeout(run, ms-(now-last)); } }; }
function makeCircleTexture(renderer, r=5, color=0x00ff66){
  const g = new PIXI.Graphics();
  g.lineStyle(1, color, 1.0).beginFill(color, 0.85).drawCircle(r, r, r).endFill();
  const t = renderer.generateTexture(g);
  g.destroy(true);
  return t;
}

async function init() {
  const wrapEl = document.querySelector('.canvas');
  const inset = 6;
  const w0 = Math.max(1, (wrapEl?.clientWidth||stageEl.clientWidth) - inset*2);
  const h0 = Math.max(1, (wrapEl?.clientHeight||stageEl.clientHeight) - inset*2);
  app = new PIXI.Application({ view: stageEl, backgroundAlpha:0, antialias:true, resolution:Math.min(devicePixelRatio||1,2), width: w0, height: h0 });
  world = new PIXI.Container();
  app.stage.addChild(world);
  // Heatmap background at z-index 0 inside world
  heatGfx = new PIXI.Graphics();
  try { world.addChildAt(heatGfx, 0); } catch { world.addChild(heatGfx); }
  nodeContainer = new PIXI.ParticleContainer(10000, { position:true, scale:true, tint:true, alpha:true });
  world.addChild(nodeContainer);
  edgesGfx = new PIXI.Graphics();
  edgesGfx.zIndex = -1;
  world.addChild(edgesGfx);
  // background grid + overlay for selection ring + neighbor edges
  const gridGfx = new PIXI.Graphics();
  app.stage.addChildAt(gridGfx, 0);
  selectGfx = new PIXI.Graphics();
  world.addChild(selectGfx);
  circleTexture = makeCircleTexture(app.renderer, 4, 0x00ff66);

  // Resize to grid cell
  // Ensure global access for counts used in details panel
  window.ownerCounts = null;
  const drawGrid = ()=>{
    try{
      gridGfx.clear();
      const w = app.renderer.width, h = app.renderer.height;
      const step = 50;
      const c = 0x00ff66; const a = 0.06;
      gridGfx.lineStyle(1, c, a);
      for (let x=0;x<=w;x+=step){ gridGfx.moveTo(x,0); gridGfx.lineTo(x,h); }
      for (let y=0;y<=h;y+=step){ gridGfx.moveTo(0,y); gridGfx.lineTo(w,y); }
    }catch{}
  };
  try { new ResizeObserver(()=>{ const w=Math.max(1,(wrapEl?.clientWidth||stageEl.clientWidth)-inset*2); const h=Math.max(1,(wrapEl?.clientHeight||stageEl.clientHeight)-inset*2); app.renderer.resize(w, h); drawGrid(); }).observe(wrapEl||stageEl); } catch {}
  try {
    const obsEl = document.querySelector('.canvas') || document.querySelector('.shell') || document.body;
    new ResizeObserver(()=>{
      if (!sprites.length) return;
      if (preset) layoutPreset(preset); else layoutGrid();
    }).observe(obsEl);
  } catch {}
  drawGrid();

  // Load data and start
  await load(modeEl.value, Number(edgesEl?.value||200));

  // Interactions
  setupPanZoom();
  // Wire layer toggles to redraw edges/overlay
  ;(function setupLayerToggles(){
    const ids = ['layer-ownership','layer-trades','layer-traits','layer-value'];
    ids.forEach(id=>{
      const el = document.getElementById(id);
      if (el && !el.dataset.bound){
        el.dataset.bound = '1';
        el.addEventListener('change', ()=>{ drawEdges(); updateSelectionOverlay(); });
      }
    });
  })();
  stageEl.addEventListener('click', onStageClick);
  modeEl.addEventListener('change', async ()=>{
    const val = modeEl.value;
    const count = Number(edgesEl?.value||200);
    const presets = ['ownership','trading','rarity','social','whales','frozen'];
    if (presets.includes(val)){
      const target = PRESET_MODE[val] || 'holders';
      await load(target, count);
      await ensurePresetData();
      preset = val;
      applyPreset(preset);
      layoutPreset(preset);
      resetAlpha();
      setLegend(preset);
    } else {
      await load(val, count);
      // keep preset as-is if compatible; otherwise clear legend
      setLegend(preset);
    }
  });
  if (edgesEl){
    const ec = document.getElementById('edge-count');
    edgesEl.addEventListener('input', ()=>{ if (ec) ec.textContent = String(edgesEl.value); load(modeEl.value, Number(edgesEl.value||200)); });
  }
  const clearBtn = document.getElementById('clear-search');
  if (clearBtn){ clearBtn.addEventListener('click', ()=>{ searchEl.value=''; searchEl.focus(); }); }
  window.addEventListener('keydown', (e)=>{ if (e.key==='Escape'){ searchEl.value=''; }});
  // Focus toggle UI + keyboard shortcut
  const focusEl = document.getElementById('focus-toggle');
  if (focusEl) focusEl.addEventListener('change', ()=>{ focusMode = !!focusEl.checked; if (selectedIndex>=0) applyFocus(); else resetAlpha(); });
  window.addEventListener('keydown', (e)=>{ if (e.key.toLowerCase()==='f'){ focusMode=!focusMode; if (focusEl) focusEl.checked = focusMode; if (selectedIndex>=0) applyFocus(); else resetAlpha(); }});
  stageEl.addEventListener('dblclick', ()=> { camManual=false; resetView(); });
  // Search: token id or wallet address
  searchEl.addEventListener('keydown', async e=>{
    if(e.key!=='Enter') return;
    const val = searchEl.value.trim();
    searchEl.value='';
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
  // Default view: OWNERSHIP
  try { document.querySelector('.preset-btn[data-preset="ownership"]').classList.add('active'); } catch {}
  preset = 'ownership';
  await ensurePresetData();
  applyPreset(preset);
  layoutPreset(preset);
  resetAlpha();
  resetView();
  setLegend(preset);
}

async function load(mode, edges){
  const data = await fetchGraph(mode, edges).catch(()=> lastGraph || {nodes:[],edges:[]});
  nodes = data.nodes||[]; edgesData = data.edges||[];
  buildSprites(nodes.map(n=>n.color||0x00ff66));
  // Traits list (build groups)
  await loadTraits();
  // Apply current preset layout if active; otherwise default grid
  if (preset) {
    await ensurePresetData();
    applyPreset(preset);
    layoutPreset(preset);
  } else {
    layoutGrid();
  }
  resetView();
}

async function fetchGraph(mode, edges){
  const q = new URLSearchParams({ mode, edges:String(edges), nodes:'10000', v: String(Date.now()) });
  const r = await fetch(`/api/graph?${q}`, { cache: 'no-store' }).catch(()=>null);
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
    sp.tint = colors[i]||0x00ff66;
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
    sprites[i].x = ox + c*gap + app.renderer.width/2;
    sprites[i].y = oy + r*gap + app.renderer.height/2;
  }
  drawEdges();
  clearSelectionOverlay();
}

function drawEdges(){
  const n = sprites.length;
  try {
    const maxDraw = 500;
    edgesGfx.clear();
    // Draw trading preset gridlines in world space
    try {
      if (preset === 'trading'){
        const COLS = 30, ROWS = 30;
        const cw = app.renderer.width, ch = app.renderer.height;
        const padL=80, padR=80, padT=80, padB=80;
        const gw = Math.max(60, cw - padL - padR);
        const gh = Math.max(60, ch - padT - padB);
        const cellW = gw / COLS;
        const cellH = gh / ROWS;
        const x0 = padL, y0 = padT;
        edgesGfx.lineStyle({ width:1, color:0x2a2a2a, alpha:0.6 });
        for (let c=0;c<=COLS;c++){
          const x = x0 + c*cellW;
          edgesGfx.moveTo(x, y0);
          edgesGfx.lineTo(x, y0 + gh);
        }
        for (let r=0;r<=ROWS;r++){
          const y = y0 + r*cellH;
          edgesGfx.moveTo(x0, y);
          edgesGfx.lineTo(x0 + gw, y);
        }
      }
    } catch {}
    if ((edgesData?.length||0) && edgesData.length <= maxDraw) {
      const mode = modeEl?.value || 'holders';
      for (let e=0;e<edgesData.length;e++){
        const item = edgesData[e];
        const a = Array.isArray(item)? item[0] : (item.a ?? item.source ?? item.from ?? 0);
        const b = Array.isArray(item)? item[1] : (item.b ?? item.target ?? item.to   ?? 0);
        const i = idToIndex.get(Number(a));
        const j = idToIndex.get(Number(b));
        if (i==null || j==null) continue;
        const x1 = sprites[i].x, y1 = sprites[i].y;
        const x2 = sprites[j].x, y2 = sprites[j].y;
        const style = pickEdgeStyle(mode, i, j, item);
        strokeEdge(edgesGfx, x1, y1, x2, y2, style);
      }
    }
  } catch {}
}

// Heat map background (20x20) based on sprite density in world coords
function drawHeatBackground(mode){
  if (!heatGfx || !sprites || !sprites.length){ try{ heatGfx?.clear?.(); }catch{} return; }
  // Only show for trading mode for now; otherwise clear
  if (mode !== 'trading'){ try { heatGfx.clear(); } catch {} return; }
  try {
    heatGfx.clear();
    const cols = 20, rows = 20;
    const b = computeContentBounds(); if (!b) return;
    const w = Math.max(1, b.maxx - b.minx), h = Math.max(1, b.maxy - b.miny);
    const cw = w / cols, ch = h / rows;
    const counts = new Array(cols*rows).fill(0);
    // Count sprites per cell
    for (let i=0;i<sprites.length;i++){
      const sp = sprites[i];
      const xi = Math.max(0, Math.min(cols-1, Math.floor((sp.x - b.minx) / cw)));
      const yi = Math.max(0, Math.min(rows-1, Math.floor((sp.y - b.miny) / ch)));
      counts[yi*cols + xi]++;
    }
    let maxC = 1; for (let k=0;k<counts.length;k++){ if (counts[k]>maxC) maxC=counts[k]; }
    // Draw semi-transparent rectangles; blue->red ramp for trading
    for (let yi=0; yi<rows; yi++){
      for (let xi=0; xi<cols; xi++){
        const c = counts[yi*cols + xi]; if (!c) continue;
        const t = Math.max(0, Math.min(1, c / maxC));
        const col = lerpColor(0x1133aa, 0xff3333, t);
        const x = b.minx + xi*cw, y = b.miny + yi*ch;
        heatGfx.beginFill(col, 0.12 + 0.28*t);
        heatGfx.drawRect(x, y, cw, ch);
        heatGfx.endFill();
      }
    }
  } catch {}
}

function pickEdgeStyle(mode, i, j, item){
  // Prefer explicit type if provided
  const type = (item && typeof item==='object' && item.type) ? String(item.type).toUpperCase() : null;
  if (type && EDGE_STYLES[type]) return EDGE_STYLES[type];
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
  if (s.kind === 'double'){
    const nx = y2 - y1, ny = -(x2 - x1);
    const len = Math.max(1, Math.hypot(nx, ny));
    const off = Math.max(1, s.width*1.2);
    const ox = (nx/len)*off, oy = (ny/len)*off;
    lineSolid(g, x1-ox, y1-oy, x2-ox, y2-oy, s);
    lineSolid(g, x1+ox, y1+oy, x2+ox, y2+oy, s);
    return;
  }
  if (s.kind === 'dashed') return lineDashed(g, x1, y1, x2, y2, s, 8, 6);
  if (s.kind === 'dotted') return lineDashed(g, x1, y1, x2, y2, s, 2, 4);
  return lineSolid(g, x1, y1, x2, y2, s);
}

function lineSolid(g, x1, y1, x2, y2, s){
  g.lineStyle({ width:s.width||1, color:s.color||0x00ff66, alpha:s.opacity??0.6, cap:'round' });
  g.moveTo(x1, y1); g.lineTo(x2, y2);
}

function lineDashed(g, x1, y1, x2, y2, s, dash=6, gap=4){
  const dx = x2-x1, dy = y2-y1; const len = Math.hypot(dx,dy);
  const ux = dx/len, uy = dy/len;
  g.lineStyle({ width:s.width||1, color:s.color||0x666666, alpha:s.opacity??0.5, cap:'butt' });
  let dist = 0; let on=true; let cx=x1, cy=y1;
  while (dist < len){
    const step = on? dash : gap; const nx = cx + ux*step; const ny = cy + uy*step;
    if (on){ g.moveTo(cx, cy); g.lineTo(Math.min(nx, x2), Math.min(ny, y2)); }
    cx = nx; cy = ny; dist += step; on = !on;
  }
}

function clearSelectionOverlay(){ selectGfx?.clear?.(); }
function setLegend(p){
  if (!legendEl) return;
  const text = {
    ownership: 'Color by owner; same-owner links.',
    trading: 'X = last activity, Y = price/ethos; transfer links.',
    rarity: 'Spiral by rarity; grayscale by rarity score.',
    social: 'Cyan brightness/center = higher Ethos.',
    whales: 'Large holders emphasized; wallet relation links.',
    frozen: 'Blue = frozen, Gray = dormant, Green = active.'
  }[p] || '';
  legendEl.textContent = text;
}

// Pan/zoom
function setupPanZoom(){
  stageEl.style.cursor = 'move';
  stageEl.addEventListener('mousedown', e=>{
    camManual = true; pointerDown = true; dragging = false;
    down.x = e.clientX; down.y = e.clientY;
    startPos = { x: world.position.x, y: world.position.y };
  });
  window.addEventListener('mousemove', e=>{
    if (!pointerDown) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragging && (Math.abs(dx)>4 || Math.abs(dy)>4)) dragging = true;
    camSetPos(startPos.x + dx, startPos.y + dy);
  });
  window.addEventListener('mouseup', ()=>{
    if (!pointerDown) return;
    pointerDown = false;
    if (dragging) clampCameraToGraphBounds();
    camAllowAutoSoon();
    dragging = false;
  });
  // Normalize wheel zoom and mark manual control
  window.addEventListener('wheel', (e)=>{
    e.preventDefault(); camManual = true;
    const step = Math.exp(-e.deltaY * 0.0015);
    camSetScale((world.scale.x||1) * step, new PIXI.Point(e.clientX, e.clientY));
    camAllowAutoSoon();
  }, { passive:false });
}

// Selection
function onStageClick(e){
  if (dragging) return; // treat as drag, not click
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
  try {
    const t = await fetch(`/api/token/${id}?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.json());
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
    const sp = sprites[selectedIndex];
    if (sp) focusNode(sp.x, sp.y, 1.2);
    // rarity score from preset data
    await ensurePresetData();
    const idx2 = idToIndex.get(id);
    const rScore = (idx2!=null && presetData?.rarity) ? presetData.rarity[idx2] : null;
    const addrShort = (t.owner||'--').slice(0,6)+'...'+(t.owner||'').slice(-4);
    const ethosValid = (typeof ethos==='number' && isFinite(ethos) && ethos>0);
    const ethosBar = ethosValid ? '█'.repeat(Math.min(10, Math.round((ethos-ethosMin)/(ethosMax-ethosMin)*10))) + '░'.repeat(10 - Math.min(10, Math.round((ethos-ethosMin)/(ethosMax-ethosMin)*10))) : '';
    const trades = meta?.trade_count ?? null;
    const lastSeen = meta?.last_activity ? timeAgo(meta.last_activity*1000) : '--';
    const actLabel = trades!=null ? (trades>40?'Very Active':trades>10?'Active':'Low') : '';
    const status = t.frozen ? 'FROZEN' : (t.dormant ? 'DORMANT' : 'ACTIVE');
    // Similar tokens by rarest trait
    let similar = { similar: [], trait: null };
    try { similar = await fetch(`/api/token/${id}/similar?v=${Date.now()}`, { cache:'no-store' }).then(r=>r.json()); } catch {}
    const sameOwnerChips = (holdings||[]).slice(0,12).filter(x=>x!==id).map(n=>`<span class='chip' data-token='${n}'>#${String(n).padStart(4,'0')}</span>`).join('');
    const similarChips = (similar.similar||[]).slice(0,12).map(n=>`<span class='chip' data-token='${n}'>#${String(n).padStart(4,'0')}</span>`).join('');
    const traitsRows = (t.traits||[]).slice(0,24).map(a=>`<div class='label'>${a.trait_type}</div><div class='value'>${a.trait_value}</div>`).join('');
    const ethosCard = ethosValid ? `
        <div class='card ethos-card'>
          <div class='label'>ETHOS</div>
          <div class='big-number'>${Math.round(ethos)}</div>
          <div class='small-meta'>${ethosBar}</div>
        </div>` : '';
    detailsEl.innerHTML = `
      <div class='token-title'>MAMMOTH #${id.toString().padStart(4,'0')} <span class='token-close' id='close-detail'><i class=\"ri-close-line\"></i></span></div>
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
          <div class='label'>TRADES</div>
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
      <div class='section-label'>TRAITS</div>
      <div class='traits-table'>${traitsRows}</div>
      <div class='section-label'>SIMILAR TOKENS</div>
      <div class='label'>Same Owner (${holdings?holdings.length-1:0})</div>
      <div class='chip-row' id='chips-owner'>${sameOwnerChips||''}</div>
      <div class='label'>Same Rare Traits ${similar.trait?`(${similar.trait.type}: ${similar.trait.value})`:''}</div>
      <div class='chip-row' id='chips-sim'>${similarChips||''}</div>
    `;
    // chip events
    detailsEl.querySelectorAll('.chip').forEach(el=> el.addEventListener('click', ()=>{ const tok = Number(el.dataset.token); const idx = idToIndex.get(tok); if (idx!=null) selectNode(idx); }));
    const closeBtn = document.getElementById('close-detail'); if (closeBtn) closeBtn.onclick = ()=>{ selectedIndex=-1; clearSelectionOverlay(); detailsEl.innerHTML='Select a node…'; thumbEl.style.display='none'; };
    if (!ethosValid && t.owner) {
      setTimeout(async ()=>{
        try {
          const meta2 = await fetch(`/api/wallet/${t.owner}/meta`).then(r=>r.json());
          const e2 = meta2?.ethos_score;
          if (typeof e2 === 'number' && isFinite(e2)) {
            const cont = detailsEl.querySelector('.card2');
            if (cont && !detailsEl.querySelector('.ethos-card')){
              const min = Math.min(ethosMin, 0), max = Math.max(ethosMax, min+1);
              const barN = Math.min(10, Math.max(0, Math.round(((e2-min)/(max-min))*10)));
              const bar = '█'.repeat(barN) + '░'.repeat(10-barN);
              cont.insertAdjacentHTML('afterbegin', `
                <div class='card ethos-card'>
                  <div class='label'>ETHOS</div>
                  <div class='big-number'>${Math.round(e2)}</div>
                  <div class='small-meta'>${bar}</div>
                </div>`);
            }
          }
        } catch {}
      }, 1200);
    }
  } catch { detailsEl.innerHTML = '<div>NO DATA</div>'; }
}

function updateSelectionOverlay(){
  if (!selectGfx) return;
  selectGfx.clear();
  const idx = selectedIndex; if (idx<0 || idx>=sprites.length) return;
  const s = sprites[idx];
  // ring with subtle glow
  selectGfx.lineStyle({ width: 2, color: 0x00ff66, alpha: 1, cap: 'round', join: 'round' });
  selectGfx.drawCircle(s.x, s.y, 8);
  selectGfx.lineStyle({ width: 6, color: 0x00ff66, alpha: 0.15 });
  selectGfx.drawCircle(s.x, s.y, 10);
  // node indicators: ethos ring (gold) if high ethos; whale ring (cyan dashed) if large holdings
  const i = idx;
  try {
    const oi = presetData?.ownerIndex?.[i] ?? -1;
    const ethos = (oi>=0)? (presetData?.ownerEthos?.[oi] ?? null) : null;
    const high = (typeof ethos==='number' && ethos > (ethosMin + (ethosMax-ethosMin)*0.8));
    if (high){ selectGfx.lineStyle({ width:2, color:0xffd700, alpha:1 }); selectGfx.drawCircle(s.x, s.y, 12); }
    if (ownerCounts && oi>=0){
      const hold = ownerCounts[oi] || 0; const maxHold = Math.max(...ownerCounts);
      if (hold >= Math.max(5, maxHold*0.5)){
        // dashed cyan ring
        dashedCircle(selectGfx, s.x, s.y, 14, 0x00ccff, 0.9, 10, 6, 3);
      }
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
        const style = pickEdgeStyle(modeEl?.value||'holders', ia, ib, item);
        if (!layerEnabled(style)) continue;
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

function dashedCircle(g, cx, cy, r, color, alpha, segLen=8, gap=6, width=2){
  g.lineStyle({ width, color, alpha, cap:'butt' });
  const circ = 2*Math.PI*r; const steps = Math.max(8, Math.floor(circ/(segLen+gap)));
  for (let k=0;k<steps;k++){
    const a1 = (k/steps)*2*Math.PI; const a2 = ((k+segLen/(segLen+gap))/steps)*2*Math.PI;
    g.moveTo(cx + Math.cos(a1)*r, cy + Math.sin(a1)*r);
    g.lineTo(cx + Math.cos(a2)*r, cy + Math.sin(a2)*r);
  }
}

function centerOnSprite(sp){
  if (!sp) return;
  focusNode(sp.x, sp.y, 1.2);
}

function focusNode(xWorld, yWorld, targetScale=1.2){
  if (camAnimating) return;
  camAnimating = true; camManual = true;
  const dur = 300, t0 = performance.now();
  const s0 = world.scale.x || 1;
  const p0 = { x: world.position.x, y: world.position.y };
  const screenCenter = new PIXI.Point(app.renderer.width/2, app.renderer.height/2);
  const s1 = Math.min(camMax, Math.max(camMin, targetScale));
  function frame(now){
    const t = Math.min(1, (now - t0) / dur);
    const s = s0 + (s1 - s0) * t;
    camSetScale(s);
    const sx = xWorld * (world.scale.x||1) + world.position.x;
    const sy = yWorld * (world.scale.y||1) + world.position.y;
    camSetPos(p0.x + (screenCenter.x - sx) * t, p0.y + (screenCenter.y - sy) * t);
    if (t < 1) requestAnimationFrame(frame);
    else { camAnimating = false; camAllowAutoSoon(); }
  }
  requestAnimationFrame(frame);
}

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
}

function applyPreset(p){
  if (!sprites.length) return;
  if (!p) { // reset
    for(let i=0;i<sprites.length;i++) sprites[i].tint = nodes[i]?.color||0x00ff66;
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
        sprites[i].tint = frozen ? 0x4488ff : (dormant ? 0x666666 : 0x00ff66); // blue frozen, gray dormant, green active
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
        // Color intensity from blue (dormant) to red (high activity)
        const now = Math.floor(Date.now()/1000);
        const last = presetData?.tokenLastActivity?.[i] || 0;
        const days = last ? (now - last) / 86400 : 365;
        // Normalize by observed max
        let maxDays = 1;
        if (presetData?.tokenLastActivity && presetData.tokenLastActivity.length){
          let tmin=Infinity, tmax=-Infinity; const arr=presetData.tokenLastActivity;
          for (let k=0;k<Math.min(arr.length, sprites.length);k++){ const tt=arr[k]||0; if(tt){ if(tt<tmin) tmin=tt; if(tt>tmax) tmax=tt; } }
          if (isFinite(tmin) && isFinite(tmax) && tmax>tmin) maxDays = Math.max(1, (now - tmin)/86400);
          else maxDays = 365;
        }
        const dn = Math.max(0, Math.min(1, days / maxDays));
        const activity = 1 - dn; // recent => high activity
        const col = lerpColor(0x3366ff, 0xff3333, activity);
        sprites[i].tint = col;
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
        sprites[i].tint = nodes[i]?.color||0x00ff66;
    }
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

function layoutPreset(p){
  if (!sprites.length) return;
  const cw = app.renderer.width, ch = app.renderer.height;
  const cx = cw/2, cy = ch/2;
  const n = sprites.length;
  // Update heat background per preset (clears when not needed)
  drawHeatBackground(p);
  const ownerIndex = presetData?.ownerIndex || [];
  const ownerEthos = presetData?.ownerEthos || [];
  const tokenLast = presetData?.tokenLastActivity || [];
  const tokenPrice = presetData?.tokenPrice || [];
  const tokenTraitKey = presetData?.tokenTraitKey || [];
  const traitKeys = presetData?.traitKeys || [];
  const rarity = presetData?.rarity || [];

  // precompute owner frequencies for whales layout (update module/global)
  ownerCounts = null;
  if (ownerIndex && ownerIndex.length) {
    ownerCounts = new Array(Math.max(...ownerIndex)+1).fill(0);
    for (let i=0;i<ownerIndex.length;i++){ const oi=ownerIndex[i]; if (oi>=0) ownerCounts[oi] = (ownerCounts[oi]||0)+1; }
  }
  try { window.ownerCounts = ownerCounts; } catch {}

  const place = (i, x, y)=>{ const s = sprites[i]; s.x = x; s.y = y; };

  switch(p){
    case 'ownership': {
      // Dense packed bubble clusters by wallet with no overlap between clusters
      const owners = ownerCounts?.length || 0;
      if (!owners) break; // data expected present

      // Build token indices per owner
      const groups = new Array(owners); for (let k=0;k<owners;k++) groups[k] = [];
      for (let i=0;i<n;i++){ const oi = ownerIndex[i] ?? -1; if (oi>=0 && oi<owners) groups[oi].push(i); }

      // Order owners by holdings (desc)
      const order = Array.from({length: owners}, (_, oi)=>oi).sort((a,b)=> (groups[b].length||0) - (groups[a].length||0));

      // Precompute cluster radii per owner (approx packed disc radius)
      const clusterRadius = new Array(owners).fill(0);
      const spacing = 11; // target inter-point spacing (px)
      for (let k=0;k<owners;k++){
        const m = Math.max(1, groups[k].length);
        clusterRadius[k] = Math.sqrt(m/Math.PI) * spacing * 1.15;
      }

      // Greedy circle placement for cluster centers without overlap
      const centers = new Array(owners);
      const placed = [];
      const margin = 8;
      function fits(x,y,r){
        for (let c=0;c<placed.length;c++){
          const j = placed[c];
          const dx=x-centers[j].x, dy=y-centers[j].y; if ((dx*dx+dy*dy) < Math.pow(r + clusterRadius[j] + margin,2)) return false;
        }
        return true;
      }
      if (order.length){ const oi0 = order[0]; centers[oi0] = { x: cx, y: cy }; placed.push(oi0); }
      for (let idx=1; idx<order.length; idx++){
        const oi = order[idx];
        const r = clusterRadius[oi];
        let R = (idx===1 ? (clusterRadius[order[0]] + r + margin) : 60 + Math.sqrt(idx+1)*30);
        let found=false;
        // try increasing rings until fits
        for (let ring=0; ring<200 && !found; ring++){
          const rad = R + ring*10;
          const step = Math.max(0.15, Math.min(0.9, (r + margin) / Math.max(60, rad)));
          for (let a=0; a<Math.PI*2 && !found; a+=step){
            const x = cx + Math.cos(a + ring*0.17) * rad;
            const y = cy + Math.sin(a + ring*0.17) * rad;
            if (fits(x,y,r)) { centers[oi] = { x, y }; placed.push(oi); found=true; }
          }
        }
        if (!found) { // very unlikely: push far out
          centers[oi] = { x: cx + (idx* (r+margin)), y: cy };
          placed.push(oi);
        }
      }

      // Within each owner cluster, pack tokens on Fermat spiral using local spacing
      const ga = Math.PI * (3 - Math.sqrt(5)); // golden angle
      for (let oi=0; oi<owners; oi++){
        const list = groups[oi]; if (!list || !list.length) continue;
        const center = centers[oi] || { x: cx, y: cy };
        const m = list.length;
        const cr = clusterRadius[oi] || 40;
        const local = Math.max(8, (cr * 0.95) / Math.sqrt(Math.max(1, m))); // local spacing so last point ~boundary
        for (let t=0; t<m; t++){
          const a = t * ga;
          const r = local * Math.sqrt(t);
          place(list[t], center.x + Math.cos(a) * r, center.y + Math.sin(a) * r);
        }
      }
      break;
    }
    case 'trading': {
      // Activity heat grid (30x30): x = days ago, y = activity level (recent = high)
      const COLS = 30, ROWS = 30;
      const padL=80, padR=80, padT=80, padB=80;
      const gw = Math.max(60, cw - padL - padR);
      const gh = Math.max(60, ch - padT - padB);
      const cellW = gw / COLS;
      const cellH = gh / ROWS;
      const now = Math.floor(Date.now()/1000);

      // Determine max days span present
      let tmin=Infinity, tmax=-Infinity; for (let i=0;i<n;i++){ const t=tokenLast[i]||0; if(t){ if(t<tmin) tmin=t; if(t>tmax) tmax=t; } }
      let maxDays = 365; if (isFinite(tmin) && isFinite(tmax) && tmax>tmin) maxDays = Math.max(1, Math.ceil((now - tmin)/86400));

      // First pass: bucket tokens into grid cells
      const cellMap = new Map(); // key "x,y" => indices[]
      function key(x,y){ return x+','+y; }
      for (let i=0;i<n;i++){
        const last = tokenLast[i]||0;
        const days = last? (now - last)/86400 : maxDays;
        const dn = Math.max(0, Math.min(1, days / maxDays));
        const xCol = Math.max(0, Math.min(COLS-1, Math.floor(dn * (COLS-1))));
        const activity = 1 - dn; // recent => high
        const yRow = Math.max(0, Math.min(ROWS-1, ROWS-1 - Math.floor(activity * (ROWS-1))));
        const k = key(xCol, yRow);
        if (!cellMap.has(k)) cellMap.set(k, []);
        cellMap.get(k).push(i);
      }

      // Second pass: place tokens within each cell using local spiral
      const cx0 = padL + cellW/2, cy0 = padT + cellH/2;
      const ga = Math.PI * (3 - Math.sqrt(5));
      const padIn = 2; // inner padding within cell
      for (const [k, list] of cellMap.entries()){
        const comma = k.indexOf(',');
        const xi = parseInt(k.slice(0, comma), 10);
        const yi = parseInt(k.slice(comma+1), 10);
        const baseX = cx0 + xi*cellW;
        const baseY = cy0 + yi*cellH;
        const maxR = Math.max(1, Math.min(cellW, cellH)/2 - padIn);
        const m = list.length;
        const step = Math.max(2.2, maxR / Math.sqrt(Math.max(1, m)));
        for (let t=0; t<m; t++){
          const a = t * ga;
          const r = Math.min(maxR, step * Math.sqrt(t));
          place(list[t], baseX + Math.cos(a)*r, baseY + Math.sin(a)*r);
        }
      }
      break;
    }
    case 'rarity': {
      for (let i=0;i<n;i++){
        const r = Math.max(0, Math.min(1, rarity[i]||0));
        const ang = (i*0.1618)%1 * Math.PI*10;
        const rad = 120 + r* Math.min(cx,cy)*0.9;
        place(i, cx + Math.cos(ang)*rad, cy + Math.sin(ang)*rad);
      }
      break;
    }
    case 'social': {
      // Gravity wells around high-ethos wallets
      const owners = ownerCounts?.length || 0;
      if (!owners) break;
      const ga = Math.PI * (3 - Math.sqrt(5));

      // Rank owners by ethos (desc)
      const ethosPairs = [];
      for (let oi=0; oi<owners; oi++){
        const e = ownerEthos?.[oi];
        if (e!=null && isFinite(e)) ethosPairs.push([oi, e]);
      }
      ethosPairs.sort((a,b)=> b[1]-a[1]);
      const K = Math.min(10, Math.max(5, Math.floor(ethosPairs.length*0.05) || 5));
      const top = ethosPairs.slice(0, K).map(p=>p[0]);
      const centerSet = new Set(top);

      // Center positions for gravity wells (no need for perfect packing here)
      const centers = new Map();
      const baseR = 140;
      for (let k=0; k<top.length; k++){
        const theta = k * ga;
        const ring = baseR + Math.sqrt(k+1)*20;
        centers.set(top[k], { x: cx + Math.cos(theta)*ring, y: cy + Math.sin(theta)*ring });
      }

      // Cluster tokens by owner
      const byOwner = new Array(owners); for (let oi=0; oi<owners; oi++) byOwner[oi] = [];
      for (let i=0;i<n;i++){ const oi = ownerIndex[i] ?? -1; if (oi>=0 && oi<owners) byOwner[oi].push(i); }

      // Place top-ethos owner tokens tightly around their center
      for (const oi of top){
        const list = byOwner[oi] || []; if (!list.length) continue;
        const center = centers.get(oi) || { x: cx, y: cy };
        // radius scales with holdings (sqrt law)
        const s = 12; const cr = Math.sqrt(list.length/Math.PI) * s * 1.1;
        const step = Math.max(2.0, (cr*0.95) / Math.sqrt(Math.max(1, list.length)));
        for (let t=0;t<list.length;t++){
          const a = t * ga;
          const r = Math.min(cr, step * Math.sqrt(t));
          place(list[t], center.x + Math.cos(a)*r, center.y + Math.sin(a)*r);
        }
      }

      // Place remaining tokens by ethos to outer radii
      const Rmax = Math.min(cx, cy) * 0.95;
      const Rmin = baseR + 80;
      for (let oi=0; oi<owners; oi++){
        if (centerSet.has(oi)) continue;
        const list = byOwner[oi]; if (!list || !list.length) continue;
        const e = ownerEthos?.[oi];
        const en = (e==null) ? 0.0 : (e - ethosMin) / (ethosMax - ethosMin);
        const R = Rmin + (1 - Math.max(0, Math.min(1, en))) * (Rmax - Rmin);
        // Spread around ring angle based on owner index
        const baseTheta = (oi / Math.max(1, owners)) * Math.PI*2;
        const local = Math.max(6, (Math.min(32, Math.sqrt(list.length))) );
        for (let t=0;t<list.length;t++){
          const a = baseTheta + (t * (ga*0.7));
          const r = R + (prng(list[t]) - 0.5) * local;
          place(list[t], cx + Math.cos(a)*r, cy + Math.sin(a)*r);
        }
      }
      break;
    }
    case 'whales': {
      // Territory map with sized regions; quadratic node scaling by holdings; draw boundaries
      const owners = Math.max(1, (ownerCounts?.length||1));
      const totalHold = ownerCounts ? ownerCounts.reduce((a,b)=>a+(b||0),0) : 1;
      const maxHold = ownerCounts ? Math.max(1, ...ownerCounts) : 1;

      // Build groups per owner
      const groups = new Array(owners); for (let k=0;k<owners;k++) groups[k] = [];
      for (let i=0;i<n;i++){ const oi = ownerIndex[i] ?? -1; if (oi>=0 && oi<owners) groups[oi].push(i); }

      // Compute wedge sizes proportional to holdings
      const wedges = new Array(owners);
      for (let oi=0; oi<owners; oi++){
        const hold = ownerCounts?.[oi] || 0;
        const frac = Math.max(0, hold) / Math.max(1, totalHold);
        wedges[oi] = { oi, hold, frac, angle: frac * Math.PI*2 };
      }
      // Keep deterministic order by oi
      wedges.sort((a,b)=> a.oi - b.oi);

      // Draw boundaries
      clearSelectionOverlay();
      selectGfx.lineStyle({ width: 1, color: 0x116644, alpha: 0.8 });
      const innerR = 110;
      const outerR = 120 + Math.min(cx,cy)*0.85;
      let acc = 0;
      for (let k=0;k<wedges.length;k++){
        const a0 = acc; const a1 = acc + wedges[k].angle; acc = a1;
        const x0 = cx + Math.cos(a0) * innerR, y0 = cy + Math.sin(a0) * innerR;
        const x1 = cx + Math.cos(a0) * outerR, y1 = cy + Math.sin(a0) * outerR;
        selectGfx.moveTo(x0, y0); selectGfx.lineTo(x1, y1);
      }
      // Outer ring boundary
      selectGfx.lineStyle({ width: 1, color: 0x0d5533, alpha: 0.6 });
      for (let t=0;t<=100;t++){
        const a = (t/100)*Math.PI*2;
        const x = cx + Math.cos(a) * outerR;
        const y = cy + Math.sin(a) * outerR;
        if (t===0) selectGfx.moveTo(x,y); else selectGfx.lineTo(x,y);
      }

      // Place tokens within wedges; biggest whales closer to center, quadratic node scaling
      const ga = Math.PI * (3 - Math.sqrt(5));
      acc = 0;
      for (let w=0; w<wedges.length; w++){
        const { oi, hold, angle } = wedges[w];
        const a0 = acc; const a1 = acc + angle; acc = a1; const aw = Math.max(1e-4, a1 - a0);
        const list = groups[oi]; if (!list || !list.length) continue;
        const strength = Math.max(0, Math.min(1, (hold||0) / maxHold));
        const centerR = innerR + (1 - strength) * (outerR - innerR);
        const localR = Math.max(10, Math.min(80, Math.sqrt(list.length) * 6));

        for (let t=0; t<list.length; t++){
          const idx = list[t];
          const a = a0 + ((t * 0.61803398875) % 1) * aw; // spread inside wedge
          const r = centerR + (Math.min(localR, 6 * Math.sqrt(t)) * (prng(idx) - 0.5));
          place(idx, cx + Math.cos(a)*r, cy + Math.sin(a)*r);
          // Quadratic scale by holdings
          const s0 = 0.7, s1 = 2.4;
          const sc = s0 + (s1 - s0) * (strength*strength);
          sprites[idx].scale.set(sc, sc);
        }
      }
      break;
    }
    case 'frozen': {
      // x left/right by recency; y as a tidy grid band
      let tmin=Infinity, tmax=-Infinity; for (let i=0;i<n;i++){ const t=tokenLast[i]||0; if(t){ if(t<tmin) tmin=t; if(t>tmax) tmax=t; } }
      if (!isFinite(tmin) || !isFinite(tmax) || tmin===tmax){ tmin=0; tmax=3600*24*365; }
      const rows = Math.ceil(Math.sqrt(n)); const gap=10;
      for (let i=0;i<n;i++){
        const t = tokenLast[i]||0; const tn = (t-tmin)/(tmax-tmin);
        const x = 80 + tn * (cw-160);
        const r = Math.floor(i/rows); const y = 80 + (r%rows)*gap;
        place(i, x, y);
      }
      break;
    }
    default: return;
  }
  drawEdges();
}

// Toast (console-based minimal)
function showToast(msg){ console.log('[toast]', msg); }
let selectedIndex = -1;
let selectedWalletSet = null;

function resetAlpha(){
  for (let i=0;i<sprites.length;i++) sprites[i].alpha = 0.95;
  // Glow effect for verified holders in SOCIAL preset
  try {
    if (preset === 'social' && presetData){
      const owners = presetData?.ownerIndex?.length ? Math.max(...presetData.ownerIndex)+1 : 0;
      for (let i=0;i<sprites.length;i++){
        const oi = presetData?.ownerIndex?.[i] ?? -1;
        if (oi<0 || oi>=owners) continue;
        let verified = false;
        if (Array.isArray(presetData.ownerVerified)) verified = !!presetData.ownerVerified[oi];
        else {
          const e = presetData?.ownerEthos?.[oi];
          if (e!=null && isFinite(e)){
            const en = (e - ethosMin) / (ethosMax - ethosMin);
            verified = en >= 0.85; // heuristic when explicit flag absent
          }
        }
        if (verified) sprites[i].alpha = 0.995;
      }
    }
  } catch {}
}
function resetView(){
  if (camManual || camAnimating) return;
  const s = 1.2; // slightly zoomed-in default for visibility
  world.scale.set(s);
  const cx = app.renderer.width/2, cy = app.renderer.height/2;
  world.position.set((1-s)*cx, (1-s)*cy);
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

function clampCameraToGraphBounds(){
  clampWorldToContent(40);
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
  if (camManual || camAnimating) return;
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
  el.style.cssText = 'color:#f55;padding:16px;font:12px monospace;background:#111;border-bottom:1px solid #300';
  el.innerHTML = `<b>Failed to initialize</b><br>${(err&&err.message)||err}`;
  document.body.prepend(el);
}

window.addEventListener('load', async ()=>{
  try { await ensurePixi(); await init(); }
  catch(e){ showFatal(e); }
});
