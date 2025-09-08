import { createCircleTexture, createParticleContainer } from './pixi-layer.js';
import { throttle, screenToWorld, clamp } from './utils.js';

const stageEl = document.getElementById('stage');
const modeEl = document.getElementById('mode');
const edgesEl = document.getElementById('edges');
const edgesToggleEl = document.getElementById('edges-toggle');
const fpsEl = document.getElementById('fps');
const nodeCountEl = document.getElementById('node-count');
const edgeCountEl = document.getElementById('edge-count');
const toggleSimBtn = document.getElementById('toggle-sim');
const resetBtn = document.getElementById('reset');
const searchEl = document.getElementById('search');
const clearSearchBtn = document.getElementById('clear-search');
const tooltip = document.getElementById('tooltip');

const app = new PIXI.Application();
const resolution = Math.min(window.devicePixelRatio || 1, 2);
await app.init({ background: 0x000000, resizeTo: stageEl, antialias: false, hello: false, resolution });
stageEl.appendChild(app.canvas);

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
let lastTickAt = performance.now();
let frames = 0;
let paused = false;
let worker = null;
let filter = { type: 'none', ids: null, address: null };
let lastHoverIndex = -1;
let edgesVisible = true;

function setupWorker(count, edges) {
  if (worker) worker.terminate();
  worker = new Worker('/sim.worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { type, positions } = e.data;
    if (type === 'tick' && positions) {
      applyPositions(positions.x, positions.y);
    }
  };
  worker.postMessage({ type: 'init', payload: { nodes: count, edges } });
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
    sp.tint = colors[i] || 0x00ff66;
    sp.x = 0; sp.y = 0;
    sp.alpha = 0.95;
    const s = 0.5; // radius scaling
    sp.scale.set(s, s);
    sprites.push(sp);
  }
  nodeContainer.addChild(...sprites);
}

async function fetchGraph(mode, edges) {
  const q = new URLSearchParams({ mode, edges: String(edges), nodes: '10000' });
  const t0 = performance.now();
  const res = await fetch(`/api/graph?${q.toString()}`, { cache: 'no-store' });
  const data = await res.json();
  const t1 = performance.now();
  console.log(`Graph fetched in ${Math.round(t1 - t0)}ms`, data.meta);
  return data;
}

async function load(mode, edges) {
  const data = await fetchGraph(mode, edges);
  nodes = data.nodes;
  nodeCountEl.textContent = `nodes: ${nodes.length}`;
  edgeCountEl.textContent = `edges: ${data.edges.length}`;
  const colors = nodes.map(n => n.color);
  createGraph(nodes.length, colors);
  edgesData = data.edges || [];
  edgesLayer.clear();
  edgesLayer.visible = edgesVisible;
  setupWorker(nodes.length, data.edges);
}

// Pan/zoom interactions
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let worldStart = { x: 0, y: 0 };

app.canvas.addEventListener('mousedown', (e) => {
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

app.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const prev = zoom;
  const delta = -e.deltaY;
  const factor = Math.exp(delta * 0.001);
  zoom = clamp(zoom * factor, zoomMin, zoomMax);
  const mouse = { x: e.clientX, y: e.clientY };
  const worldPosBefore = world.toLocal(mouse);
  world.scale.set(zoom);
  const worldPosAfter = world.toLocal(mouse);
  world.position.x += (worldPosAfter.x - worldPosBefore.x) * world.scale.x;
  world.position.y += (worldPosAfter.y - worldPosBefore.y) * world.scale.y;
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

// UI wiring
modeEl.addEventListener('change', async () => {
  await load(modeEl.value, Number(edgesEl.value));
});
edgesEl.addEventListener('input', throttle(async () => {
  await load(modeEl.value, Number(edgesEl.value));
}, 400));

toggleSimBtn.addEventListener('click', () => {
  paused = !paused;
  toggleSimBtn.textContent = paused ? 'resume' : 'pause';
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
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    const v = (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY);
    s.visible = v;
  }
}, 120);

// On-hover token detail (owner) – light touch, throttled by move handler already
const fetchOwner = throttle(async (id) => {
  try {
    const r = await fetch(`/api/token/${id}`);
    if (!r.ok) return;
    const t = await r.json();
    tooltip.textContent = `#${id}` + (t.owner ? ` · ${t.owner.slice(0,6)}…${t.owner.slice(-4)}` : '');
  } catch {}
}, 300);
