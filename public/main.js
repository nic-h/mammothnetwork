import { createCircleTexture, createParticleContainer } from './pixi-layer.js';
import { throttle, clamp } from './utils.js';

const stageEl = document.getElementById('stage');
const modeEl = document.getElementById('mode');
const edgesEl = document.getElementById('edges');
const edgesToggleEl = document.getElementById('edges-toggle');
const fpsEl = document.getElementById('fps');
const nodeCountEl = document.getElementById('node-count');
const edgeCountEl = document.getElementById('edge-count');
const presetEl = document.getElementById('preset');
const chartEl = document.getElementById('chart');
const chartCanvas = document.getElementById('chart-canvas');
const toastEl = document.getElementById('toast');
const legendEl = document.getElementById('legend');
const filterTraitsBtn = document.getElementById('filter-traits');
// Left sidebar filter elements
const traitTypeEl = document.getElementById('trait-type');
const traitValueEl = document.getElementById('trait-value');
const applyTraitBtn = document.getElementById('apply-trait');
const clearTraitBtn = document.getElementById('clear-trait');
const filterHighEthosEl = document.getElementById('filter-high-ethos');
const filterFrozenEl = document.getElementById('filter-frozen');
const filterDormantEl = document.getElementById('filter-dormant');
const presetsQuickEl = document.getElementById('presets-quick');
const traitSearchEl = document.getElementById('trait-search');
const traitListEl = document.getElementById('trait-list');
const matchCountEl = document.getElementById('match-count');
const toggleSimBtn = document.getElementById('toggle-sim');
const resetBtn = document.getElementById('reset');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const fullscreenBtn = document.getElementById('fullscreen');
const settingsBtn = document.getElementById('settings-btn');
const modal = document.getElementById('modal');
const modalClose = document.getElementById('modal-close');
const toggleGrid = document.getElementById('toggle-grid');
const toggleDecimate = document.getElementById('toggle-decimate');
const loadingEl = document.getElementById('loading');
const searchEl = document.getElementById('search');
const clearSearchBtn = document.getElementById('clear-search');
const tooltip = document.getElementById('tooltip');
// Sidebar elements
const sidebar = document.getElementById('sidebar');
const sbClose = document.getElementById('sb-close');
const sbTitle = document.getElementById('sb-title');
const sbId = document.getElementById('sb-id');
const sbOwner = document.getElementById('sb-owner');
const sbEns = document.getElementById('sb-ens');
const sbEthos = document.getElementById('sb-ethos');
const sbHold = document.getElementById('sb-holdings');
const sbTrades = document.getElementById('sb-trades');
const sbLast = document.getElementById('sb-last');
const sbTraits = document.getElementById('sb-traits');
const sbThumb = document.getElementById('sb-thumb');
const sbConn = document.getElementById('sb-connections');
const sbHist = document.getElementById('sb-history');
const sbSim = document.getElementById('sb-similar');

// PIXI v7: construct with options, append app.view. Also provide mobile fallback.
const appRoot = document.getElementById('app');
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isSmallScreen = window.innerWidth < 768;
if (isMobile || isSmallScreen) {
  appRoot.innerHTML = `
    <div class="mobile-warning">
      <i class="ri-computer-line ri-3x"></i>
      <h2>Desktop Required</h2>
      <p>The Mammoths Network visualization requires a desktop browser for optimal performance.</p>
      <p>10,000 nodes need WebGL and significant GPU resources.</p>
      <a href="https://dash.mammoths.tech" class="button">Visit Dashboard Instead</a>
    </div>
  `;
  throw new Error('Mobile not supported');
}

// PIXI v7: construct with options, append app.view
const resolution = Math.min(window.devicePixelRatio || 1, 2);
if (!PIXI.utils.isWebGLSupported()) {
  console.warn('WebGL not supported');
}
const app = new PIXI.Application({
  width: stageEl.clientWidth,
  height: stageEl.clientHeight,
  backgroundColor: 0x000000,
  resolution,
  antialias: false,
  resizeTo: stageEl,
});
stageEl.appendChild(app.view);
// Ensure renderer sizes after layout
setTimeout(() => {
  try { app.renderer.resize(stageEl.clientWidth, stageEl.clientHeight); } catch {}
}, 0);
try {
  const ro = new ResizeObserver(() => {
    try { app.renderer.resize(stageEl.clientWidth, stageEl.clientHeight); } catch {}
  });
  ro.observe(stageEl);
} catch {}

// World container for pan/zoom
const world = new PIXI.Container();
app.stage.addChild(world);
world.position.set(app.renderer.width / 2, app.renderer.height / 2);

// Node rendering via ParticleContainer with circle texture
const CAPACITY = 10000;
const nodeContainer = createParticleContainer(CAPACITY);
world.addChild(nodeContainer);
const circleTexture = createCircleTexture(app, 10, 0x00ff66);

// Hover highlight
const highlight = new PIXI.Sprite(circleTexture);
highlight.anchor.set(0.5);
highlight.tint = 0xffffff;
highlight.alpha = 0.8;
highlight.visible = false;
highlight.scale.set(1.4);
world.addChild(highlight);

// Camera state
let zoom = 1;
const zoomMin = 0.15, zoomMax = 6;

// Graph state
let nodes = []; // {id, color}
let sprites = []; // PIXI.Sprite for each node
let edgesData = []; // [a,b,w]
const edgesLayer = new PIXI.Graphics();
world.addChild(edgesLayer);
// Grid background
const gridLayer = new PIXI.Graphics();
world.addChildAt(gridLayer, 0);
function drawGrid() {
  gridLayer.clear();
  gridLayer.lineStyle(1, 0x111111, 0.3);
  const size = 100;
  const span = 5000;
  for (let x = -span; x <= span; x += size) {
    gridLayer.moveTo(x, -span);
    gridLayer.lineTo(x, span);
  }
  for (let y = -span; y <= span; y += size) {
    gridLayer.moveTo(-span, y);
    gridLayer.lineTo(span, y);
  }
}
drawGrid();
let decimate = true;
let lastTickAt = performance.now();
let frames = 0;
let paused = false;
let worker = null;
let workerTicked = false;
let filter = { type: 'none', ids: null, address: null };
let lastHoverIndex = -1;
let edgesVisible = true;
const walletMetaCache = new Map();
let presetData = null;
let preset = 'none';
let chartMode = 'none';
let selectedIndex = -1;
const selectedLayer = new PIXI.Graphics();
world.addChild(selectedLayer);
let allTraits = null;
let traitFilterIds = null; // Set of ids matching selected trait
let highEthosActive = false;
let frozenActive = false;
let dormantActive = false;

function setupWorker(count, edges) {
  if (worker) worker.terminate();
  workerTicked = false;
  try {
    worker = new Worker('/sim.worker.js', { type: 'module' });
  } catch {
    try { worker = new Worker('/sim.worker.js'); } catch { worker = null; }
  }
  if (worker) {
    worker.onmessage = (e) => {
      const { type, positions } = e.data;
      if (type === 'tick' && positions) {
        workerTicked = true;
        applyPositions(positions.x, positions.y);
      }
    };
    worker.postMessage({ type: 'init', payload: { nodes: count, edges } });
    if (presetData) worker.postMessage({ type: 'setPresetData', payload: presetData });
    if (preset) worker.postMessage({ type: 'setPreset', payload: { preset } });
  }
  // First-frame fallback if worker hasn’t ticked
  setTimeout(() => {
    if (!workerTicked) {
      const px = new Float32Array(count);
      const py = new Float32Array(count);
      for (let i=0;i<count;i++){
        const a = i * 0.005, r = 50 + (i%200) * 2;
        px[i] = Math.cos(a)*r; py[i] = Math.sin(a)*r;
      }
      applyPositions(px, py);
      showToast('Worker slow — showing first frame');
    }
  }, 800);
}

function applyPositions(px, py) {
  const n = Math.min(sprites.length, px.length, py.length);
  for (let i = 0; i < n; i++) {
    const s = sprites[i];
    s.x = px[i];
    s.y = py[i];
  }
  // redraw edges if edge count is small
  if (edgesData.length && edgesData.length <= 500) {
    drawEdges(px, py);
  }
  // draw selection ring
  selectedLayer.clear();
  if (selectedIndex >= 0 && selectedIndex < sprites.length) {
    const sx = px[selectedIndex];
    const sy = py[selectedIndex];
    selectedLayer.lineStyle(2, 0x00ff66, 0.9);
    selectedLayer.drawCircle(sx, sy, 12);
  }
  frames++;
}

function clearGraph() {
  for (const s of sprites) s.destroy();
  sprites = [];
  nodeContainer.removeChildren();
}

function createGraph(n, colors) {
  clearGraph();
  const count = Math.min(n, CAPACITY);
  for (let i = 0; i < count; i++) {
    const sp = new PIXI.Sprite(circleTexture);
    sp.anchor.set(0.5);
    // Status-based coloring already embedded in node color; apply alpha for dormant
    sp.tint = colors[i] || 0x00ff66;
    sp.x = 0; sp.y = 0;
    const isDormant = !!(nodes[i]?.dormant);
    sp.alpha = isDormant ? 0.5 : 0.95;
    const s = 0.5; // radius scaling
    sp.scale.set(s, s);
    sprites.push(sp);
  }
  nodeContainer.addChild(...sprites);
}

async function fetchGraph(mode, edges) {
  const q = new URLSearchParams({ mode, edges: String(edges), nodes: '10000' });
  const t0 = performance.now();
  const res = await fetch(`/api/graph?${q.toString()}`, { cache: 'no-store' }).catch(()=>null);
  if (!res || !res.ok) { showToast('Graph fetch failed'); throw new Error('graph fetch failed'); }
  const data = await res.json().catch(()=>({ nodes:[], edges:[], meta:{} }));
  const t1 = performance.now();
  console.log(`Graph fetched in ${Math.round(t1 - t0)}ms`, data.meta);
  return data;
}

async function load(mode, edges) {
  showLoadingBar('Loading graph…');
  loadingEl.style.display = 'block';
  const data = await fetchGraph(mode, edges).catch((e)=>{ console.warn(e); return { nodes:[], edges:[], meta:{} }; });
  nodes = data.nodes;
  nodeCountEl.textContent = `nodes: ${nodes.length}`;
  edgeCountEl.textContent = `edges: ${data.edges.length}`;
  const colors = nodes.map(n => n.color);
  createGraph(nodes.length, colors);
  edgesData = data.edges || [];
  edgesLayer.clear();
  edgesLayer.visible = edgesVisible;
  setupWorker(nodes.length, data.edges);
  loadingEl.style.display = 'none';
  hideLoadingBar();
  // lazy-load traits list for left panel
  if (!allTraits) {
    try {
      const r = await fetch('/api/traits').catch(()=>null);
      if (!r || !r.ok) throw new Error('traits fetch failed');
      const t = await r.json();
      allTraits = t.traits || [];
      traitTypeEl.innerHTML = '<option value="">(select)</option>' + allTraits.map(x=>`<option value="${x.type}">${x.type}</option>`).join('');
      traitValueEl.innerHTML = '<option value="">(value)</option>';
      renderTraitList();
    } catch { showToast('Traits unavailable');
      traitTypeEl.innerHTML = '<option value="">(none)</option>';
      traitValueEl.innerHTML = '<option value="">(none)</option>'; }
  }
}

// Pan/zoom interactions
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let worldStart = { x: 0, y: 0 };

app.view.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  worldStart = { x: world.position.x, y: world.position.y };
});
window.addEventListener('mouseup', () => isDragging = false);
window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    world.position.set(worldStart.x + dx, worldStart.y + dy);
  }
});

function zoomAt(factor, clientX, clientY) {
  zoom = clamp(zoom * factor, zoomMin, zoomMax);
  const mouse = { x: clientX, y: clientY };
  const worldPosBefore = world.toLocal(mouse);
  world.scale.set(zoom);
  const worldPosAfter = world.toLocal(mouse);
  world.position.x += (worldPosAfter.x - worldPosBefore.x) * world.scale.x;
  world.position.y += (worldPosAfter.y - worldPosBefore.y) * world.scale.y;
}

app.view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = -e.deltaY;
  const factor = Math.exp(delta * 0.001);
  zoomAt(factor, e.clientX, e.clientY);
}, { passive: false });

// Hover detection (throttled)
const onPointerMove = throttle((e) => {
  const pt = world.toLocal({ x: e.clientX, y: e.clientY });
  const r2 = (14 / zoom) * (14 / zoom);
  let best = -1, bestD2 = r2;
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    const dx = s.x - pt.x;
    const dy = s.y - pt.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best >= 0) {
    const s = sprites[best];
    highlight.visible = true;
    highlight.position.copyFrom(s.position);
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX + 8}px`;
    tooltip.style.top = `${e.clientY + 8}px`;
    const id = best + 1;
    tooltip.textContent = `#${id}`;
    if (lastHoverIndex !== best) {
      lastHoverIndex = best;
      fetchOwner(id);
    }
  } else {
    highlight.visible = false;
    tooltip.style.display = 'none';
    lastHoverIndex = -1;
  }
}, 60);

window.addEventListener('mousemove', onPointerMove);

// Node click → open sidebar with details
app.view.addEventListener('click', async (e) => {
  const pt = world.toLocal({ x: e.clientX, y: e.clientY });
  const r2 = (14 / zoom) * (14 / zoom);
  let best = -1, bestD2 = r2;
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    const dx = s.x - pt.x;
    const dy = s.y - pt.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best >= 0) {
    selectedIndex = best;
    showDetails(best + 1);
  }
});

// Double click to isolate network
app.view.addEventListener('dblclick', (e) => {
  if (selectedIndex >= 0) {
    const id = selectedIndex + 1;
    isolateNodeNetwork(id);
  }
});

document.addEventListener('keydown', (e) => {
  if (selectedIndex < 0) return;
  if (e.key === 'f') centerOnNode(selectedIndex);
  else if (e.key === 'c') toggleConnectionView();
  else if (e.key === 'Escape') clearSelection();
});

sbClose?.addEventListener('click', () => { sidebar.style.display = 'none'; });

async function showDetails(id) {
  try {
    const t = await fetch(`/api/token/${id}`).then(r=>r.json());
    sbTitle.textContent = t.name || `Mammoth #${id}`;
    sbId.textContent = `#${id}`;
    sbOwner.textContent = t.owner || '--';
    sbTraits.innerHTML = '';
    const traits = Array.isArray(t.traits) ? t.traits : [];
    for (const a of traits.slice(0, 24)) {
      const div = document.createElement('div');
      div.className = 'tag';
      div.textContent = `${a.trait_type}: ${a.trait_value}`;
      sbTraits.appendChild(div);
    }
    // image thumb if available
    sbThumb.innerHTML = '';
    const th = t.thumbnail_local || t.image_local;
    if (th) {
      const img = document.createElement('img');
      img.src = `/${th}`;
      sbThumb.appendChild(img);
    }
    // wallet meta (ens, ethos, holdings, trades, last activity)
    let ens = null, ethos = null, hold = null, trades = null, last = t.last_activity || null;
    if (t.owner) {
      const wm = await fetch(`/api/wallet/${t.owner.toLowerCase()}/meta`).then(r=>r.json()).catch(()=>null);
      if (wm) {
        ens = wm.ens_name || null;
        ethos = wm.ethos_score ?? null;
        hold = wm.total_holdings ?? null;
        trades = wm.trade_count ?? null;
        if (!last) last = wm.last_activity || null;
      }
      // Ethos profile proxy (v2 user + score) enrich panel
      try {
        const ep = await fetch(`/api/ethos/profile?address=${t.owner.toLowerCase()}`).then(r=>r.json());
        const box = document.getElementById('detail-ethos');
        if (box) {
          if (!ep || !ep.ok || !ep.found) {
            box.innerHTML = '<div class="row">No Ethos profile</div>';
          } else {
            box.innerHTML = `
              <div class="row">
                ${ep.avatarUrl ? `<img src="${ep.avatarUrl}" width="28" height="28" style="border-radius:50%;object-fit:cover;margin-right:8px"/>` : ''}
                <div>
                  <div>${ep.displayName || ''} ${ep.username ? `@${ep.username}` : ''}</div>
                  <div>Ethos score: <b>${ep.score ?? 'n/a'}</b> ${ep.level ? `(${ep.level})` : ''}</div>
                </div>
              </div>
              ${ep.links?.profile ? `<a href="${ep.links.profile}" target="_blank" rel="noopener">Open Ethos</a>` : ''}
            `;
            if (typeof ep.score === 'number') {
              const level = (ep.level || '').toLowerCase();
              const high = ep.score >= 1400 || ['established','reputable','exemplary','distinguished','revered','renowned'].includes(level);
              if (high) sbEthos.innerHTML = `${ep.score} <span class="badge core">${ep.level || 'core'}</span>`;
              else sbEthos.textContent = String(ep.score);
            }
          }
        }
      } catch {}

      // connections (neighbors) and stats
      const connected = getConnections(id);
      sbConn.innerHTML = `<div class="row"><b>Connected To</b></div>` +
        `<div>${connected.list.slice(0,20).map(n=>`<a href="#" data-id="${n}">#${n}</a>`).join(' ')}</div>` +
        `<div class="row">${connected.count} connections</div>`;
      sbConn.querySelectorAll('a[data-id]')?.forEach(a => a.addEventListener('click', (ev)=>{ ev.preventDefault(); const nid = Number(a.dataset.id); selectedIndex = nid-1; showDetails(nid); centerOnNode(nid-1); }));

      // history (transfers with price)
      try {
        const h = await fetch(`/api/token/${id}/transfers`).then(r=>r.json());
        const rows = (h.transfers||[]).slice(0,20);
        sbHist.innerHTML = `<div class="row"><b>Trading History</b></div>` + rows.map(r=>{
          const d = r.timestamp ? new Date(r.timestamp*1000).toLocaleDateString() : '';
          const p = (r.price!=null) ? `${Number(r.price).toFixed(2)}Ξ` : '';
          const f = r.from_addr ? r.from_addr.slice(0,6)+'…'+r.from_addr.slice(-4) : '';
          const tto = r.to_addr ? r.to_addr.slice(0,6)+'…'+r.to_addr.slice(-4) : '';
          return `<div class="row"><span>${d}</span><span>${p}</span><span>${f} → ${tto}</span></div>`;
        }).join('');
      } catch {}

      // similar tokens (by rare trait)
      try {
        const s = await fetch(`/api/token/${id}/similar`).then(r=>r.json());
        const sims = (s.similar||[]).slice(0,20);
        sbSim.innerHTML = `<div class="row"><b>Similar Tokens</b></div>` +
          `<div>${sims.map(n=>`<a href="#" data-id="${n}">#${n}</a>`).join(' ')}</div>`;
        sbSim.querySelectorAll('a[data-id]')?.forEach(a => a.addEventListener('click', (ev)=>{ ev.preventDefault(); const nid = Number(a.dataset.id); selectedIndex = nid-1; showDetails(nid); centerOnNode(nid-1); }));
      } catch {}
    }
    sbEns.textContent = ens || '--';
    sbEthos.textContent = ethos != null ? String(ethos) : '--';
    sbHold.textContent = hold != null ? String(hold) : '--';
    sbTrades.textContent = trades != null ? String(trades) : '--';
    sbLast.textContent = last ? new Date(last*1000).toLocaleString() : '--';
    sidebar.style.display = 'block';
  } catch (e) {
    console.warn('detail load failed', e);
  }
}

function getNodeAt(clientX, clientY) {
  const pt = world.toLocal({ x: clientX, y: clientY });
  const r2 = (14 / zoom) * (14 / zoom);
  let best=-1,bestD2=r2;
  for (let i=0;i<sprites.length;i++){
    const s=sprites[i]; const dx=s.x-pt.x, dy=s.y-pt.y; const d2=dx*dx+dy*dy;
    if (d2<bestD2){bestD2=d2; best=i;}
  }
  return best;
}

function getConnections(nodeId) {
  const connected = new Set();
  let count = 0;
  for (let k=0;k<edgesData.length;k++){
    const [a,b] = edgesData[k];
    if (a===nodeId) { connected.add(b); count++; }
    else if (b===nodeId) { connected.add(a); count++; }
  }
  return { list: Array.from(connected), count };
}

function drawConnectedEdges(nodeId, connected) {
  edgesLayer.clear();
  edgesLayer.alpha = 0.9;
  edgesLayer.stroke({ width: 2, color: 0x00ffaa, alpha: 0.9 });
  for (let k=0;k<edgesData.length;k++){
    const [a,b,w] = edgesData[k];
    if (a!==nodeId && b!==nodeId) continue;
    const i=a-1, j=b-1;
    if (i<0||j<0||i>=sprites.length||j>=sprites.length) continue;
    const x1=sprites[i].x, y1=sprites[i].y, x2=sprites[j].x, y2=sprites[j].y;
    edgesLayer.moveTo(x1,y1).lineTo(x2,y2);
  }
}

function showConnections(nodeId) {
  const conn = getConnections(nodeId);
  for (let i=0;i<sprites.length;i++){
    const id=i+1;
    if (id===nodeId) { sprites[i].alpha=1.0; sprites[i].scale.set(0.8); }
    else if (conn.list.includes(id)) { sprites[i].alpha=0.9; sprites[i].tint=0x00ffaa; }
    else { sprites[i].alpha=0.1; }
  }
  drawConnectedEdges(nodeId, new Set(conn.list));
  centerOnNode(nodeId-1);
}

let connectionView=false;
function isolateNodeNetwork(nodeId){ connectionView=true; showConnections(nodeId); }
function toggleConnectionView(){ connectionView=!connectionView; if (!connectionView){ applyPresetColors(); updateFilterVisuals(); } else if (selectedIndex>=0) showConnections(selectedIndex+1); }
function clearSelection(){ selectedIndex=-1; connectionView=false; applyPresetColors(); updateFilterVisuals(); }

// Pointer (touch) support
let activePointers = new Map();
let lastPinchDist = null;

function onPointerDown(e){
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  isDragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  worldStart = { x: world.position.x, y: world.position.y };
}
function onPointerUp(e){
  activePointers.delete(e.pointerId);
  if (activePointers.size === 0) { isDragging = false; lastPinchDist = null; }
}
function onPointerMove(e){
  if (activePointers.size === 2) {
    const pts = Array.from(activePointers.values());
    const other = (e.pointerId === Array.from(activePointers.keys())[0]) ? pts[1] : pts[0];
    const dx = e.clientX - other.x; const dy = e.clientY - other.y; const dist = Math.hypot(dx, dy);
    if (lastPinchDist != null) {
      const factor = dist / (lastPinchDist || dist);
      zoomAt(factor, (e.clientX + other.x)/2, (e.clientY + other.y)/2);
    }
    lastPinchDist = dist;
  } else if (isDragging) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    world.position.set(worldStart.x + dx, worldStart.y + dy);
  }
}

app.view.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('pointermove', onPointerMove);

// UI wiring
modeEl.addEventListener('change', async () => {
  await load(modeEl.value, Number(edgesEl.value));
});
edgesEl.addEventListener('input', throttle(async () => {
  await load(modeEl.value, Number(edgesEl.value));
}, 400));

toggleSimBtn.addEventListener('click', () => {
  paused = !paused;
  toggleSimBtn.title = paused ? 'Resume' : 'Pause';
  worker?.postMessage({ type: paused ? 'pause' : 'resume' });
});

resetBtn.addEventListener('click', () => {
  worker?.postMessage({ type: 'reset' });
});

// Search / filter: token id or wallet address
searchEl.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const q = searchEl.value.trim();
    await applyFilter(q);
  } else if (e.key === 'Escape') {
    searchEl.value = '';
    clearFilter();
  }
});

clearSearchBtn.addEventListener('click', () => {
  searchEl.value = '';
  clearFilter();
});

edgesToggleEl.addEventListener('change', () => {
  edgesVisible = !!edgesToggleEl.checked;
  edgesLayer.visible = edgesVisible;
});

// Left panel: trait filters
traitTypeEl?.addEventListener('change', () => {
  const t = traitTypeEl.value;
  const entry = (allTraits || []).find(x=>x.type===t);
  traitValueEl.innerHTML = '<option value="">(value)</option>' + (entry ? entry.values.map(v=>`<option value="${v.value}">${v.value} (${v.count})</option>`).join('') : '');
});
applyTraitBtn?.addEventListener('click', async () => {
  const type = traitTypeEl.value; const value = traitValueEl.value;
  if (!type || !value) return;
  try {
    const r = await fetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`).then(r=>r.json());
    const ids = new Set((r.tokens || []).map(Number));
    traitFilterIds = ids;
    applyCombinedFilters();
  } catch {}
});
clearTraitBtn?.addEventListener('click', () => {
  traitFilterIds = null; highEthosActive = false; filterHighEthosEl.checked = false; clearFilter();
});
filterHighEthosEl?.addEventListener('change', () => {
  highEthosActive = !!filterHighEthosEl.checked;
  applyCombinedFilters();
});
filterFrozenEl?.addEventListener('change', () => { frozenActive = !!filterFrozenEl.checked; applyCombinedFilters(); });
filterDormantEl?.addEventListener('change', () => { dormantActive = !!filterDormantEl.checked; applyCombinedFilters(); });
presetsQuickEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  preset = btn.dataset.preset;
  presetEl.value = preset;
  worker?.postMessage({ type: 'setPreset', payload: { preset } });
});
traitSearchEl?.addEventListener('input', () => renderTraitList());

function renderTraitList() {
  const q = (traitSearchEl.value || '').toLowerCase();
  const list = (allTraits || []).filter(t => t.type.toLowerCase().includes(q) || (t.values||[]).some(v => String(v.value).toLowerCase().includes(q)));
  traitListEl.innerHTML = list.map(t => `
    <div class="t">
      <div class="h">${t.type}</div>
      <div class="vals">${(t.values||[]).slice(0,50).map(v=>`<span class="v" data-type="${t.type}" data-value="${v.value}">${v.value} (${v.count})</span>`).join('')}</div>
    </div>
  `).join('');
}

traitListEl?.addEventListener('click', async (e) => {
  const el = e.target.closest('.v');
  if (!el) return;
  const type = el.dataset.type; const value = el.dataset.value;
  try {
    const r = await fetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`).then(r=>r.json());
    const ids = new Set((r.tokens || []).map(Number));
    traitFilterIds = ids;
    applyCombinedFilters();
  } catch {}
});

function applyCombinedFilters() {
  // base set = all indices
  let selected = null;
  if (traitFilterIds) {
    selected = traitFilterIds;
  }
  if (highEthosActive) {
    // require presetData.ownerEthos
    if (!presetData) return; // wait until preset data loaded
    const ownerIdx = presetData.ownerIndex || [];
    const ownerEth = presetData.ownerEthos || [];
    const passing = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const oi = ownerIdx[i] ?? -1;
      const sc = oi >= 0 ? (ownerEth[oi] ?? null) : null;
      const ok = sc != null && sc >= 1400;
      if (ok) passing.add(i+1);
    }
    if (selected) {
      // intersection by token id
      const inter = new Set();
      for (const id of selected) if (passing.has(id)) inter.add(id);
      selected = inter;
    } else {
      selected = passing;
    }
  }
  if (frozenActive || dormantActive) {
    const status = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const frozen = !!nodes[i]?.frozen;
      const dormant = !!nodes[i]?.dormant;
      if ((frozenActive && frozen) || (dormantActive && dormant)) status.add(i+1);
    }
    if (selected) {
      const inter = new Set();
      for (const id of selected) if (status.has(id)) inter.add(id);
      selected = inter;
    } else {
      selected = status;
    }
  }
  if (selected && selected.size) {
    filter = { type: 'ids', ids: selected, address: null };
    updateFilterVisuals();
    updateMatchCount(selected);
  } else {
    clearFilter();
    matchCountEl.textContent = '--';
  }
}

function updateMatchCount(selectedIds) {
  const total = selectedIds.size;
  if (!presetData || !presetData.ownerIndex) { matchCountEl.textContent = String(total); return; }
  const ownerIdx = presetData.ownerIndex;
  const owners = new Set();
  for (const id of selectedIds) {
    const i = id-1; const oi = ownerIdx[i] ?? -1;
    if (oi >= 0) owners.add(oi);
  }
  matchCountEl.textContent = `${total} tokens · ${owners.size} wallets`;
}

// Toast + legend + color helpers
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>{ toastEl.style.display='none'; }, 1600);
}

function updateLegend(p) {
  if (!legendEl) return;
  const lines = {
    ownership: 'Owner clusters; color by node tint',
    trading: 'X=time, Y=price; edges off for clarity',
    traits: 'Sectors by trait; rarest attribute pulls position',
    social: 'Higher Ethos near core',
    rarity: 'Gray→Gold by rarity; discovery highlights top',
    activity: 'Inactive tokens faded',
    hubs: 'Major wallet connections emphasized',
    whales: 'Concentric rings by holding bands',
    frozen: 'Blue=frozen, Green=active',
    discovery: 'Highlights rare + high‑Ethos combos'
  };
  legendEl.textContent = lines[p] || '';
}

function hex(n) { return [(n>>16)&0xff, (n>>8)&0xff, n&0xff]; }
function rgb(r,g,b){ return (r<<16)|(g<<8)|b; }
function lerp(a,b,t){ return a+(b-a)*t; }
function lerpColor(c1, c2, t) {
  const [r1,g1,b1] = hex(c1), [r2,g2,b2] = hex(c2);
  return rgb(Math.round(lerp(r1,r2,t)), Math.round(lerp(g1,g2,t)), Math.round(lerp(b1,b2,t)));
}

async function applyPresetColors() {
  if (!presetData) {
    const res = await fetch('/api/preset-data?nodes=10000', { cache: 'no-store' });
    presetData = await res.json();
  }
  const ownerIdx = presetData.ownerIndex || [];
  const ownerEth = presetData.ownerEthos || [];
  const rar = presetData.rarity || [];
  if (preset === 'rarity') {
    for (let i = 0; i < sprites.length; i++) {
      const t = Math.max(0, Math.min(1, rar[i] || 0));
      sprites[i].tint = lerpColor(0x444444, 0xFFD700, t);
    }
  } else if (preset === 'activity') {
    const now = Date.now()/1000;
    const last = presetData.tokenLastActivity || [];
    for (let i=0;i<sprites.length;i++){
      const ageDays = last[i] ? (now - last[i]) / 86400 : 999;
      const fresh = ageDays < 14;
      sprites[i].tint = fresh ? 0x00FF66 : 0xFF3333;
    }
  } else if (preset === 'social') {
    for (let i=0;i<sprites.length;i++){
      const oi = ownerIdx[i] ?? -1;
      const sc = oi>=0 ? (ownerEth[oi] ?? 0) : 0;
      const t = Math.max(0, Math.min(1, sc / 2000));
      sprites[i].tint = lerpColor(0x0066FF, 0x00FF66, t);
    }
  } else if (preset === 'frozen') {
    for (let i=0;i<sprites.length;i++){
      sprites[i].tint = nodes[i]?.frozen ? 0x0099FF : 0x00FF66;
    }
  } else if (preset === 'discovery') {
    for (let i=0;i<sprites.length;i++){
      const oi = ownerIdx[i] ?? -1;
      const sc = oi>=0 ? (ownerEth[oi] ?? 0) : 0;
      const score = (rar[i]||0)*0.7 + (sc/2800)*0.3;
      if (score > 0.85) { sprites[i].tint = 0x66FF99; sprites[i].scale.set(0.7); }
      else { sprites[i].tint = nodes[i]?.color || 0x00ff66; sprites[i].scale.set(0.5); }
    }
  } else {
    for (let i=0;i<sprites.length;i++){
      sprites[i].tint = nodes[i]?.color || 0x00ff66;
      sprites[i].scale.set(0.5);
    }
  }
}

// Toggle left panel via control button
document.getElementById('filter-traits')?.addEventListener('click', () => {
  const left = document.getElementById('leftbar');
  if (!left) return;
  const visible = left.style.display !== 'none';
  left.style.display = visible ? 'none' : 'block';
  stageEl.style.left = visible ? '0' : '260px';
});

// Loading bar helpers
function showLoadingBar(text) {
  const el = document.getElementById('loading-bar');
  if (!el) return;
  const txt = el.querySelector('.loading-text');
  if (txt) txt.textContent = text || 'Loading…';
  el.classList.add('show');
}
function hideLoadingBar() {
  const el = document.getElementById('loading-bar');
  if (!el) return;
  el.classList.remove('show');
}

// Zoom buttons
zoomInBtn?.addEventListener('click', () => {
  zoomAt(1.2, app.renderer.width/2, app.renderer.height/2);
});
zoomOutBtn?.addEventListener('click', () => {
  zoomAt(1/1.2, app.renderer.width/2, app.renderer.height/2);
});

// Fullscreen
fullscreenBtn?.addEventListener('click', async () => {
  const el = document.documentElement;
  if (!document.fullscreenElement) await el.requestFullscreen().catch(()=>{});
  else await document.exitFullscreen().catch(()=>{});
});

// Modal
settingsBtn?.addEventListener('click', ()=> modal.style.display='flex');
modalClose?.addEventListener('click', ()=> modal.style.display='none');
toggleGrid?.addEventListener('change', ()=> { gridLayer.visible = toggleGrid.checked; });
toggleDecimate?.addEventListener('change', ()=> { decimate = toggleDecimate.checked; });

presetEl.addEventListener('change', async () => {
  preset = presetEl.value;
  if (!presetData) {
    const res = await fetch('/api/preset-data?nodes=10000', { cache: 'no-store' });
    presetData = await res.json();
    worker?.postMessage({ type: 'setPresetData', payload: presetData });
  }
  worker?.postMessage({ type: 'setPreset', payload: { preset } });
  // Visual tweaks for certain presets
  if (preset === 'activity') {
    // fade based on last activity
    const now = Date.now() / 1000;
    for (let i = 0; i < sprites.length; i++) {
      const t = presetData?.tokenLastActivity?.[i] || 0;
      const ageDays = t ? (now - t) / 86400 : 999;
      const a = Math.max(0.15, Math.min(1, 1.3 - Math.log10(1 + ageDays)));
      sprites[i].alpha = a;
    }
  } else if (preset === 'discovery') {
    // highlight top 2000 by rarity+ethos proxy
    const r = presetData?.rarity || [];
    for (let i = 0; i < sprites.length; i++) {
      const ownerIdx = presetData?.ownerIndex?.[i] ?? -1;
      const ethos = ownerIdx >= 0 ? (presetData?.ownerEthos?.[ownerIdx] ?? 0) : 0;
      const score = (r[i] || 0) * 0.7 + (ethos / 2800) * 0.3;
      if (score > 0.85) {
        sprites[i].tint = 0x66ff99;
        sprites[i].scale.set(0.7);
      } else {
        sprites[i].tint = nodes[i]?.color || 0x00ff66;
        sprites[i].scale.set(0.5);
      }
    }
  } else {
    // reset alphas/tints for other presets
    for (let i = 0; i < sprites.length; i++) {
      sprites[i].alpha = 0.95;
      sprites[i].tint = nodes[i]?.color || 0x00ff66;
      sprites[i].scale.set(0.5);
    }
  }
  const descriptions = {
    'ownership': '🏠 Groups tokens by wallet owner',
    'trading': '💱 Shows trading flow patterns',
    'traits': '🧬 Clusters by rare trait combinations',
    'social': '👥 High Ethos wallets at center',
    'rarity': '💎 Rarest NFTs highlighted',
    'activity': '🔥 Fades inactive tokens',
    'hubs': '🌐 Major wallet connections',
    'whales': '🐋 Largest holders as rings',
    'frozen': '❄️ Fresh vs frozen separation',
    'discovery': '✨ Hidden gems highlighted'
  };
  loadingEl.textContent = `Applying ${preset} preset...`;
  loadingEl.style.display = 'block';
  showToast(descriptions[preset] || 'Applying preset...');
  applyPresetColors();
  updateLegend(preset);
  setTimeout(()=>{ loadingEl.style.display='none'; }, 500);
});

async function applyFilter(q) {
  if (!q) return clearFilter();
  if (/^\d+$/.test(q)) {
    const id = Math.max(1, Math.min(nodes.length, parseInt(q, 10)));
    filter = { type: 'ids', ids: new Set([id]), address: null };
    updateFilterVisuals();
    centerOnNode(id - 1);
  } else if (/^0x[a-fA-F0-9]{40}$/.test(q)) {
    const res = await fetch(`/api/wallet/${q.toLowerCase()}`).then(r => r.ok ? r.json() : { tokens: [] }).catch(() => ({ tokens: [] }));
    const ids = new Set((res.tokens || []).map(n => Number(n)));
    filter = { type: 'ids', ids, address: q.toLowerCase() };
    updateFilterVisuals();
  } else {
    // unsupported query type
    clearFilter();
  }
}

function clearFilter() {
  filter = { type: 'none', ids: null, address: null };
  updateFilterVisuals();
}

function updateFilterVisuals() {
  if (filter.type === 'none' || !filter.ids) {
    for (const s of sprites) { s.alpha = 0.95; }
    return;
  }
  for (let i = 0; i < sprites.length; i++) {
    const id = i + 1;
    sprites[i].alpha = filter.ids.has(id) ? 1.0 : 0.15;
  }
}

function centerOnNode(index) {
  if (index < 0 || index >= sprites.length) return;
  const s = sprites[index];
  const w = app.renderer.width, h = app.renderer.height;
  world.position.set(w / 2 - s.x * world.scale.x, h / 2 - s.y * world.scale.y);
}

// FPS counter
setInterval(() => {
  const now = performance.now();
  const dt = now - lastTickAt;
  const fps = (frames / dt) * 1000;
  fpsEl.textContent = `fps: ${fps.toFixed(0)}`;
  lastTickAt = now;
  frames = 0;
}, 1000);

// Initial load
await load(modeEl.value, Number(edgesEl.value));

// Edges drawing helper
function drawEdges(px, py) {
  if (!edgesVisible) return;
  edgesLayer.clear();
  edgesLayer.alpha = 0.25;
  edgesLayer.stroke({ width: 1, color: 0x00ff66, alpha: 0.25 });
  const w = app.renderer.width, h = app.renderer.height;
  // Compute world viewport rect
  const inv = world.worldTransform.clone().invert();
  const tl = inv.apply(new PIXI.Point(0, 0));
  const br = inv.apply(new PIXI.Point(w, h));
  const minX = Math.min(tl.x, br.x) - 50, maxX = Math.max(tl.x, br.x) + 50;
  const minY = Math.min(tl.y, br.y) - 50, maxY = Math.max(tl.y, br.y) + 50;
  let drawn = 0;
  for (let k = 0; k < edgesData.length; k++) {
    const [a, b] = edgesData[k];
    const i = a - 1, j = b - 1;
    if (i < 0 || j < 0 || i >= px.length || j >= py.length) continue;
    const x1 = px[i], y1 = py[i];
    const x2 = px[j], y2 = py[j];
    // cull edges completely outside viewport band
    if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX) || (y1 < minY && y2 < minY) || (y1 > maxY && y2 > maxY)) continue;
    edgesLayer.moveTo(x1, y1).lineTo(x2, y2);
    drawn++;
  }
  // Finish stroke
  edgesLayer.closePath();
}

// Node culling (throttled)
setInterval(() => {
  const w = app.renderer.width, h = app.renderer.height;
  const inv = world.worldTransform.clone().invert();
  const tl = inv.apply(new PIXI.Point(0, 0));
  const br = inv.apply(new PIXI.Point(w, h));
  const minX = Math.min(tl.x, br.x) - 20, maxX = Math.max(tl.x, br.x) + 20;
  const minY = Math.min(tl.y, br.y) - 20, maxY = Math.max(tl.y, br.y) + 20;
  const step = decimate ? (zoom < 0.25 ? 4 : zoom < 0.5 ? 2 : 1) : 1;
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    const vis = (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY);
    s.visible = vis && (i % step === 0);
  }
}, 120);

// On-hover token detail (owner) – light touch, throttled by move handler already
const fetchOwner = throttle(async (id) => {
  try {
    const r = await fetch(`/api/token/${id}`);
    if (!r.ok) return;
    const t = await r.json();
    if (!t.owner) { tooltip.textContent = `#${id}`; return; }
    const addr = t.owner.toLowerCase();
    tooltip.textContent = `#${id} · ${addr.slice(0,6)}…${addr.slice(-4)}`;
    // Enrich with wallet meta (cached)
    if (walletMetaCache.has(addr)) {
      appendWalletMeta(walletMetaCache.get(addr));
    } else {
      const wm = await fetch(`/api/wallet/${addr}/meta`).then(x => x.ok ? x.json() : null).catch(()=>null);
      if (wm) { walletMetaCache.set(addr, wm); appendWalletMeta(wm); }
    }
  } catch {}
}, 300);

function appendWalletMeta(wm) {
  if (!wm) return;
  const ens = wm.ens_name ? ` · ${wm.ens_name}` : '';
  const hold = wm.total_holdings != null ? ` · hold:${wm.total_holdings}` : '';
  const trades = wm.trade_count != null ? ` · trades:${wm.trade_count}` : '';
  const score = wm.ethos_score != null ? ` · ethos:${wm.ethos_score}` : '';
  tooltip.textContent += ens + hold + trades + score;
}

// Charts
chartEl.addEventListener('change', async () => {
  chartMode = chartEl.value;
  drawChart();
});

async function drawChart() {
  const ctx = chartCanvas.getContext('2d');
  const w = chartCanvas.width = chartCanvas.clientWidth;
  const h = chartCanvas.height = chartCanvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (chartMode === 'none') return;
  ctx.strokeStyle = '#0a3'; ctx.fillStyle = '#0a3'; ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#9f9';

  if (chartMode === 'timeline') {
    const res = await fetch('/api/activity?interval=day', { cache: 'no-store' }).then(r=>r.json()).catch(()=>({ buckets: [] }));
    const arr = res.buckets || [];
    if (!arr.length) return;
    const counts = arr.map(b=>b.count||0);
    const vols = arr.map(b=>b.volume||0);
    const maxC = Math.max(1, ...counts);
    const maxV = Math.max(1, ...vols);
    // axes
    ctx.strokeStyle = '#133'; ctx.beginPath(); ctx.moveTo(30,h-20); ctx.lineTo(w-10,h-20); ctx.lineTo(w-10,10); ctx.stroke();
    // bars (counts)
    ctx.fillStyle = 'rgba(0,255,102,0.35)';
    const barW = Math.max(1, Math.floor((w-50)/arr.length));
    arr.forEach((b,i)=>{
      const x = 30 + i*barW; const bh = Math.floor((h-40) * (counts[i]/maxC));
      ctx.fillRect(x, h-20-bh, Math.max(1,barW-1), bh);
    });
    // line (volume)
    ctx.strokeStyle = '#0f6'; ctx.beginPath();
    arr.forEach((b,i)=>{
      const x = 30 + i*barW + barW/2; const y = (h-20) - (h-40) * (vols[i]/maxV);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  } else if (chartMode === 'heatmap') {
    const res = await fetch('/api/heatmap', { cache: 'no-store' }).then(r=>r.json()).catch(()=>({ grid: [] }));
    const grid = res.grid || [];
    if (!grid.length) return;
    const cols = 24, rows = 7;
    const cw = (w-40)/cols, rh = (h-30)/rows;
    let max = 1;
    for (let d=0; d<rows; d++) for (let hr=0; hr<cols; hr++) max = Math.max(max, grid[d]?.[hr]?.count||0);
    for (let d=0; d<rows; d++) {
      for (let hr=0; hr<cols; hr++) {
        const c = grid[d]?.[hr]?.count||0;
        const a = Math.sqrt(c/max);
        ctx.fillStyle = `rgba(0,255,102,${a*0.9})`;
        ctx.fillRect(30+hr*cw, 10+d*rh, cw-1, rh-1);
      }
    }
    ctx.strokeStyle = '#133'; ctx.strokeRect(30,10, cols*cw, rows*rh);
  }
}
