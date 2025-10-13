import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { hierarchy, pack as d3pack } from 'd3-hierarchy';
import { buildTopdownTree, attachTopdownTree, highlightBranch } from './layout/treeTopDown.js';
import { bubbleMapLayout } from './layout/bubbleMap.js';

const TOKENS = {
  fg: [0, 255, 102],
  fgBright: [153, 255, 102],
  blue: [68, 136, 255],
  gray: [102, 102, 102]
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseCssColor(value, alpha = 1) {
  if (!value) return null;
  const src = value.trim();
  if (src.startsWith('#')) {
    const hex = src.length === 4
      ? src.replace(/#/g, '').split('').map(ch => ch + ch).join('')
      : src.replace('#', '');
    const bigint = parseInt(hex, 16);
    if (Number.isNaN(bigint)) return null;
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return [r, g, b, clamp(Math.round(alpha * 255), 0, 255)];
  }
  const matches = src.match(/rgba?\(([^)]+)\)/i);
  if (matches) {
    const parts = matches[1].split(',').map(part => Number(part.trim()));
    if (parts.length >= 3) {
      return [parts[0], parts[1], parts[2], clamp(Math.round((parts[3] ?? alpha) * 255), 0, 255)];
    }
  }
  if (src.includes(',')) {
    const parts = src.split(',').map(part => Number(part.trim()));
    if (parts.length >= 3) {
      return [parts[0], parts[1], parts[2], clamp(Math.round(alpha * 255), 0, 255)];
    }
  }
  return null;
}

function cssColor(name, fallback, alpha = 1) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const styles = getComputedStyle(document.documentElement);
  const value = styles.getPropertyValue(name);
  const parsed = parseCssColor(value, alpha);
  return parsed || fallback;
}

function rgbaMultiply(rgba, factor) {
  const [r, g, b, a] = rgba;
  return [clamp(Math.round(r * factor), 0, 255), clamp(Math.round(g * factor), 0, 255), clamp(Math.round(b * factor), 0, 255), a];
}

function blendColors(a, b, t) {
  const mix = clamp(t, 0, 1);
  const inv = 1 - mix;
  return [
    Math.round((a[0] || 0) * inv + (b[0] || 0) * mix),
    Math.round((a[1] || 0) * inv + (b[1] || 0) * mix),
    Math.round((a[2] || 0) * inv + (b[2] || 0) * mix),
    Math.round((a[3] || 255) * inv + (b[3] || 255) * mix)
  ];
}

function percentile(values = [], p = 0.95) {
  const list = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!list.length) return 0;
  if (list.length === 1) return list[0];
  const rank = (list.length - 1) * clamp(p, 0, 1);
  const lower = Math.floor(rank);
  const upper = Math.min(list.length - 1, lower + 1);
  const weight = rank - lower;
  return list[lower] * (1 - weight) + list[upper] * weight;
}

function sqrtScale(value, clampMax) {
  const safe = Number.isFinite(value) ? value : 0;
  const capped = clamp(safe, 0, Math.max(0, clampMax || 0));
  return Math.sqrt(capped);
}

function median(values = []) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 0 ? (list[mid - 1] + list[mid]) / 2 : list[mid];
}

const COLLISION_PADDING = 2;
const COLLISION_SWEEPS = 12;
const COLLISION_FALLBACK_SWEEPS = 3;
const COLLISION_DRIFT_CLAMP = 15;
const COLLISION_EPSILON = 0.1;
const COLLISION_MIN_RADIUS = 2;
const CSS_COLORS = {
  nodeFill: cssColor('--node-fill', [212, 255, 212, 255]),
  nodeStroke: cssColor('--node-stroke', [128, 255, 179, 255]),
  link: cssColor('--link', [136, 136, 136, 255]),
  accent: cssColor('--accent', [0, 255, 102, 255]),
  accent2: cssColor('--accent-2', [155, 135, 255, 255]),
  muted: cssColor('--muted', [154, 160, 166, 255]),
  danger: cssColor('--danger', [255, 107, 107, 255])
};

const WALLET_TYPE_COLORS = {
  exchange: CSS_COLORS.accent2,
  bot: parseCssColor('#ffd166', 1),
  whale: CSS_COLORS.danger,
  team: parseCssColor('#ff8fab', 1),
  default: CSS_COLORS.accent
};

const COMMUNITY_COLORS = [
  '#22d3ee', '#60a5fa', '#facc15', '#f87171', '#a855f7', '#34d399', '#fb7185', '#f97316'
].map(hex => parseCssColor(hex, 1));

function colorForWallet(type = '', community = null, index = 0) {
  const key = String(type || '').toLowerCase();
  const base = WALLET_TYPE_COLORS[key] || WALLET_TYPE_COLORS.default;
  if (community != null && Number.isFinite(community)) {
    const idx = community % COMMUNITY_COLORS.length;
    return COMMUNITY_COLORS[idx] || base;
  }
  const variation = 0.94 + (index % 5) * 0.01;
  return rgbaMultiply(base, variation);
}

const DEFAULT_DECAY = 0.22;

const View = Object.freeze({
  BUBBLE: 'bubble',
  TREE: 'tree',
  FLOW: 'flow',
  RHYTHM: 'rhythm'
});

const COLORS = {
  active: [...TOKENS.fg, 210],
  whale: [...TOKENS.fgBright, 230],
  frozen: [...TOKENS.blue, 220],
  dormant: [...TOKENS.gray, 180]
};

const PANEL_KEY = 'left-panel-hidden';

const state = {
  graph: null,
  controls: null,
  stageEl: null,
  preset: null,
  nodes: [],
  nodeMap: new Map(),
  nodeSprites: new Map(),
  viewNodes: new Map(),
  ownerNodes: [],
  ownerNodeMap: new Map(),
  ownerAddressMap: new Map(),
  ownerMetrics: { holdings: [], flow: [], p95Flow: 0, p95Holdings: 0 },
  ownerEdges: { holders: [], flow: [] },
  ownerTopNeighbors: new Map(),
  tokenNodes: [],
  tokenNodeMap: new Map(),
  treeTopdown: { root: null, data: null, loading: false },
  treeTopdownDepth: 2,
  explainNextView: null,
  explainDefault: null,
  rawEdges: {
    ownership: [],
    traits: [],
    transfers: [],
    sales: [],
    mints: [],
    mixed: [],
    ambient: []
  },
  highlighted: null,
  selectedId: null,
  hoveredId: null,
  edgeCap: 200,
  mode: 'holders',
  lastZoomBucket: null,
  showBubbles: false,
  activeView: View.BUBBLE,
  clusterMode: false,
  clusterMeshes: [],
  colorMode: 'default',
  traitGroups: [],
  selectedTraits: new Map(),
  traitTokenCache: new Map(),
  traitRequestId: 0
};
try { window.__MAMMOTH_STATE = state; } catch {}

function resolveOwnerAddress(candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'object') {
    if (candidate.address) return String(candidate.address).toLowerCase();
    if (candidate.id) return resolveOwnerAddress(candidate.id);
  }
  if (typeof candidate === 'number') return resolveOwnerAddress(String(candidate));
  const value = String(candidate).trim();
  if (!value) return null;
  if (value.startsWith('0x')) return value.toLowerCase();
  const ownerNode = state.ownerNodeMap.get(value);
  if (ownerNode?.address) return ownerNode.address.toLowerCase();
  const addressNode = state.ownerAddressMap.get(value.toLowerCase());
  if (addressNode?.address) return addressNode.address.toLowerCase();
  return null;
}

function computeTopdownBranchSet(node, data) {
  if (!node || !data) return null;
  const ids = new Set();
  const nodeById = new Map(data.nodes.map(n => [n.id, n]));
  let current = nodeById.get(node.id) || node;
  if (!current) return null;
  ids.add(current.id);
  while (current.level > 0) {
    const parentLink = data.links.find(link => {
      const targetId = link.target.id || link.target;
      return targetId === current.id;
    });
    if (!parentLink) break;
    const parentId = parentLink.source.id || parentLink.source;
    ids.add(parentId);
    current = nodeById.get(parentId);
    if (!current) break;
  }
  return ids;
}

const spriteTexture = (() => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
})();

const SIMPLE_VIEWS = {
  [View.BUBBLE]: {
    mode: 'holders',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': false,
      'layer-transfers': false,
      'layer-sales': false,
      'layer-mints': false,
      'layer-traits': false
    }
  },
  [View.TREE]: {
    mode: 'holders',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': false,
      'layer-transfers': false,
      'layer-sales': false,
      'layer-mints': false,
      'layer-traits': false
    }
  },
  [View.FLOW]: {
    mode: 'holders',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': true,
      'layer-transfers': true,
      'layer-sales': true,
      'layer-mints': true,
      'layer-traits': false
    }
  },
  [View.RHYTHM]: {
    mode: 'transfers',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': false,
      'layer-transfers': true,
      'layer-sales': false,
      'layer-mints': false,
      'layer-traits': false
    }
  }
};

const API = {
  graph: '/api/graph',
  preset: '/api/preset-data',
  token: id => `/api/token/${id}`,
  story: id => `/api/token/${id}/story`
};

(async function bootstrap(){
  const center = document.querySelector('.center-panel');
  if (!center) throw new Error('three.app: .center-panel not found');
  const stageEl = document.createElement('div');
  stageEl.id = 'three-stage';
  stageEl.style.width = '100%';
  stageEl.style.height = '100%';
  stageEl.style.position = 'relative';
  stageEl.style.cursor = 'grab';
  center.innerHTML = '';
  center.appendChild(stageEl);
  state.stageEl = stageEl;

  const graph = ForceGraph3D()(stageEl);
  state.graph = graph;
  graph.showNavInfo(false);
  graph.backgroundColor('#020407');
  graph.enableNodeDrag(false);
  graph.enablePointerInteraction(true);
  graph.numDimensions(3);
  graph.d3Force('charge').strength(-45);
  graph.d3VelocityDecay(DEFAULT_DECAY);

  const controls = graph.controls();
  state.controls = controls;
  configureControls(controls, THREE);
  attachZoomListener(controls);
  state.lastZoomBucket = currentZoomBucket();

  graph.nodeLabel(node => `#${node.id}`);
  graph.nodeThreeObject(node => buildSprite(node));
  graph.nodeThreeObjectExtend(false);
  if (typeof graph.nodeOpacity === 'function') graph.nodeOpacity(() => 1);
  if (typeof graph.nodeVisibility === 'function') graph.nodeVisibility(() => true);
  if (typeof graph.onEngineStop === 'function') {
    graph.onEngineStop(() => {
      try { graph.zoomToFit(800, 80); } catch {}
    });
  }

  graph.onNodeClick(node => handleNodeClick(node));

  graph.onBackgroundClick(() => handleBackgroundClick());

  graph.onNodeHover(node => handleNodeHover(node));

  applyStoredPanelState();
  bindUI();
  bindResize();
  initDraggablePanels();
  exposeApi();
  setupControlGuards();
  bindExplainCard();

  await initData();
  rebuildLinks();
  updateNodeStyles();

  window.addEventListener('keydown', evt => {
    if (evt.key === 'Escape') {
      state.selectedId = null;
      state.highlighted = null;
      updateNodeStyles();
      updateSidebar(null);
    }
  });
})();

async function initData() {
  startUILoad();
  try {
    const [preset, tokensResp, holdersGraph, traitsGraph, transferEdges] = await Promise.all([
      jfetch(`${API.preset}?nodes=10000`),
      jfetch('/api/precomputed/tokens'),
      jfetch(`${API.graph}?mode=holders&edges=500`),
      jfetch(`${API.graph}?mode=traits&edges=500`),
      jfetch('/api/transfer-edges?limit=1000&nodes=10000')
    ]);

    state.preset = preset || {};
    const fallbackNodes = Array.isArray(holdersGraph?.nodes) ? holdersGraph.nodes : [];
    const tokenList = Array.isArray(tokensResp?.tokens) ? tokensResp.tokens : [];

    const tokenNodes = buildTokenNodes(tokenList, fallbackNodes, state.preset);
    state.tokenNodes = tokenNodes;
    state.tokenNodeMap = new Map(tokenNodes.map(n => [n.id, n]));


    state.nodes = state.tokenNodes;
    state.nodeMap = new Map(state.tokenNodes.map(n => [n.id, n]));
    state.viewNodes = new Map(state.nodeMap);

    const ownershipEdges = buildSimpleEdges(holdersGraph?.edges, 'ownership');
    state.rawEdges.ownership = ownershipEdges;
    state.rawEdges.ambient = ownershipEdges.map(cloneEdgeAsAmbient);
    state.rawEdges.traits = buildSimpleEdges(traitsGraph?.edges, 'traits');
    state.rawEdges.transfers = [];
    state.rawEdges.sales = [];
    state.rawEdges.mints = [];
    state.rawEdges.mixed = [];

    const ownerData = buildOwnerDataset(state.preset);
    seedOwnerLayout(ownerData.nodes);
    resolveOwnerCollisions(ownerData.nodes);
    normalizeOwnerPositions(ownerData.nodes);
    state.ownerNodes = ownerData.nodes;
    state.ownerNodeMap = new Map(ownerData.nodes.map(n => [n.id, n]));
    state.ownerAddressMap = new Map(ownerData.nodes.map(n => [n.addressLc, n]));
    state.ownerMetrics = ownerData.metrics;

    const ownerEdges = buildOwnerEdges(Array.isArray(transferEdges) ? transferEdges : [], state.ownerAddressMap);
    state.ownerEdges.holders = ownerEdges.holders;
    state.ownerEdges.flow = ownerEdges.flow;
    state.ownerTopNeighbors = ownerEdges.topNeighbors;

    state.nodes = state.ownerNodes;
    state.nodeMap = new Map(state.ownerNodes.map(n => [n.id, n]));
    state.viewNodes = new Map(state.nodeMap);

    disposeSprites();
    state.graph.nodeThreeObject(node => buildSprite(node));
    state.graph.nodeLabel(nodeLabel);
    state.graph.graphData({ nodes: state.nodes, links: [] });
    state.graph.d3ReheatSimulation();
    state.graph.nodeThreeObject(node => buildSprite(node));
    state.graph.nodeThreeObjectExtend(false);
    updateNodeStyles();
    await loadTraitFilters();
    requestAnimationFrame(() => {
      fitCameraToNodes(state.nodes);
      try { state.graph.refresh(); } catch {}
      state.lastZoomBucket = currentZoomBucket();
      try { window.__mammothDrawnFrame = true; } catch {}
    });
    setTimeout(() => { fitCameraToNodes(state.nodes); }, 1500);
    updateViewControls();
  } finally {
    stopUILoad();
  }
}

function buildTokenNodes(tokens, fallback, preset) {
  const nodes = [];
  const fallbackMap = new Map(Array.isArray(fallback) ? fallback.map(n => [n.id, n]) : []);
  const total = determineNodeCount(tokens, fallback, preset);
  const ownerIndex = Array.isArray(preset?.ownerIndex) ? preset.ownerIndex : [];
  const ownerType = Array.isArray(preset?.ownerWalletType) ? preset.ownerWalletType : [];
  const lastActivity = Array.isArray(preset?.tokenLastActivity) ? preset.tokenLastActivity : [];
  const saleCountArr = Array.isArray(preset?.tokenSaleCount) ? preset.tokenSaleCount : [];
  const saleCount30dArr = Array.isArray(preset?.tokenSaleCount30d) ? preset.tokenSaleCount30d : [];
  const holdDaysArr = Array.isArray(preset?.tokenHoldDays) ? preset.tokenHoldDays : [];
  const rarityArr = Array.isArray(preset?.rarity) ? preset.rarity : [];
  const volumeArr = Array.isArray(tokens) ? tokens.map(t => Number(t.volumeAllTia ?? 0)) : [];
  const maxVolume = Math.max(1, ...volumeArr.filter(v => Number.isFinite(v)));
  const now = Date.now() / 1000;

  for (let i = 0; i < total; i++) {
    const id = tokens?.[i]?.id ?? fallback?.[i]?.id ?? (i + 1);
    if (!Number.isFinite(id)) continue;
    const token = tokens?.find?.(t => t.id === id) || null;
    const fall = fallbackMap.get(id) || {};
    const idx = id - 1;
    const oi = ownerIndex[idx] ?? null;
    const typeRaw = (oi != null && ownerType[oi]) ? String(ownerType[oi]).toLowerCase() : '';
    const isWhale = typeRaw.includes('whale');
    const isFrozen = !!fall.frozen;
    const lastAct = Number(lastActivity[idx] ?? 0) || 0;
    const daysSince = lastAct ? (now - lastAct) / 86400 : Infinity;
    const isDormant = (!isFrozen && daysSince >= 90) || !!fall.dormant;
    const baseColor = decideColor({ isWhale, isFrozen, isDormant });
    const saleCount = Number(saleCountArr[idx] ?? token?.saleCount ?? 0) || 0;
    const rarity = Number(rarityArr[idx] ?? 0.5) || 0;
    const volume = Number(token?.volumeAllTia ?? 0) || 0;
    const volumeUsd = Number(token?.volumeAllUsd ?? token?.volumeUsd ?? token?.volume_all_usd ?? 0) || 0;
    const saleCount30d = Number(saleCount30dArr[idx] ?? token?.saleCount30d ?? 0) || 0;

    const xy = Array.isArray(token?.xy) ? token.xy : null;
    const [x, y] = xy ? xy : fallbackPosition(i, total);
    const z = xy ? normalizedDepth(volume, maxVolume, rarity) : 0;
    const size = nodeSize(saleCount, isWhale) * 12;

    const ethos = extractEthosFromToken(token);
    const trading = extractTradingFromToken(token, fall, preset, idx);
    const story = extractStoryFromToken(token, fall);
    const traits = extractTraitsFromToken(token);
    const ownerAddr = token?.owner ?? token?.ownerAddr ?? fall.owner ?? null;
    const holdDays = Number.isFinite(trading.holdDays) ? trading.holdDays : Number(holdDaysArr[idx] ?? fall.hold_days ?? null);

    nodes.push({
      id,
      ownerIndex: oi,
      typeRaw,
      isWhale,
      frozen: isFrozen,
      dormant: isDormant,
      lastActivity: lastAct,
      daysSince,
      saleCount,
      rarity,
      volume,
      volumeUsd,
      saleCount30d,
      x,
      y,
      z,
      baseColor,
      displaySize: size,
      displayColor: baseColor.slice(),
      baseSize: size,
      homeX: x,
      homeY: y,
      homeZ: z,
      fx: x,
      fy: y,
      fz: z,
      ownerAddr,
      ethos,
      trading,
      story,
      traits,
      holdDays: Number.isFinite(holdDays) ? holdDays : null
    });
    applyNodeImportance(nodes[nodes.length - 1]);
  }
  return nodes;
}

function buildOwnerDataset(preset = {}) {
  const owners = Array.isArray(preset?.owners) ? preset.owners : [];
  const ownerIndex = Array.isArray(preset?.ownerIndex) ? preset.ownerIndex : [];
  const ownerBuyVol = Array.isArray(preset?.ownerBuyVol) ? preset.ownerBuyVol : [];
  const ownerSellVol = Array.isArray(preset?.ownerSellVol) ? preset.ownerSellVol : [];
  const ownerWalletType = Array.isArray(preset?.ownerWalletType) ? preset.ownerWalletType : [];
  const ownerCommunities = Array.isArray(preset?.ownerCommunityId) ? preset.ownerCommunityId : [];
  const ownerEthos = Array.isArray(preset?.ownerEthos) ? preset.ownerEthos : [];

  const holdings = new Array(owners.length).fill(0);
  for (let i = 0; i < ownerIndex.length; i++) {
    const idx = ownerIndex[i];
    if (Number.isInteger(idx) && idx >= 0 && idx < holdings.length) holdings[idx] += 1;
  }

  const flow = owners.map((_, i) => {
    const buy = Number(ownerBuyVol[i] ?? 0) || 0;
    const sell = Number(ownerSellVol[i] ?? 0) || 0;
    return buy + sell;
  });

  const p95Flow = percentile(flow, 0.95) || 0;
  const p95Holdings = percentile(holdings, 0.95) || 0;

  const nodes = owners.map((address, i) => {
    const rawAddr = String(address || '').trim();
    const addressLc = rawAddr.toLowerCase();
    const walletType = String(ownerWalletType[i] || '').toLowerCase();
    const community = Number.isFinite(ownerCommunities[i]) ? Number(ownerCommunities[i]) : null;
    const baseColor = colorForWallet(walletType, community, i) || CSS_COLORS.nodeFill;
    const strokeColor = rgbaMultiply(baseColor, 0.72);
    const flowMetric = flow[i] || 0;
    const holdingCount = holdings[i] || 0;
    const radius = 3 + 2.4 * sqrtScale(flowMetric, p95Flow || 1);
    const strokeWidth = 1 + sqrtScale(holdingCount, p95Holdings || 1);
    const displaySize = Math.max(14, radius * 6);

    return {
      id: `owner-${i}`,
      ownerIndex: i,
      address: rawAddr,
      addressLc,
      walletType,
      community,
      ethosScore: Number(ownerEthos[i] ?? null) || null,
      flowMetric,
      holdingCount,
      radius,
      strokeWidth,
      baseColor: baseColor.slice(0, 4),
      displayColor: baseColor.slice(0, 4),
      strokeColor: strokeColor.slice(0, 4),
      displaySize,
      baseSize: displaySize,
      label: addressLc ? `${addressLc.slice(0, 6)}…${addressLc.slice(-4)}` : `owner-${i + 1}`,
      x: 0,
      y: 0,
      z: 0,
      fx: null,
      fy: null,
      fz: 0,
      stage: 'owner'
    };
  });

  return {
    nodes,
    metrics: {
      holdings,
      flow,
      p95Flow,
      p95Holdings
    }
  };
}

function seedOwnerLayout(nodes = []) {
  if (!nodes.length) return;
  const groups = new Map();
  nodes.forEach(node => {
    const key = node.walletType || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });
  const keys = Array.from(groups.keys());
  const majorRadius = Math.max(420, 140 * Math.sqrt(keys.length || 1));
  keys.forEach((key, index) => {
    const bucket = groups.get(key) || [];
    if (!bucket.length) return;
    const angle = (index / Math.max(1, keys.length)) * Math.PI * 2;
    const centerX = Math.cos(angle) * majorRadius;
    const centerY = Math.sin(angle) * majorRadius;
    const innerRadius = Math.max(120, Math.sqrt(bucket.length) * 28);
    bucket.forEach((node, i) => {
      const theta = (i / Math.max(1, bucket.length)) * Math.PI * 2;
      const x = centerX + Math.cos(theta) * innerRadius;
      const y = centerY + Math.sin(theta) * innerRadius;
      node.x = x;
      node.y = y;
      node.z = 0;
      node.fx = x;
      node.fy = y;
      node.fz = 0;
      node.homeX = x;
      node.homeY = y;
      node.homeZ = 0;
    });
  });
}

function buildOwnerEdges(edgeList = [], ownerMap = new Map()) {
  const adjacency = new Map();
  const holders = [];
  const flow = [];
  const topNeighbors = new Map();
  const now = Date.now() / 1000;
  const windowSeconds = 30 * 86400;

  for (let i = 0; i < edgeList.length; i++) {
    const edge = edgeList[i];
    const from = ownerMap.get(String(edge?.from_addr || '').toLowerCase());
    const to = ownerMap.get(String(edge?.to_addr || '').toLowerCase());
    if (!from || !to || from.id === to.id) continue;
    const salesCount = Number(edge?.sales_count ?? 0) || 0;
    const recentCount = Number(edge?.sales_count_30d ?? 0) || 0;
    const lastTs = Number(edge?.last_ts ?? 0) || null;
    const totalTrades = Number(edge?.total_trades ?? salesCount) || salesCount;

    if (!adjacency.has(from.id)) adjacency.set(from.id, []);
    adjacency.get(from.id).push({
      source: from.id,
      target: to.id,
      salesCount,
      recentCount,
      lastTs,
      totalTrades
    });
  }

  adjacency.forEach((list, sourceId) => {
    const sorted = list.filter(item => item.salesCount >= 2).sort((a, b) => b.salesCount - a.salesCount);
    const top = sorted.slice(0, 6);
    topNeighbors.set(sourceId, top.map(item => item.target));
    top.forEach(item => {
      holders.push({
        source: item.source,
        target: item.target,
        weight: item.salesCount,
        width: Math.max(1, Math.log2(1 + item.salesCount)),
        opacity: 0.12
      });
    });

    list.forEach(item => {
      if (item.recentCount <= 0 || !Number.isFinite(item.lastTs)) return;
      const age = clamp((now - item.lastTs) / windowSeconds, 0, 1);
      const opacity = 0.08 + (0.6 - 0.08) * (1 - age);
      flow.push({
        source: item.source,
        target: item.target,
        weight: item.recentCount,
        width: Math.max(1, Math.log2(1 + item.recentCount)),
        opacity: clamp(opacity, 0.08, 0.6)
      });
    });
  });

  return { holders, flow, topNeighbors };
}

function resolveOwnerCollisions(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  const radii = nodes.map(n => Math.max(COLLISION_MIN_RADIUS, n.radius || COLLISION_MIN_RADIUS));
  const medianRadius = median(radii) || COLLISION_MIN_RADIUS;
  const cellSize = Math.max(8, 2 * medianRadius + COLLISION_PADDING);
  nodes.forEach(node => {
    node.collisionBaseX = node.x;
    node.collisionBaseY = node.y;
  });
  let result = performCollisionSweeps(nodes, cellSize, COLLISION_SWEEPS);
  if (result.maxOverlap > COLLISION_EPSILON) {
    // fallback shrink
    let radiusScale = 0.95;
    while (result.maxOverlap > COLLISION_EPSILON && radiusScale >= 0.9) {
      nodes.forEach(node => {
        node.radius = Math.max(COLLISION_MIN_RADIUS, (node.radius || COLLISION_MIN_RADIUS) * radiusScale);
        const size = Math.max(12, node.radius * 6);
        node.baseSize = size;
        node.displaySize = size;
      });
      result = performCollisionSweeps(nodes, Math.max(8, 2 * median(nodes.map(n => n.radius || COLLISION_MIN_RADIUS)) + COLLISION_PADDING), COLLISION_FALLBACK_SWEEPS);
      radiusScale *= 0.95;
    }
  }
  nodes.forEach(node => {
    node.fx = node.x;
    node.fy = node.y;
    node.fz = 0;
    node.homeX = node.x;
    node.homeY = node.y;
    node.homeZ = 0;
  });
  if (result.maxOverlap > COLLISION_EPSILON && typeof console !== 'undefined') {
    console.warn('Owner collision solver residual overlap:', result.maxOverlap.toFixed(3));
  }
}

function normalizeOwnerPositions(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  let maxDist = 0;
  nodes.forEach(node => {
    const x = Number(node.x) || 0;
    const y = Number(node.y) || 0;
    const z = Number(node.z) || 0;
    const dist = Math.hypot(x, y, z);
    if (dist > maxDist) maxDist = dist;
  });
  if (maxDist <= 0) return;
  const limit = 550;
  if (maxDist <= limit) return;
  const scale = limit / maxDist;
  nodes.forEach(node => {
    node.x = (Number(node.x) || 0) * scale;
    node.y = (Number(node.y) || 0) * scale;
    node.z = (Number(node.z) || 0) * scale;
    node.fx = (Number(node.fx) || 0) * scale;
    node.fy = (Number(node.fy) || 0) * scale;
    node.fz = (Number(node.fz) || 0) * scale;
    node.homeX = (Number(node.homeX) || 0) * scale;
    node.homeY = (Number(node.homeY) || 0) * scale;
    node.homeZ = (Number(node.homeZ) || 0) * scale;
  });
}

function performCollisionSweeps(nodes, cellSize, maxSweeps) {
  let maxOverlap = Infinity;
  const padding = COLLISION_PADDING;
  const displacement = nodes.map(() => ({ x: 0, y: 0 }));
  const grid = new Map();
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    grid.clear();
    nodes.forEach((node, idx) => {
      const key = gridKey(node.x, node.y, cellSize);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
      displacement[idx].x = 0;
      displacement[idx].y = 0;
    });

    maxOverlap = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const radiusI = Math.max(COLLISION_MIN_RADIUS, node.radius || COLLISION_MIN_RADIUS);
      const cell = cellCoords(node.x, node.y, cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${cell.cx + dx}:${cell.cy + dy}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const other = nodes[j];
            const radiusJ = Math.max(COLLISION_MIN_RADIUS, other.radius || COLLISION_MIN_RADIUS);
            const minDist = radiusI + radiusJ + padding;
            let dxVec = other.x - node.x;
            let dyVec = other.y - node.y;
            let dist = Math.hypot(dxVec, dyVec);
            if (dist === 0) {
              const angle = (i + j) * 0.61803398875;
              dxVec = Math.cos(angle) * 0.001;
              dyVec = Math.sin(angle) * 0.001;
              dist = 0.001;
            }
            const overlap = minDist - dist;
            if (overlap > 0) {
              maxOverlap = Math.max(maxOverlap, overlap);
              const push = Math.min(overlap, 0.6 * minDist) / dist;
              const shiftX = dxVec * push * 0.5;
              const shiftY = dyVec * push * 0.5;
              displacement[i].x -= shiftX;
              displacement[i].y -= shiftY;
              displacement[j].x += shiftX;
              displacement[j].y += shiftY;
            }
          }
        }
      }
    }

    if (maxOverlap <= COLLISION_EPSILON) break;

    const groupCentroids = computeGroupCentroids(nodes);

    nodes.forEach((node, idx) => {
      node.x += displacement[idx].x;
      node.y += displacement[idx].y;

      const baseX = node.collisionBaseX ?? 0;
      const baseY = node.collisionBaseY ?? 0;
      const dx = node.x - baseX;
      const dy = node.y - baseY;
      const drift = Math.hypot(dx, dy);
      if (drift > COLLISION_DRIFT_CLAMP) {
        const scale = COLLISION_DRIFT_CLAMP / drift;
        node.x = baseX + dx * scale;
        node.y = baseY + dy * scale;
      }

      const centroid = groupCentroids.get(node.walletType || 'owner') || { x: 0, y: 0 };
      node.x += (centroid.x - node.x) * 0.05;
      node.y += (centroid.y - node.y) * 0.05;
    });
  }
  return { maxOverlap };
}

function gridKey(x, y, cellSize) {
  const cell = cellCoords(x, y, cellSize);
  return `${cell.cx}:${cell.cy}`;
}

function cellCoords(x, y, cellSize) {
  const inv = 1 / cellSize;
  return {
    cx: Math.floor(x * inv),
    cy: Math.floor(y * inv)
  };
}

function computeGroupCentroids(nodes) {
  const groups = new Map();
  nodes.forEach(node => {
    const key = node.walletType || 'owner';
    if (!groups.has(key)) groups.set(key, { sumX: 0, sumY: 0, count: 0 });
    const bucket = groups.get(key);
    bucket.sumX += node.x;
    bucket.sumY += node.y;
    bucket.count += 1;
  });
  const centroids = new Map();
  groups.forEach((bucket, key) => {
    centroids.set(key, {
      x: bucket.count ? bucket.sumX / bucket.count : 0,
      y: bucket.count ? bucket.sumY / bucket.count : 0
    });
  });
  return centroids;
}

function useOwnerDataset() {
  state.nodes = state.ownerNodes;
  state.nodeMap = state.ownerNodeMap;
  state.viewNodes = new Map(state.ownerNodeMap);
}

function useTokenDataset() {
  state.nodes = state.tokenNodes;
  state.nodeMap = state.tokenNodeMap;
  state.viewNodes = new Map(state.tokenNodeMap);
}

function determineNodeCount(tokens, fallback, preset) {
  const counts = [
    Array.isArray(tokens) ? tokens.length : 0,
    Array.isArray(fallback) ? fallback.length : 0,
    Array.isArray(preset?.ownerIndex) ? preset.ownerIndex.length : 0
  ].filter(Boolean);
  if (!counts.length) return 0;
  return Math.min(10000, Math.max(...counts));
}

function decideColor({ isWhale, isFrozen, isDormant }) {
  if (isWhale) return COLORS.whale.slice();
  if (isFrozen) return COLORS.frozen.slice();
  if (isDormant) return COLORS.dormant.slice();
  return COLORS.active.slice();
}

function fitCameraToNodes(nodes) {
  if (!state.graph || !Array.isArray(nodes) || !nodes.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  nodes.forEach(node => {
    const x = Number(node?.x) || 0;
    const y = Number(node?.y) || 0;
    const z = Number(node?.z) || 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  });
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanY, spanZ, 1);
  const distance = Math.max(6000, span * 2.5);
  state.cameraFit = { centerX, centerY, centerZ, span, distance };
  try {
    const camera = state.graph.camera?.();
    if (camera) {
      camera.position.set(centerX, centerY, distance);
      camera.lookAt(centerX, centerY, centerZ);
    }
    if (state.controls?.object) {
      state.controls.object.position.set(centerX, centerY, distance);
      state.controls.target.set(centerX, centerY, centerZ);
      if (typeof state.controls.update === 'function') state.controls.update();
    } else if (typeof state.graph.cameraPosition === 'function') {
      state.graph.cameraPosition(
        { x: centerX, y: centerY, z: distance },
        { x: centerX, y: centerY, z: centerZ },
        0
      );
    }
  } catch {}
}

function fallbackPosition(i, total) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const radius = Math.sqrt(i + 0.5) * 18;
  const angle = i * golden;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function nodeImportance(node) {
  const whaleBoost = node.isWhale ? 1.3 : 0;
  const ethosScore = Number(node?.ethos?.score);
  const ethosBoost = Number.isFinite(ethosScore) ? clamp(ethosScore, 0, 100) / 70 : 0;
  const volumeBase = Number.isFinite(node?.volumeUsd) ? node.volumeUsd : node.volume;
  const volumeBoost = Math.log1p(Math.max(0, Number(volumeBase) || 0)) / 8;
  const rarityBoost = Number.isFinite(node?.rarity) ? (1 - clamp(node.rarity, 0, 1)) : 0;
  return 1 + whaleBoost + ethosBoost + volumeBoost + rarityBoost;
}

function applyNodeImportance(node) {
  if (!node) return;
  const importance = nodeImportance(node);
  const size = clamp(18 * importance, 14, 80);
  node.baseSize = size;
  node.displaySize = size;
}

async function loadTraitFilters() {
  const container = document.getElementById('traits-container');
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn && !clearBtn.dataset.traitsBound) {
    clearBtn.dataset.traitsBound = '1';
    clearBtn.addEventListener('click', () => {
      state.selectedTraits.clear();
      state.highlighted = null;
      updateTraitFilterStates();
      resetSidebarEmpty(true);
      renderCurrentView();
    });
  }
  const traitsSection = document.querySelector('.traits-section');
  const traitsHeader = document.querySelector('.traits-header');
  if (traitsSection) traitsSection.classList.add('open');
  if (traitsHeader) traitsHeader.setAttribute('aria-expanded', 'true');
  if (!container) return;
  container.innerHTML = '<div class="small-meta">Loading traits…</div>';
  let groups = [];
  try {
    const data = await jfetch(`/api/traits?v=${Date.now()}`);
    if (Array.isArray(data?.traits)) groups = data.traits;
  } catch {}
  if (!Array.isArray(groups) || !groups.length) {
    groups = buildTraitFallback();
  }
  if (!groups.length) {
    container.innerHTML = '<div class="small-meta">Traits dataset unavailable.</div>';
    return;
  }
  renderTraitGroups(container, groups);
}

function buildTraitFallback() {
  const map = new Map();
  state.tokenNodes.forEach(node => {
    (node.traits || []).forEach(({ key, value }) => {
      const type = (key || '').trim();
      const val = (value || '').trim();
      if (!type || !val) return;
      if (!map.has(type)) map.set(type, new Map());
      const bucket = map.get(type);
      bucket.set(val, (bucket.get(val) || 0) + 1);
    });
  });
  return Array.from(map.entries()).map(([type, bucket]) => ({
    type,
    values: Array.from(bucket.entries()).map(([value, count]) => ({ value, count }))
  })).filter(group => group.values.length).sort((a, b) => a.type.localeCompare(b.type));
}

function renderTraitGroups(container, groups) {
  container.innerHTML = '';
  state.traitGroups = groups;
  groups.forEach(group => {
    const section = document.createElement('div');
    section.className = 'trait-group-container';
    const header = document.createElement('div');
    header.className = 'trait-group-title';
    header.textContent = (group.type || '').toUpperCase();
    section.appendChild(header);
    const list = document.createElement('div');
    list.className = 'trait-group-list';
    (group.values || []).forEach(entry => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'trait-filter chip';
      item.dataset.type = String(group.type || '').trim();
      item.dataset.value = String(entry?.value || '').trim();
      item.innerHTML = `<span class="trait-filter-label">${escapeHtml(item.dataset.value || '—')}</span><span class="trait-filter-count">${entry?.count ?? 0}</span>`;
      item.addEventListener('click', () => handleTraitFilter(item.dataset.type, item.dataset.value));
      list.appendChild(item);
    });
    section.appendChild(list);
    container.appendChild(section);
  });
  updateTraitFilterStates();
}

async function handleTraitFilter(type, value) {
  if (!type || !value) return;
  const trimmedType = String(type || '').trim();
  const trimmedValue = String(value || '').trim();
  if (!trimmedType || !trimmedValue) return;
  if (!state.selectedTraits.has(trimmedType)) {
    state.selectedTraits.set(trimmedType, new Set());
  }
  const set = state.selectedTraits.get(trimmedType);
  if (set.has(trimmedValue)) {
    set.delete(trimmedValue);
    if (set.size === 0) state.selectedTraits.delete(trimmedType);
  } else {
    set.add(trimmedValue);
  }
  updateTraitFilterStates();
  await applyTraitFilterHighlights();
}

function updateTraitFilterStates() {
  document.querySelectorAll('.trait-filter').forEach(btn => {
    const type = btn.dataset.type || '';
    const value = btn.dataset.value || '';
    const activeSet = state.selectedTraits.get(type);
    const active = activeSet ? activeSet.has(value) : false;
    btn.classList.toggle('active', active);
  });
}

async function applyTraitFilterHighlights() {
  const entries = Array.from(state.selectedTraits.entries()).filter(([, set]) => set && set.size);
  if (!entries.length) {
    state.highlighted = null;
    resetSidebarEmpty(true);
    renderCurrentView();
    return;
  }
  const requestId = ++state.traitRequestId;
  let result = null;
  for (const [type, values] of entries) {
    for (const value of values) {
      const tokenSet = await getTraitTokenSet(type, value);
      if (!tokenSet.size) {
        result = new Set();
        break;
      }
      if (!result) {
        result = new Set(tokenSet);
      } else {
        result = new Set(Array.from(result).filter(id => tokenSet.has(id)));
      }
      if (result.size === 0) break;
    }
    if (result && result.size === 0) break;
  }
  if (state.traitRequestId !== requestId) return;
  if (result && result.size) {
    state.highlighted = result;
    renderCurrentView();
    const first = result.values().next().value;
    if (Number.isFinite(first)) focusNode(first);
    showTraitSummary(result.size);
  } else {
    state.highlighted = null;
    renderCurrentView();
    showTraitSummary(0);
  }
}

async function getTraitTokenSet(type, value) {
  const key = `${type}:::${value}`;
  if (state.traitTokenCache.has(key)) return state.traitTokenCache.get(key);
  let ids = [];
  try {
    const resp = await jfetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);
    if (Array.isArray(resp?.tokens)) ids = resp.tokens.map(Number).filter(Number.isFinite);
  } catch {}
  if (!ids.length) {
    ids = state.tokenNodes.filter(node => (node.traits || []).some(t => t.key === type && t.value === value)).map(node => node.id);
  }
  const set = new Set(ids);
  state.traitTokenCache.set(key, set);
  return set;
}

function showTraitSummary(count) {
  const bodyEl = document.getElementById('sidebar-body');
  const emptyEl = document.getElementById('sidebar-empty');
  if (!bodyEl || !emptyEl) return;
  const filters = [];
  state.selectedTraits.forEach((set, type) => {
    set.forEach(value => filters.push(`${escapeHtml(type.toUpperCase())}: ${escapeHtml(value)}`));
  });
  bodyEl.classList.add('hidden');
  bodyEl.hidden = true;
  emptyEl.classList.remove('hidden');
  emptyEl.hidden = false;
  const filterHtml = filters.map(item => `<div>${item}</div>`).join('');
  emptyEl.innerHTML = `<div class="token-title">Trait Filters</div><div class="small-meta">${count} token${count === 1 ? '' : 's'} match the selected traits.</div><div class="section-text">${filterHtml || '—'}</div>`;
}

function resetSidebarEmpty(force = false) {
  if (!force && state.selectedTraits.size) {
    showTraitSummary(state.highlighted instanceof Set ? state.highlighted.size : 0);
    return;
  }
  const emptyEl = document.getElementById('sidebar-empty');
  const bodyEl = document.getElementById('sidebar-body');
  const thumb = document.getElementById('thumb');
  if (!emptyEl || !bodyEl) return;
  emptyEl.classList.remove('hidden');
  emptyEl.hidden = false;
  emptyEl.textContent = 'Select a node…';
  bodyEl.classList.add('hidden');
  bodyEl.hidden = true;
  if (thumb) thumb.style.display = 'none';
}

function normalizedDepth(volume, maxVolume, rarity) {
  const volNorm = Math.log1p(Math.max(0, volume)) / Math.log1p(Math.max(1, maxVolume));
  const rarNorm = clamp(Number.isFinite(rarity) ? rarity : 0.5, 0, 1);
  return (volNorm * 80) + (rarNorm * 40);
}

function nodeSize(saleCount, isWhale) {
  const metric = Math.log10(Math.max(1, saleCount + 1));
  let size = 18 + metric * 6;
  if (isWhale) size *= 1.35;
  return clamp(size, 12, 42);
}

function extractEthosFromToken(token) {
  const raw = token?.ethos || {};
  const score = Number(raw.score ?? token?.ethosScore ?? token?.ethos_score ?? null);
  const tagsRaw = raw.tags ?? token?.ethosTags ?? token?.ethos_tags ?? [];
  const blurb = raw.blurb ?? token?.ethosBlurb ?? token?.ethos_blurb ?? '';
  const tags = Array.isArray(tagsRaw) ? tagsRaw.filter(Boolean).map(t => String(t)) : [];
  if (!Number.isFinite(score) && tags.length === 0 && !blurb) return null;
  return {
    score: Number.isFinite(score) ? score : null,
    tags,
    blurb: blurb ? String(blurb) : ''
  };
}

function extractTradingFromToken(token, fall, preset, idx) {
  const arrays = preset || {};
  const lastSale = toFinite(token?.lastSalePrice ?? token?.last_sale_price ?? arrays?.tokenLastSalePrice?.[idx] ?? fall?.last_sale_price);
  const holdDays = toFinite(token?.holdDays ?? token?.hold_days ?? arrays?.tokenHoldDays?.[idx] ?? fall?.hold_days);
  const volumeUsd = toFinite(token?.volumeAllUsd ?? token?.volumeUsd ?? token?.volume_all_usd);
  return {
    lastSale: lastSale,
    holdDays: holdDays,
    volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0
  };
}

function extractStoryFromToken(token, fall) {
  const story = token?.story ?? token?.narrative ?? token?.story_summary ?? fall?.story ?? '';
  return story ? String(story) : '';
}

function extractTraitsFromToken(token) {
  const list = Array.isArray(token?.traits) ? token.traits : token?.attributes;
  if (!Array.isArray(list)) return [];
  return list
    .map(entry => {
      const key = String(entry?.trait_type ?? entry?.type ?? entry?.k ?? '').trim();
      const value = String(entry?.trait_value ?? entry?.value ?? entry?.v ?? '').trim();
      return key || value ? { key, value } : null;
    })
    .filter(Boolean);
}

function computeNodeColor(node, { isSelected, isHovered, isHighlighted }) {
  const base = Array.isArray(node.displayColor)
    ? node.displayColor
    : Array.isArray(node.baseColor)
      ? node.baseColor
      : COLORS.active;
  const color = base.slice();
  let alpha = color[3] ?? 210;
  if (isSelected) alpha = 255;
  else if (isHovered) alpha = clamp(alpha + 40, 0, 255);
  else if (isHighlighted) alpha = clamp(alpha + 30, 0, 255);
  color[3] = alpha;
  return color;
}

function colorToThree(rgba, boost = 1) {
  const scale = (value) => {
    const normalized = clamp(value ?? 0, 0, 255) / 255;
    return clamp(Math.pow(normalized, 0.6) * 1.25 * boost, 0, 1);
  };
  const [r, g, b] = Array.isArray(rgba) ? rgba : TOKENS.fg;
  return { r: scale(r), g: scale(g), b: scale(b) };
}

function scheduleZoomToFit() {
  if (!state.graph) return;
  const nodes = Array.from(state.viewNodes?.values?.() || state.nodes || []);
  requestAnimationFrame(() => fitCameraToNodes(nodes));
}

function buildSprite(node) {
  if (!node) return null;
  if (state.nodeSprites.has(node.id)) {
    const existing = state.nodeSprites.get(node.id);
    if (!existing || !existing.material) {
      state.nodeSprites.delete(node.id);
    } else {
      return existing;
    }
  }
  const baseColor = node.baseColor || COLORS.active;
  const tint = colorToThree(baseColor);
  const material = new THREE.SpriteMaterial({
    map: spriteTexture || null,
    color: new THREE.Color(tint.r, tint.g, tint.b),
    transparent: true,
    opacity: (baseColor[3] ?? 255) / 255,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending
  });
  const sprite = new THREE.Sprite(material);
  const size = node.baseSize || node.displaySize || 20;
  sprite.scale.set(size, size, size);
  sprite.center.set(0.5, 0.5);
  sprite.renderOrder = 1;
  sprite.userData = { nodeId: node.id, baseAlpha: baseColor[3] ?? 210 };
  state.nodeSprites.set(node.id, sprite);
  return sprite;
}

function disposeSprites() {
  state.nodeSprites.forEach(sprite => {
    if (sprite?.material?.dispose) {
      sprite.material.dispose();
    }
  });
  state.nodeSprites.clear();
}

function renderCurrentView() {
  if (!state.graph) return Promise.resolve();
  hideExplainOverlay();
  let result;
  switch (state.activeView) {
    case View.BUBBLE:
      result = renderBubbleMapView();
      break;
    case View.TREE:
      result = renderTreeTopdownView(state.treeTopdown?.root || state.selectedId || (state.ownerNodes[0]?.address ?? null));
      break;
    case View.FLOW:
      result = renderFlowView();
      break;
    case View.RHYTHM:
      result = renderRhythmView();
      break;
    default:
      result = renderBubbleMapView();
      break;
  }
  if (result && typeof result.then === 'function') {
    return result.then(() => updateViewControls());
  }
  updateViewControls();
  return Promise.resolve();
}

function renderDotsView() {
  if (!state.graph) return;
  hideExplainOverlay();
  useOwnerDataset();
  state.colorMode = 'default';
  toggleControl('edges', true, 'Link density');
  state.graph.nodeThreeObject(node => buildSprite(node));
  state.graph.nodeThreeObjectExtend(false);
  state.graph.numDimensions(2);
  const cap = effectiveEdgeCap();
  const links = state.ownerEdges.holders.slice(0, cap);
  state.graph.graphData({ nodes: state.nodes, links });
  state.graph.d3VelocityDecay(1);
  if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(0);
  state.viewNodes = new Map(state.nodeMap);
  state.graph.linkColor(linkColor);
  state.graph.linkOpacity(linkOpacity);
  state.graph.linkWidth(link => link?.width || 1);
  if (typeof state.graph.linkDirectionalParticles === 'function') state.graph.linkDirectionalParticles(() => 0);
  if (typeof state.graph.linkLineDash === 'function') state.graph.linkLineDash(() => []);
  if (state.clusterMode) applyClusterModeIfNeeded();
  updateNodeStyles();
  scheduleZoomToFit();
}

async function renderBubbleMapView() {
  if (!state.graph) return;
  startUILoad();
  try {
    const preset = await jfetch(`${API.preset}?nodes=10000`);
    const nodes = buildBubbleNodes(preset);
    if (!nodes.length) {
      state.graph.graphData({ nodes: [], links: [] });
      state.viewNodes = new Map();
      hideExplainOverlay();
      return;
    }

    bubbleMapLayout(nodes, {
      groupBy: n => n.groupKey,
      radius: n => Math.max(6, Math.sqrt(n.flowMetric || n.holdingCount || 1)),
      padding: 1.4
    });

    nodes.forEach(node => {
      const size = Math.max(18, (node.r || 4) * 6);
      node.baseSize = size;
      node.displaySize = size;
      node.fx = node.x;
      node.fy = node.y;
      node.fz = 0;
    });

    toggleControl('edges', false);
    if (typeof state.graph.linkVisibility === 'function') state.graph.linkVisibility(() => false);
    state.graph
      .graphData({ nodes, links: [] })
      .cooldownTicks(0)
      .d3AlphaDecay(1);
    state.graph.linkColor(() => 'rgba(0,0,0,0)');
    state.graph.linkOpacity(() => 0);
    state.graph.linkWidth(() => 0);
    state.graph.nodeThreeObject(node => circle(node, Math.max(6, Math.sqrt(node.flowMetric || node.holdingCount || 1))));
    state.graph.nodeThreeObjectExtend(false);
    state.graph.numDimensions(2);
    state.graph.d3VelocityDecay(1);
    if (typeof state.graph.nodeOpacity === 'function') state.graph.nodeOpacity(() => 1);

    state.bubbleNodes = nodes;
    state.viewNodes = new Map(nodes.map(n => [n.id, n]));
    state.selectedId = null;
    state.highlighted = null;
    hideExplainOverlay();
    updateNodeStyles();
    scheduleZoomToFit();
  } catch (err) {
    console.warn('three.app: bubble map error', err?.message || err);
    state.graph.graphData({ nodes: [], links: [] });
  } finally {
    stopUILoad();
  }
}

function buildBubbleNodes(preset = {}) {
  const owners = Array.isArray(preset?.owners) ? preset.owners : [];
  if (!owners.length) return [];
  const ownerIndex = Array.isArray(preset?.ownerIndex) ? preset.ownerIndex : [];
  const ownerWalletType = Array.isArray(preset?.ownerWalletType) ? preset.ownerWalletType : [];
  const ownerCommunity = Array.isArray(preset?.ownerCommunityId) ? preset.ownerCommunityId : [];
  const ownerEthos = Array.isArray(preset?.ownerEthos) ? preset.ownerEthos : [];
  const ownerBuyVol = Array.isArray(preset?.ownerBuyVol) ? preset.ownerBuyVol : [];
  const ownerSellVol = Array.isArray(preset?.ownerSellVol) ? preset.ownerSellVol : [];

  const holdings = new Array(owners.length).fill(0);
  ownerIndex.forEach(idx => {
    if (Number.isInteger(idx) && idx >= 0 && idx < holdings.length) holdings[idx] += 1;
  });

  return owners.map((wallet, i) => {
    const address = String(wallet || '').toLowerCase();
    const walletType = String(ownerWalletType[i] || '').toLowerCase();
    const community = Number.isFinite(ownerCommunity[i]) ? Number(ownerCommunity[i]) : null;
    const baseColor = colorForWallet(walletType, community, i);
    const flow = (Number(ownerBuyVol[i] || 0) || 0) + (Number(ownerSellVol[i] || 0) || 0);
    const ethosScore = Number(ownerEthos[i] || 0) || 0;

    return {
      id: address || `owner-${i}`,
      address,
      label: address ? `${address.slice(0, 6)}…${address.slice(-4)}` : `owner-${i + 1}`,
      walletType,
      community,
      ethosScore,
      flowMetric: flow,
      holdingCount: holdings[i] || 0,
      baseColor: baseColor.slice(0, 4),
      displayColor: baseColor.slice(0, 4),
      stage: 'owner',
      groupKey: walletType || (community != null ? `community-${community}` : 'other')
    };
  });
}

function circle(node, r) {
  const tint = colorToThree(node?.baseColor || node?.displayColor || CSS_COLORS.nodeFill);
  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(r, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tint.r, tint.g, tint.b), opacity: 0.9, transparent: true })
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r + 0.9, r + 1.4, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tint.r, tint.g, tint.b), opacity: 1, transparent: true })
  );
  group.add(fill);
  group.add(ring);
  return group;
}

function renderFlowView() {
  if (!state.graph) return;
  useOwnerDataset();
  state.colorMode = 'flow';
  state.graph.nodeThreeObject(node => buildSprite(node));
  state.graph.nodeThreeObjectExtend(false);
  state.graph.numDimensions(2);
  const cap = effectiveEdgeCap();
  const links = state.ownerEdges.flow.slice(0, cap);
  toggleControl('edges', true, 'Link density');
  state.graph.graphData({ nodes: state.nodes, links });
  state.graph.d3VelocityDecay(1);
  if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(0);
  state.viewNodes = new Map(state.nodeMap);
  const flowSummary = summarizeFlowOverview();
  if (flowSummary) showExplainOverlay(flowSummary, { rememberDefault: true });
  else hideExplainOverlay();
  state.graph.linkColor(linkColor);
  state.graph.linkOpacity(linkOpacity);
  state.graph.linkWidth(linkWidth);
  if (typeof state.graph.linkCurvature === 'function') state.graph.linkCurvature(() => 0.4);
  if (typeof state.graph.linkDirectionalParticles === 'function') state.graph.linkDirectionalParticles(() => 0);
  if (typeof state.graph.linkLineDash === 'function') state.graph.linkLineDash(linkDash);
  applyLinkStylesForView();
  updateNodeStyles();
  scheduleZoomToFit();
}

function renderRhythmView() {
  if (!state.graph) return;
  hideExplainOverlay();
  useTokenDataset();
  state.colorMode = 'rhythm';
  state.highlighted = null;
  state.graph.nodeThreeObject(node => buildSprite(node));
  state.graph.nodeThreeObjectExtend(false);
  const saleRecentValues = state.tokenNodes.map(node => Number(node.saleCount30d ?? node.saleCount ?? 0));
  const p95Recent = percentile(saleRecentValues, 0.95) || 1;
  const turnoverValues = state.tokenNodes.map(node => {
    const hold = Number.isFinite(node.holdDays) ? Math.max(1, node.holdDays) : 1;
    return Math.log1p((Number(node.saleCount ?? 0) || 0) / hold);
  });
  const maxTurnover = Math.max(...turnoverValues.filter(v => Number.isFinite(v)), 1);
  const width = 640;
  const height = 420;
  const ageRange = 180; // days

  const clones = state.tokenNodes.map((source, i) => {
    const clone = { ...source };
    const rarity = clamp(Number(source.rarity ?? 0.5), 0, 1);
    const saleRecent = saleRecentValues[i] || 0;
    const hold = Number.isFinite(source.holdDays) ? Math.max(1, source.holdDays) : 1;
    const turnoverLog = Math.log1p((Number(source.saleCount ?? 0) || 0) / hold);
    const turnoverNorm = maxTurnover > 0 ? turnoverLog / maxTurnover : 0;
    const radius = 2 + 4 * sqrtScale(saleRecent, p95Recent);
    const daysSince = Number.isFinite(source.daysSince) ? Math.max(0, source.daysSince) : ageRange;
    const recencyFactor = 1 - clamp(daysSince / ageRange, 0, 1);
    const color = blendColors(CSS_COLORS.muted, CSS_COLORS.accent, recencyFactor);

    clone.x = (rarity - 0.5) * width;
    clone.y = (turnoverNorm - 0.5) * height;
    clone.z = 0;
    clone.fx = clone.x;
    clone.fy = clone.y;
    clone.fz = 0;
    clone.baseColor = color;
    clone.displayColor = color.slice();
    const size = Math.max(12, radius * 5);
    clone.baseSize = size;
    clone.displaySize = size;
    clone.radius = size / 2;
    return clone;
  });
  applyRhythmBeeswarm(clones);
  toggleControl('time', false);
  toggleControl('edges', false);
  state.graph.graphData({ nodes: clones, links: [] });
  state.viewNodes = new Map(clones.map(n => [n.id, n]));
  if (typeof state.graph.linkVisibility === 'function') state.graph.linkVisibility(() => false);
  state.graph.linkColor(() => 'rgba(255,255,255,0.12)');
  state.graph.linkOpacity(() => 0.1);
  state.graph.linkWidth(() => 0.4);
  if (typeof state.graph.linkDirectionalParticles === 'function') state.graph.linkDirectionalParticles(() => 0);
  if (typeof state.graph.linkDirectionalParticleSpeed === 'function') state.graph.linkDirectionalParticleSpeed(() => 0.006);
  if (typeof state.graph.linkLineDash === 'function') state.graph.linkLineDash(() => []);
  state.graph.d3VelocityDecay(1);
  if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(0);
  applyLinkStylesForView();
  updateNodeStyles();
  scheduleZoomToFit();
}

function rebuildLinks() {
  renderCurrentView();
}

function applyRhythmBeeswarm(nodes) {
  if (!nodes.length) return;
  const radii = nodes.map(n => Math.max(COLLISION_MIN_RADIUS, n.radius || (n.displaySize || 12) / 2));
  const medianRadius = median(radii) || COLLISION_MIN_RADIUS;
  const binWidth = Math.max(8, 2 * medianRadius + COLLISION_PADDING);
  const padding = COLLISION_PADDING;
  const bins = new Map();
  nodes.forEach((node, index) => {
    const radius = Math.max(COLLISION_MIN_RADIUS, node.radius || (node.displaySize || 12) / 2);
    node.radius = radius;
    const key = Math.round(node.x / binWidth);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push({ node, desiredY: node.y, index });
  });
  bins.forEach(items => {
    items.sort((a, b) => a.desiredY - b.desiredY);
    const placed = [];
    items.forEach(item => {
      const nodeRadius = item.node.radius;
      const step = nodeRadius + padding;
      let bestY = item.desiredY;
      let attempt = 0;
      const maxAttempts = placed.length * 4 + 4;
      while (attempt < maxAttempts) {
        const hasOverlap = placed.some(other => {
          const required = nodeRadius + other.radius + padding;
          return Math.abs(bestY - other.y) < required;
        });
        if (!hasOverlap) break;
        attempt++;
        const direction = attempt % 2 === 0 ? -1 : 1;
        const offset = Math.ceil(attempt / 2) * step;
        bestY = item.desiredY + direction * offset;
      }
      item.node.y = bestY;
      item.node.fy = bestY;
      placed.push({ y: bestY, radius: nodeRadius });
    });
  });
}

function currentToggles() {
  return {
    ambient: isChecked('ambient-edges', false),
    ownership: isChecked('layer-ownership', true),
    traits: isChecked('layer-traits', false),
    transfers: isChecked('layer-transfers', true),
    sales: isChecked('layer-sales', true),
    mints: isChecked('layer-mints', true),
    mixed: isChecked('layer-trades', false)
  };
}

function effectiveEdgeCap() {
  const zoomBucket = currentZoomBucket();
  const sliderCap = state.edgeCap;
  let zoomCap = 500;
  if (zoomBucket === 'far') zoomCap = 100;
  else if (zoomBucket === 'mid') zoomCap = 300;
  return Math.min(sliderCap, zoomCap);
}

function currentZoomBucket() {
  if (!state.controls) return 'near';
  const cam = state.graph?.camera();
  if (!cam) return 'near';
  const target = state.controls.target || new THREE.Vector3(0, 0, 0);
  const dist = cam.position.distanceTo(target);
  if (dist > 1600) return 'far';
  if (dist > 900) return 'mid';
  return 'near';
}

function linkColor() {
  const [r, g, b] = CSS_COLORS.link;
  return `rgba(${r}, ${g}, ${b}, 1)`;
}

function linkWidth(link) {
  if (state.activeView === View.TREE) return 1;
  if (!link) return 1;
  if (typeof link.width === 'number') return link.width;
  const base = Math.log1p(Math.max(1, link.weight || 1));
  return 1 + base * 0.5;
}
function linkOpacity(link) {
  const defaultOpacity = typeof link?.opacity === 'number' ? link.opacity : 0.12;
  const focus = state.selectedId;
  if (focus == null) return defaultOpacity;
  const sourceId = link?.source && typeof link.source === 'object' ? link.source.id : link?.source;
  const targetId = link?.target && typeof link.target === 'object' ? link.target.id : link?.target;
  const isConnected = focus === sourceId || focus === targetId;
  if (isConnected) return 0.6;
  return defaultOpacity;
}

function linkDash() {
  return [];
}

function applyLinkStylesForView() {
  if (!state.graph) return;
  if (typeof state.graph.linkCurvature === 'function') {
    if (state.activeView === View.FLOW) {
      state.graph.linkCurvature(() => 0.4);
    } else if (state.activeView === View.TREE) {
      state.graph.linkCurvature(() => 0.35);
    } else {
      state.graph.linkCurvature(() => 0);
    }
  }
  if (typeof state.graph.linkDirectionalArrowLength === 'function') {
    state.graph.linkDirectionalArrowLength(() => 0);
  }
  if (typeof state.graph.linkVisibility === 'function') {
    state.graph.linkVisibility(() => true);
  }
}

function nodeLabel(node) {
  if (!node) return '';
  if (state.activeView === View.FLOW) {
    const focus = state.selectedId;
    if (!focus) return '';
    if (node.id === focus) return node.label || node.address || '';
    const neighbors = state.ownerTopNeighbors.get(focus) || [];
    return neighbors.includes(node.id) ? (node.label || node.address || '') : '';
  }
  return `#${node.id}`;
}

function applyClusterModeIfNeeded() {}

function applyClusterPacking(groupBy) {
  if (!state.graph) return;
  const groups = new Map();
  state.nodes.forEach(node => {
    const ownerKey = groupBy === 'segment'
      ? (node.segment || node.typeRaw || 'segment-unknown')
      : (Number.isFinite(node.ownerIndex) ? `owner-${node.ownerIndex}` : 'owner-unknown');
    if (!groups.has(ownerKey)) groups.set(ownerKey, []);
    groups.get(ownerKey).push(node);
  });
  const children = Array.from(groups.entries()).map(([key, list]) => ({ key, children: list.map(node => ({ node })) }));
  if (!children.length) return;
  const root = hierarchy({ key: 'root', children })
    .sum(d => (d.node ? 1 : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const width = 1600;
  const height = 1000;
  d3pack().size([width, height]).padding(8)(root);

  clearClusterMeshes();

  const offsetX = width / 2;
  const offsetY = height / 2;
  root.children?.forEach(group => {
    const cx = group.x - offsetX;
    const cy = group.y - offsetY;
    const leaves = group.descendants().filter(d => d.data.node);
    leaves.forEach(leaf => {
      const n = leaf.data.node;
      const localX = leaf.x - group.x;
      const localY = leaf.y - group.y;
      n.x = cx + localX;
      n.y = cy + localY;
      n.z = 0;
      n.fx = n.x;
      n.fy = n.y;
      n.fz = 0;
    });
    addGroupRing(cx, cy, group.r);
  });

  state.graph.d3VelocityDecay(1);
  if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(0);
  state.graph.refresh();
}

function addGroupRing(cx, cy, radius) {
  if (!state.graph || radius <= 0) return;
  const scene = typeof state.graph.scene === 'function' ? state.graph.scene() : null;
  if (!scene) return;
  const segments = 64;
  const inner = Math.max(0, radius - 4);
  const geometry = new THREE.RingGeometry(inner, radius, segments);
  const material = new THREE.MeshBasicMaterial({ color: 0x33ff99, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(cx, cy, -15);
  state.clusterMeshes.push(mesh);
  scene.add(mesh);
}

function clearClusterMeshes() {
  if (!state.graph || !Array.isArray(state.clusterMeshes)) return;
  const scene = typeof state.graph.scene === 'function' ? state.graph.scene() : null;
  while (state.clusterMeshes.length) {
    const mesh = state.clusterMeshes.pop();
    if (!mesh) continue;
    scene?.remove(mesh);
    if (mesh.material?.dispose) mesh.material.dispose();
    if (mesh.geometry?.dispose) mesh.geometry.dispose();
  }
}

function releaseClusterMode() {
  clearClusterMeshes();
  restoreHomePositions(true);
  if (!state.graph) return;
  state.graph.d3VelocityDecay(DEFAULT_DECAY);
  state.graph.d3ReheatSimulation();
  try { state.graph.refresh(); } catch {}
}

function restoreHomePositions(pin = true) {
  state.nodes.forEach(node => {
    const x = Number.isFinite(node.homeX) ? node.homeX : node.x ?? 0;
    const y = Number.isFinite(node.homeY) ? node.homeY : node.y ?? 0;
    const z = Number.isFinite(node.homeZ) ? node.homeZ : node.z ?? 0;
    node.x = x;
    node.y = y;
    node.z = z;
    if (pin) {
      node.fx = x;
      node.fy = y;
      node.fz = z;
    } else {
      delete node.fx;
      delete node.fy;
      delete node.fz;
    }
  });
}

async function renderTreeTopdownView(rootCandidate) {
  if (!state.graph) return;
  const resolvedRoot = resolveOwnerAddress(rootCandidate) || rootCandidate;
  toggleControl('edges', false);
  toggleControl('time', false);
  state.colorMode = 'tree';
  if (!resolvedRoot) {
    state.graph.graphData({ nodes: [], links: [] });
    state.treeTopdown = { root: null, data: null, loading: false };
    return;
  }
  state.treeTopdown = { root: resolvedRoot, data: state.treeTopdown?.data || null, loading: true };
  try {
    const data = await buildTopdownTree(resolvedRoot, {
      depth: state.treeTopdownDepth,
      minTrades: 1,
      edgesLimit: 500
    });
    state.treeTopdown = { root: resolvedRoot, data, loading: false };
    attachTopdownTree(state.graph, data, {
      levelDistance: 110,
      radiusFn: node => Math.max(5, Math.sqrt(node.trades || 1) * 1.6)
    });
    state.graph.nodeThreeObjectExtend(false);
    state.graph.numDimensions(3);
    if (typeof state.graph.linkCurvature === 'function') state.graph.linkCurvature(() => 0.35);
    if (typeof state.graph.linkDirectionalParticles === 'function') {
      state.graph.linkDirectionalParticles(link => Math.min(8, Math.ceil((link.count || 0) / 2)));
    }
    state.graph.linkColor(() => 'rgba(255,255,255,0.22)');
    state.graph.linkOpacity(() => 0.6);
    state.graph.linkWidth(link => Math.max(1, Math.log1p(link.count || 1)));
    state.viewNodes = new Map(data.nodes.map(n => [n.id, n]));
    state.selectedId = resolvedRoot;
    highlightBranch(state.graph, null, data);
    const sidebarTarget = state.ownerAddressMap.get(resolvedRoot)?.id || resolvedRoot;
    updateSidebar(sidebarTarget);
    const summaryNode = data.nodes.find(n => n.id === resolvedRoot) || data.nodes[0];
    if (summaryNode) {
      showExplainOverlay(summarizeTopdownNode(summaryNode, data), { rememberDefault: true });
    } else {
      hideExplainOverlay();
    }
    updateNodeStyles();
    scheduleZoomToFit(140, 800);
  } catch (error) {
    console.warn('three.app: topdown tree error', error?.message || error);
    state.treeTopdown = { root: resolvedRoot, data: null, loading: false };
    hideExplainOverlay();
  }
}

function updateViewControls() {
  const clusterRow = document.getElementById('cluster-mode-row');
  if (clusterRow) clusterRow.hidden = true;
}

function toggleControl(control, isVisible, labelText) {
  const wrapper = document.querySelector(`[data-ctrl="${control}"]`);
  if (!wrapper) return;
  if (isVisible) {
    wrapper.hidden = false;
    wrapper.classList.remove('disabled');
  } else {
    wrapper.hidden = true;
    wrapper.classList.add('disabled');
  }
  const interactive = wrapper.querySelector('input,select,button');
  if (interactive) interactive.disabled = !isVisible;
  if (labelText) {
    const labelEl = wrapper.querySelector('[data-ctrl-label]');
    if (labelEl) labelEl.textContent = labelText;
  }
  if (control === 'edges') {
    const valueEl = document.getElementById('edge-count');
    if (valueEl) valueEl.textContent = String(state.edgeCap);
  }
}

function updateNodeStyles() {
  if (!state.graph) return;
  const highlightSet = state.highlighted instanceof Set ? state.highlighted : null;
  state.nodeSprites.forEach((sprite, id) => {
    const node = (state.viewNodes && state.viewNodes.get(id)) || state.nodeMap.get(id);
    if (!node || !sprite) return;
    const isSelected = state.selectedId === id;
    const isHighlighted = highlightSet ? highlightSet.has(id) : false;
    const isHovered = state.hoveredId === id;
    const color = computeNodeColor(node, { isSelected, isHovered, isHighlighted });
    const material = sprite.material;
    if (material?.color && typeof material.color.setRGB === 'function') {
      const tint = colorToThree(color, 1);
      material.color.setRGB(tint.r, tint.g, tint.b);
      if (!sprite.userData) sprite.userData = {};
      sprite.userData.baseAlpha = color[3] ?? 210;
      sprite.userData.nodeId = node.id;
    }
    const base = node.baseSize || node.displaySize || 20;
    const emphasis = isSelected ? 1.25 : isHovered ? 1.12 : isHighlighted ? 1.05 : 1;
    const scale = base * emphasis;
    if (sprite.scale?.set) sprite.scale.set(scale, scale, scale);
    if (material) {
      if (state.activeView === View.TREE) {
        material.opacity = highlightSet ? (isHighlighted ? 1 : 0.4) : 1;
      } else if (state.activeView === View.BUBBLE) {
        material.opacity = highlightSet ? (isHighlighted ? 1 : 0.3) : 1;
      } else {
        material.opacity = 1;
      }
    }
  });
  try { state.graph.refresh(); } catch {}
}

function focusNode(id) {
  if (state.activeView === View.TREE) {
    renderTreeTopdownView(id);
    return;
  }
  const node = (state.viewNodes && state.viewNodes.get(id)) || state.nodeMap.get(id);
  if (!node) return;
  state.selectedId = id;
  if (state.activeView === View.FLOW) {
    const neighbors = state.ownerTopNeighbors.get(id) || [];
    state.highlighted = neighbors.length ? new Set([id, ...neighbors]) : new Set([id]);
    showExplainOverlay(summarizeFlowNode(node));
  } else {
    state.highlighted = null;
    hideExplainOverlay();
  }
  const cam = state.graph.camera();
  const target = state.controls?.target || new THREE.Vector3(0, 0, 0);
  const currentDist = cam.position.distanceTo(target);
  const dist = clamp(currentDist, 220, 760);
  const dir = new THREE.Vector3(1, 0.32, 0.84).normalize();
  const targetPos = new THREE.Vector3(node.x, node.y, node.z);
  const newPos = targetPos.clone().addScaledVector(dir, dist);
  state.graph.cameraPosition({ x: newPos.x, y: newPos.y, z: newPos.z }, { x: node.x, y: node.y, z: node.z }, 600);
  if (state.controls?.target) state.controls.target.set(node.x, node.y, node.z);
  updateNodeStyles();
  updateSidebar(id);
}

function handleNodeClick(node) {
  if (!node) return;
  switch (state.activeView) {
    case View.TREE:
      renderTreeTopdownView(node.id);
      break;
    case View.BUBBLE:
      state.selectedId = node.id;
      updateSidebar(node.id);
      break;
    default:
      focusNode(node.id);
      break;
  }
}

function handleBackgroundClick() {
  state.selectedId = null;
  state.highlighted = null;
  updateNodeStyles();
  updateSidebar(null);
  const isStoryView = state.activeView === View.TREE || state.activeView === View.BUBBLE || state.activeView === View.FLOW;
  if (!isStoryView) hideExplainOverlay();
  if (state.activeView === View.TREE && state.treeTopdown?.data) {
    highlightBranch(state.graph, null, state.treeTopdown.data);
  }
  if (state.activeView === View.BUBBLE) {
    if (typeof state.graph?.nodeOpacity === 'function') state.graph.nodeOpacity(() => 1);
    updateNodeStyles();
  }
  if (state.explainDefault && isStoryView) {
    showExplainOverlay(state.explainDefault);
  }
}

function handleNodeHover(node) {
  const id = node?.id ?? null;
  if (state.hoveredId === id) return;
  state.hoveredId = id;
  if (state.activeView === View.BUBBLE) {
    const groupKey = node ? (node.segment || node.community || 'Other') : null;
    if (typeof state.graph?.nodeOpacity === 'function') {
      if (groupKey) {
        state.graph.nodeOpacity(nn => ((nn?.segment || nn?.community || 'Other') === groupKey ? 1 : 0.25));
      } else {
        state.graph.nodeOpacity(() => 1);
      }
    }
    state.highlighted = null;
  }
  if (state.activeView === View.TREE && state.treeTopdown?.data) {
    const dataset = state.treeTopdown.data;
    const branchSet = node ? computeTopdownBranchSet(node, dataset) : null;
    state.highlighted = branchSet;
    highlightBranch(state.graph, node || null, dataset);
    if (node) {
      showExplainOverlay(summarizeTopdownNode(node, dataset));
    } else if (state.explainDefault) {
      showExplainOverlay(state.explainDefault);
    } else {
      const rootNode = dataset.nodes.find(n => n.id === state.treeTopdown.root);
      if (rootNode) showExplainOverlay(summarizeTopdownNode(rootNode, dataset));
      else hideExplainOverlay();
    }
  }
  updateNodeStyles();
  if (state.stageEl) state.stageEl.style.cursor = node ? 'pointer' : 'grab';
}

async function highlightWallet(address) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return;
  try {
    const data = await jfetch(`/api/wallet/${encodeURIComponent(addr)}`);
    if (!data || !Array.isArray(data.tokens)) return;
    state.highlighted = new Set(data.tokens.map(Number));
    updateNodeStyles();
    const primary = data.tokens.find(id => state.nodeMap.has(id));
    if (primary) focusNode(primary);
  } catch (err) {
    console.warn('three.app: highlight wallet failed', err?.message || err);
  }
}

async function updateSidebar(id) {
  const bodyEl = document.getElementById('sidebar-body');
  const emptyEl = document.getElementById('sidebar-empty');
  const thumb = document.getElementById('thumb');
  if (!bodyEl || !emptyEl) return;
  if (typeof id === 'string') {
    const owner = state.ownerNodeMap.get(id) || state.ownerAddressMap.get(id.toLowerCase?.() || id);
    if (owner) {
      populateOwnerSidebar(owner);
      return;
    }
  }
  if (!Number.isFinite(id)) {
    bodyEl.classList.add('hidden');
    bodyEl.hidden = true;
    emptyEl.classList.remove('hidden');
    emptyEl.hidden = false;
    emptyEl.textContent = 'Select a node…';
    if (thumb) thumb.style.display = 'none';
    return;
  }
  startUILoad();
  try {
    const data = await jfetch(`/api/token/${id}`);
    if (!data || data.error) {
      bodyEl.classList.add('hidden');
      bodyEl.hidden = true;
      emptyEl.classList.remove('hidden');
      emptyEl.hidden = false;
      emptyEl.textContent = 'No metadata available.';
      if (thumb) thumb.style.display = 'none';
      return;
    }
    populateSidebar(id, data);
  } catch (err) {
    bodyEl.classList.add('hidden');
    bodyEl.hidden = true;
    emptyEl.classList.remove('hidden');
    emptyEl.hidden = false;
    emptyEl.textContent = 'Unable to load token metadata.';
    if (thumb) thumb.style.display = 'none';
  } finally {
    stopUILoad();
  }
}

function populateSidebar(id, data) {
  const bodyEl = document.getElementById('sidebar-body');
  const emptyEl = document.getElementById('sidebar-empty');
  const thumb = document.getElementById('thumb');
  if (!bodyEl || !emptyEl) return;
  bodyEl.classList.remove('hidden');
  bodyEl.hidden = false;
  emptyEl.classList.add('hidden');
  emptyEl.hidden = true;

  const imgPath = data.image_local || data.thumbnail_local || null;
  if (thumb) {
    if (imgPath) {
      thumb.src = `/${imgPath}`;
      thumb.alt = data.name || `Token ${id}`;
      thumb.style.display = 'block';
    } else {
      thumb.style.display = 'none';
    }
  }

  setFieldText('sb-id', `#${id}`);
  setFieldText('sb-name', data.name || '');

  const ownerDisplay = data.owner ? truncateAddr(data.owner) : '—';
  setFieldText('sb-owner', ownerDisplay);
  const saleCount = Number.isFinite(data.sale_count) ? formatNumber(data.sale_count) : '—';
  setFieldText('sb-sales', saleCount);
  const trading = normalizeTradingFromData(data);
  setFieldText('sb-last-sale', formatCurrency(trading.lastSale));
  setFieldText('sb-hold', trading.holdDays != null ? String(trading.holdDays) : '—');

  const ethos = normalizeEthosFromData(data);
  const ethosSection = document.getElementById('sb-ethos');
  if (ethosSection) {
    if (ethos) {
      ethosSection.classList.remove('hidden');
      ethosSection.hidden = false;
      setFieldText('sb-ethos-score', ethos.score != null ? formatNumber(ethos.score) : '—');
      setFieldHTML('sb-ethos-tags', renderTagPills(ethos.tags));
      setFieldText('sb-ethos-blurb', ethos.blurb || '');
    } else {
      ethosSection.classList.add('hidden');
      ethosSection.hidden = true;
      setFieldHTML('sb-ethos-tags', '');
      setFieldText('sb-ethos-blurb', '');
    }
  }

  const story = normalizeStoryFromData(data);
  const storySection = document.getElementById('sb-story');
  if (storySection) {
    if (story) {
      storySection.classList.remove('hidden');
      setFieldText('sb-story-text', story);
    } else {
      storySection.classList.add('hidden');
      setFieldText('sb-story-text', '');
    }
  }

  const traitList = Array.isArray(data.traits) ? data.traits.map(t => ({
    key: String(t?.trait_type ?? '').trim(),
    value: String(t?.trait_value ?? '').trim()
  })).filter(t => t.key || t.value) : [];
  setFieldHTML('sb-traits', renderTraitGrid(traitList));

  const description = (!story ? data.description : '') || '';

  const node = state.nodeMap.get(id);
  const viewNode = state.viewNodes?.get(id);
  const nodeTarget = node || viewNode;
  const mergedTraits = traitList.length ? traitList : (nodeTarget?.traits || []);
  const mergedEthos = ethos || nodeTarget?.ethos || null;
  const mergedTrading = {
    lastSale: trading.lastSale,
    holdDays: trading.holdDays,
    volumeUsd: trading.volumeUsd
  };
  if (node) {
    node.ethos = mergedEthos;
    node.trading = mergedTrading;
    node.story = story;
    node.traits = mergedTraits;
    if (Number.isFinite(mergedTrading.volumeUsd)) node.volumeUsd = mergedTrading.volumeUsd;
    applyNodeImportance(node);
  }
  if (viewNode && viewNode !== node) {
    viewNode.ethos = mergedEthos;
    viewNode.trading = mergedTrading;
    viewNode.story = story;
    viewNode.traits = mergedTraits;
    if (Number.isFinite(mergedTrading.volumeUsd)) viewNode.volumeUsd = mergedTrading.volumeUsd;
    applyNodeImportance(viewNode);
  }
  updateNodeStyles();
}

function populateOwnerSidebar(owner) {
  const bodyEl = document.getElementById('sidebar-body');
  const emptyEl = document.getElementById('sidebar-empty');
  const thumb = document.getElementById('thumb');
  if (!bodyEl || !emptyEl) return;
  bodyEl.classList.remove('hidden');
  bodyEl.hidden = false;
  emptyEl.classList.add('hidden');
  emptyEl.hidden = true;
  if (thumb) thumb.style.display = 'none';

  const label = owner.label || owner.address || owner.id;
  const walletType = owner.walletType ? owner.walletType.replace(/_/g, ' ').toUpperCase() : 'OWNER';
  setFieldText('sb-id', label);
  setFieldText('sb-name', walletType);
  const ownerDisplay = owner.address ? truncateAddr(owner.address) : '—';
  setFieldText('sb-owner', ownerDisplay);
  setFieldText('sb-sales', formatNumber(owner.flowMetric || 0));
  setFieldText('sb-last-sale', '—');
  setFieldText('sb-hold', owner.holdingCount != null ? String(owner.holdingCount) : '—');

  const ethosSection = document.getElementById('sb-ethos');
  if (ethosSection) {
    ethosSection.classList.add('hidden');
    ethosSection.hidden = true;
  }
  setFieldHTML('sb-ethos-tags', '');
  setFieldText('sb-ethos-blurb', '');
  setFieldText('sb-ethos-score', '—');

  const storySection = document.getElementById('sb-story');
  if (storySection) storySection.classList.add('hidden');
  setFieldText('sb-story-text', '');
  setFieldHTML('sb-traits', '');
}

function setFieldText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? '';
}

function setFieldHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html ?? '';
}

function normalizeEthosFromData(data) {
  const raw = data.ethos || {};
  const score = toFinite(raw.score ?? data.ethos_score ?? data.ethosScore);
  const tagsRaw = raw.tags ?? data.ethos_tags ?? data.ethosTags ?? [];
  const blurb = raw.blurb ?? data.ethos_blurb ?? data.ethosBlurb ?? '';
  const tags = Array.isArray(tagsRaw) ? tagsRaw.filter(Boolean).map(t => String(t)) : [];
  if (!Number.isFinite(score) && tags.length === 0 && !blurb) return null;
  return {
    score: Number.isFinite(score) ? score : null,
    tags,
    blurb: blurb ? String(blurb) : ''
  };
}

function normalizeStoryFromData(data) {
  const story = data.story ?? data.narrative ?? data.story_summary ?? '';
  return story ? String(story).trim() : '';
}

function normalizeTradingFromData(data) {
  const lastSale = toFinite(data.last_sale_price ?? data.lastSalePrice ?? data.last_sale);
  const holdDays = toFinite(data.hold_days ?? data.holdDays);
  const volumeUsd = toFinite(data.volume_all_usd ?? data.volumeAllUsd ?? data.volumeUsd);
  return {
    lastSale: lastSale,
    holdDays: holdDays,
    volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0
  };
}

function renderTagPills(tags = []) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return tags.map(tag => `<span class="pill">${escapeHtml(String(tag))}</span>`).join('');
}

function renderTraitGrid(traits = []) {
  if (!Array.isArray(traits) || !traits.length) {
    return `<div class="trait empty">No traits available</div>`;
  }
  return traits.map(t => {
    const key = escapeHtml(String(t.key || '')) || '—';
    const value = escapeHtml(String(t.value || '')) || '—';
    return `<div class="trait"><span class="k" title="${key}">${key}</span><span class="v" title="${value}">${value}</span></div>`;
  }).join('');
}

function formatCurrency(value, suffix = 'TIA') {
  if (!Number.isFinite(value)) return '—';
  return `${formatNumber(value)} ${suffix}`;
}

function bindUI() {
  const edgesEl = document.getElementById('edges-slider');
  const edgeCountEl = document.getElementById('edge-count');
  if (edgesEl && !edgesEl.dataset.threeBound) {
    edgesEl.dataset.threeBound = '1';
    edgesEl.addEventListener('input', () => {
      const value = parseInt(edgesEl.value || '200', 10) || 0;
      state.edgeCap = clamp(value, 0, 500);
      if (edgeCountEl) edgeCountEl.textContent = String(state.edgeCap);
      rebuildLinks();
    });
  }

  const toggleIds = [
    'ambient-edges',
    'layer-ownership',
    'layer-traits',
    'layer-trades',
    'layer-sales',
    'layer-transfers',
    'layer-mints',
    'layer-bubbles'
  ];
  toggleIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.threeBound) {
      el.dataset.threeBound = '1';
      el.addEventListener('change', () => {
        if (id === 'layer-bubbles') {
          state.showBubbles = !!el.checked;
          updateNodeStyles();
        } else {
          rebuildLinks();
        }
      });
    }
  });
  state.showBubbles = isChecked('layer-bubbles', false);

  const viewButtons = document.querySelectorAll('[data-view-btn]');
  viewButtons.forEach(btn => {
    if (btn.dataset.threeBound) return;
    btn.dataset.threeBound = '1';
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-view-btn');
      applySimpleView(key);
      setActiveViewButton(key);
    });
  });

  const viewSelect = document.getElementById('view');
  if (viewSelect && !viewSelect.dataset.threeBound) {
    viewSelect.dataset.threeBound = '1';
    viewSelect.addEventListener('change', () => {
      applySimpleView(viewSelect.value);
      setActiveViewButton(viewSelect.value);
    });
  }

  const searchEl = document.getElementById('search');
  if (searchEl && !searchEl.dataset.threeBound) {
    searchEl.dataset.threeBound = '1';
    searchEl.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const raw = (searchEl.value || '').trim();
      searchEl.value = '';
      if (!raw) return;
      if (/\.eth$/i.test(raw)) {
        try {
          const res = await jfetch(`/api/resolve?q=${encodeURIComponent(raw)}`);
          if (res?.address) { await highlightWallet(res.address); return; }
        } catch {}
      }
      if (/^0x[a-fA-F0-9]{40}$/.test(raw)) { await highlightWallet(raw); return; }
      const id = parseInt(raw, 10);
      if (Number.isFinite(id)) {
        if (state.activeView === View.TREE) renderTreeTopdownView(id);
        else focusNode(id);
      }
    });
  }

  const collapsibles = [
    { selector: '.edge-group', headerSelector: '.edge-group-header' },
    { selector: '.traits-section', headerSelector: '.traits-header' }
  ];
  collapsibles.forEach(({ selector, headerSelector }) => {
    document.querySelectorAll(`${selector} ${headerSelector}`).forEach(header => {
      if (header.dataset.threeBound) return;
      header.dataset.threeBound = '1';
      const container = header.closest(selector);
      const bodyId = header.getAttribute('aria-controls');
      const body = bodyId ? document.getElementById(bodyId) : container?.querySelector('.edge-group-body, .traits-body');
      const setState = (expanded) => {
        if (!container) return;
        container.classList.toggle('open', expanded);
        header.setAttribute('aria-expanded', String(expanded));
        if (body) body.hidden = !expanded;
      };
      const toggle = (event) => {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        const expanded = header.getAttribute('aria-expanded') === 'true';
        setState(!expanded);
        event.preventDefault();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', toggle);
      // Initialize hidden state
      const expanded = header.getAttribute('aria-expanded') === 'true';
      if (body) body.hidden = !expanded;
      container?.classList.toggle('open', expanded);
    });
  });

  const panelToggle = document.getElementById('panel-toggle');
  if (panelToggle && !panelToggle.dataset.threeBound) {
    panelToggle.dataset.threeBound = '1';
    panelToggle.addEventListener('click', () => {
      const panel = document.getElementById('left-panel');
      if (!panel) return;
      const hidden = panel.classList.toggle('hidden');
      panelToggle.setAttribute('aria-expanded', String(!hidden));
      try { window.localStorage.setItem(PANEL_KEY, hidden ? '1' : '0'); } catch {}
    });
  }
}

function bindExplainCard() {
  const nextBtn = document.getElementById('explain-next');
  if (nextBtn && !nextBtn.dataset.threeBound) {
    nextBtn.dataset.threeBound = '1';
    nextBtn.addEventListener('click', () => {
      if (!state.explainNextView) {
        hideExplainOverlay();
        return;
      }
      applySimpleView(state.explainNextView);
      setActiveViewButton(state.explainNextView);
      renderCurrentView();
    });
  }
}

function bindResize() {
  try {
    const ro = new ResizeObserver(() => {
      if (!state.graph || !state.stageEl) return;
      const { clientWidth, clientHeight } = state.stageEl;
      state.graph.width(clientWidth);
      state.graph.height(clientHeight);
    });
    ro.observe(state.stageEl);
  } catch {}
}

function applySimpleView(name) {
  const config = SIMPLE_VIEWS[name];
  if (!config) return;
  state.activeView = name;
  state.mode = config.mode;
  Object.entries(config.toggles).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = value;
  });
  updateViewControls();
  if (name !== View.BUBBLE) releaseClusterMode();
  if (name !== View.TREE) {
    state.treeTopdown = { root: state.treeTopdown?.root || null, data: null, loading: false };
  }
  state.highlighted = null;
  renderCurrentView();
}

function setActiveViewButton(name) {
  const buttons = document.querySelectorAll('[data-view-btn]');
  buttons.forEach(btn => {
    const key = btn.getAttribute('data-view-btn');
    btn.classList.toggle('active', key === name);
  });
  const viewEl = document.getElementById('view');
  if (viewEl) viewEl.value = name;
}

function exposeApi() {
  try {
    window.mammoths = Object.assign({}, window.mammoths, {
      focusToken: (id) => {
        if (id == null) return;
        state.selectedId = typeof id === 'number' ? id : id;
        updateNodeStyles();
        focusNode(id);
      },
      setSimpleView: (name) => {
        applySimpleView(name);
        setActiveViewButton(name);
        updateNodeStyles();
      }
    });
  } catch {}
}

function configureControls(ctrl, THREERef) {
  if (!ctrl) return;
  ctrl.enablePan = true;
  ctrl.enableZoom = true;
  ctrl.enableRotate = true;
  ctrl.dampingFactor = 0.08;
  ctrl.enableDamping = true;
  ctrl.minDistance = 0.5;
  ctrl.maxDistance = 3e7;
  ctrl.mouseButtons = {
    LEFT: THREERef.MOUSE.PAN,
    MIDDLE: THREERef.MOUSE.DOLLY,
    RIGHT: THREERef.MOUSE.ROTATE
  };
  ctrl.touches = {
    ONE: THREERef.TOUCH.PAN,
    TWO: THREERef.TOUCH.DOLLY_PAN
  };
}

function attachZoomListener(ctrl) {
  if (!ctrl || typeof ctrl.addEventListener !== 'function') return;
  const handler = throttle(() => {
    const bucket = currentZoomBucket();
    if (bucket !== state.lastZoomBucket) {
      state.lastZoomBucket = bucket;
      rebuildLinks();
    }
  }, 120);
  ctrl.addEventListener('change', handler);
}

function setupControlGuards() {
  const disableControls = () => setControlsEnabled(false);
  const enableControls = () => setControlsEnabled(true);
  ['left-panel', 'sidebar', 'header'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerenter', disableControls, { passive: true });
    el.addEventListener('pointerleave', enableControls, { passive: true });
  });
  if (state.stageEl) {
    state.stageEl.addEventListener('pointerenter', enableControls, { passive: true });
  }
}

function setControlsEnabled(flag) {
  if (!state.controls) return;
  if (typeof state.controls.enabled === 'boolean') {
    state.controls.enabled = flag;
  }
}

function initDraggablePanels() {
  try { makeDraggable(document.getElementById('left-panel'), 'panel-left'); } catch {}
  try { makeDraggable(document.getElementById('sidebar'), 'panel-right'); } catch {}
}

function makeDraggable(el, storageKey) {
  if (!el || el.dataset.dragBound) return;
  el.dataset.dragBound = '1';
  el.style.cursor = 'grab';
  const margin = 16;
  const snap = 12;
  const ignoreSelector = 'input,select,textarea,button,a,label,[role="slider"],[data-no-drag]';
  let pointerDown = false;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let startX = 0;
  let startY = 0;

  const applyPosition = (x, y) => {
    el.style.right = 'auto';
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  };

  const clampPosition = (x, y) => {
    const rect = el.getBoundingClientRect();
    const width = rect.width || el.offsetWidth || 0;
    const height = rect.height || el.offsetHeight || 0;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    return {
      x: clamp(x, margin, maxX),
      y: clamp(y, margin, maxY)
    };
  };

  const snapPosition = (x, y) => {
    const rect = el.getBoundingClientRect();
    const width = rect.width || el.offsetWidth || 0;
    const height = rect.height || el.offsetHeight || 0;
    const maxX = window.innerWidth - width - margin;
    const maxY = window.innerHeight - height - margin;
    if (Math.abs(x - margin) < snap) x = margin;
    if (Math.abs(x - maxX) < snap) x = maxX;
    if (Math.abs(y - margin) < snap) y = margin;
    if (Math.abs(y - maxY) < snap) y = maxY;
    return { x, y };
  };

  const restorePosition = () => {
    let restored = null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) restored = JSON.parse(raw);
    } catch {}
    const rect = el.getBoundingClientRect();
    const initial = clampPosition(restored?.x ?? rect.left, restored?.y ?? rect.top);
    applyPosition(initial.x, initial.y);
  };

  const onPointerDown = (event) => {
    if (event.type === 'mousedown' && event.button && event.button !== 0) return;
    if (event.target && event.target.closest(ignoreSelector)) return;
    const point = 'touches' in event ? event.touches[0] : event;
    const rect = el.getBoundingClientRect();
    pointerDown = true;
    dragging = false;
    startX = rect.left;
    startY = rect.top;
    offsetX = point.clientX - rect.left;
    offsetY = point.clientY - rect.top;
  };

  const onPointerMove = (event) => {
    if (!pointerDown) return;
    const point = 'touches' in event ? event.touches[0] : event;
    const nextX = point.clientX - offsetX;
    const nextY = point.clientY - offsetY;
    if (!dragging) {
      const dx = nextX - startX;
      const dy = nextY - startY;
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragging = true;
      el.dataset.active = 'true';
      el.style.cursor = 'grabbing';
    }
    const clamped = clampPosition(nextX, nextY);
    const snapped = snapPosition(clamped.x, clamped.y);
    applyPosition(snapped.x, snapped.y);
    if (event.cancelable) event.preventDefault();
  };

  const onPointerUp = () => {
    if (!pointerDown) return;
    if (dragging) {
      const rect = el.getBoundingClientRect();
      const pos = clampPosition(rect.left, rect.top);
      applyPosition(pos.x, pos.y);
      try { localStorage.setItem(storageKey, JSON.stringify({ x: pos.x, y: pos.y })); } catch {}
    }
    pointerDown = false;
    dragging = false;
    el.dataset.active = 'false';
    el.style.cursor = 'grab';
  };

  const onResize = () => {
    const rect = el.getBoundingClientRect();
    const pos = clampPosition(rect.left, rect.top);
    applyPosition(pos.x, pos.y);
  };

  el.addEventListener('mousedown', onPointerDown);
  el.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('mousemove', onPointerMove, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('mouseup', onPointerUp, { passive: true });
  window.addEventListener('touchend', onPointerUp, { passive: true });
  window.addEventListener('touchcancel', onPointerUp, { passive: true });
  window.addEventListener('resize', onResize);

  requestAnimationFrame(restorePosition);
}

function applyStoredPanelState() {
  const panel = document.getElementById('left-panel');
  const toggle = document.getElementById('panel-toggle');
  if (!panel) return;
  let hidden = false;
  try { hidden = window.localStorage.getItem(PANEL_KEY) === '1'; } catch {}
  if (hidden) panel.classList.add('hidden');
  if (toggle) toggle.setAttribute('aria-expanded', String(!hidden));
}

function purgeCenter() {}

function jfetch(url) {
  if (!jfetch.cache) jfetch.cache = new Map();
  const cache = jfetch.cache;
  if (cache.has(url)) return cache.get(url);
  const task = fetch(url).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }).catch(err => {
    cache.delete(url);
    throw err;
  });
  cache.set(url, task);
  return task;
}

function startUILoad() {
  const el = document.getElementById('top-loader');
  if (!el) return;
  const count = Number(el.dataset.count || '0') + 1;
  el.dataset.count = String(count);
  el.hidden = false;
}

function stopUILoad() {
  const el = document.getElementById('top-loader');
  if (!el) return;
  const count = Math.max(0, Number(el.dataset.count || '0') - 1);
  el.dataset.count = String(count);
  if (count === 0) el.hidden = true;
}

function isChecked(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  return !!el.checked;
}

function toFinite(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function throttle(fn, delay) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      fn(...args);
    } else if (!pending) {
      const wait = delay - (now - last);
      pending = setTimeout(() => {
        pending = null;
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

function formatDate(ts) {
  try {
    const d = new Date(ts * 1000);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function truncateAddr(addr) {
  if (!addr) return '—';
  const lower = String(addr).toLowerCase();
  return lower.length > 10 ? `${lower.slice(0, 6)}…${lower.slice(-4)}` : lower;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s] || s));
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function ownerLabel(entry) {
  if (!entry) return '—';
  if (typeof entry === 'object') {
    if (entry.label) return entry.label;
    if (entry.address) return truncateAddr(entry.address);
    if (entry.id != null) return ownerLabel(entry.id);
  }
  const raw = String(entry || '').trim();
  if (!raw) return '—';
  const node = state.ownerNodeMap?.get?.(raw);
  if (node) {
    if (node.label) return node.label;
    if (node.address) return truncateAddr(node.address);
  }
  const lower = raw.toLowerCase();
  const byAddress = state.ownerAddressMap?.get?.(lower);
  if (byAddress) {
    if (byAddress.label) return byAddress.label;
    if (byAddress.address) return truncateAddr(byAddress.address);
  }
  if (/^0x[a-f0-9]{40}$/.test(lower)) return truncateAddr(lower);
  return raw;
}

function linkEndpointId(endpoint) {
  if (!endpoint) return null;
  if (typeof endpoint === 'object') {
    if (endpoint.id != null) return endpoint.id;
    if (endpoint.address) return endpoint.address;
  }
  return endpoint;
}

function showExplainOverlay(summary, options = {}) {
  if (!summary) { hideExplainOverlay(); return; }
  const {
    title = '',
    metric = '',
    body = '',
    nextView = null
  } = summary;
  const rememberDefault = options.rememberDefault === true;
  const card = document.getElementById('explain-card');
  const titleEl = document.getElementById('explain-title');
  const metricEl = document.getElementById('explain-metric');
  const bodyEl = document.getElementById('explain-body');
  const nextBtn = document.getElementById('explain-next');
  if (!card || !titleEl || !metricEl || !bodyEl || !nextBtn) return;

  const normalized = {
    title: String(title || ''),
    metric: String(metric || ''),
    body: Array.isArray(body) ? body.map(line => String(line || '')) : String(body || ''),
    nextView: typeof nextView === 'string' && nextView ? nextView : null
  };

  titleEl.textContent = normalized.title;
  metricEl.textContent = normalized.metric;
  if (Array.isArray(normalized.body)) {
    bodyEl.innerHTML = normalized.body.map(line => `<p>${escapeHtml(line)}</p>`).join('');
  } else {
    bodyEl.textContent = normalized.body;
  }

  const hasNext = !!normalized.nextView;
  state.explainNextView = normalized.nextView;
  nextBtn.classList.toggle('hidden', !hasNext);
  nextBtn.disabled = !hasNext;
  if (hasNext) nextBtn.textContent = 'Next View';

  card.classList.remove('hidden');
  if (rememberDefault) state.explainDefault = normalized;
}

function hideExplainOverlay() {
  const card = document.getElementById('explain-card');
  if (!card) return;
  card.classList.add('hidden');
  state.explainNextView = null;
  state.explainDefault = null;
}

function summarizeTopdownNode(node, data) {
  const title = ownerLabel(node.id);
  const links = Array.isArray(data?.links) ? data.links : [];
  const children = links.filter(link => linkEndpointId(link.source) === node.id);
  const childCount = children.length;
  const totalTrades = children.reduce((sum, link) => sum + (Number(link.count ?? link.totalTrades ?? 0) || 0), 0);
  const recentTrades = children.reduce((sum, link) => sum + (Number(link.recent ?? 0) || 0), 0);
  const top = children.reduce((best, link) => {
    const weight = Number(link.count ?? link.totalTrades ?? 0) || 0;
    if (weight > best.weight) return { weight, link };
    return best;
  }, { weight: -Infinity, link: null });
  const topTarget = top.link ? ownerLabel(linkEndpointId(top.link.target)) : null;
  const metric = `${formatNumber(node.trades || totalTrades || 0)} trades • ${childCount} branch${childCount === 1 ? '' : 'es'}`;
  const body = [];
  if (childCount === 0) {
    body.push('No downstream counterparties yet.');
  } else {
    body.push(`Largest branch → ${topTarget || '—'} (${formatNumber(top.weight > 0 ? top.weight : 0)} trades).`);
    if (recentTrades > 0) body.push(`${formatNumber(recentTrades)} trades in last 30d.`);
  }
  body.push(`Depth ${node.level} • Volume index ${formatNumber(node.volume || 0)}`);
  return { title, metric, body, nextView: View.BUBBLE };
}

function summarizeFlowOverview() {
  const links = Array.isArray(state.ownerEdges?.flow) ? state.ownerEdges.flow : [];
  if (!links.length) return null;
  const weights = links.map(link => Number(link.weight || 0) || 0).filter(w => w >= 0);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const top = links.reduce((best, link) => {
    const weight = Number(link.weight || 0) || 0;
    if (weight > best.weight) return { weight, link };
    return best;
  }, { weight: -Infinity, link: null });
  const topSource = top.link ? ownerLabel(linkEndpointId(top.link.source)) : null;
  const topTarget = top.link ? ownerLabel(linkEndpointId(top.link.target)) : null;
  const body = [];
  if (top.link) body.push(`Peak corridor ${topSource || '—'} → ${topTarget || '—'} (${formatNumber(top.weight > 0 ? top.weight : 0)} trades).`);
  if (weights.length) {
    body.push(`Median lane ${formatNumber(median(weights))} trades · 95th pct ${formatNumber(percentile(weights, 0.95))}`);
  }
  const metric = `${formatNumber(links.length)} lanes • ${formatNumber(total)} trades`;
  return { title: 'Flow Corridors', metric, body, nextView: View.TREE };
}

function summarizeFlowNode(node) {
  const links = Array.isArray(state.ownerEdges?.flow) ? state.ownerEdges.flow : [];
  const edges = links.filter(link => {
    const src = linkEndpointId(link.source);
    const dst = linkEndpointId(link.target);
    return src === node.id || dst === node.id;
  });
  const outgoing = edges.reduce((sum, link) => {
    const src = linkEndpointId(link.source);
    return src === node.id ? sum + (Number(link.weight || 0) || 0) : sum;
  }, 0);
  const incoming = edges.reduce((sum, link) => {
    const dst = linkEndpointId(link.target);
    return dst === node.id ? sum + (Number(link.weight || 0) || 0) : sum;
  }, 0);
  const title = ownerLabel(node);
  const metric = `${formatNumber(edges.length)} lanes • ${formatNumber(outgoing)} out / ${formatNumber(incoming)} in`;
  const counterparts = edges.slice(0, 4).map(link => {
    const src = linkEndpointId(link.source);
    const dst = linkEndpointId(link.target);
    const other = src === node.id ? dst : src;
    return ownerLabel(other) || '—';
  });
  const body = edges.length ? [`Counterparties: ${counterparts.join(', ')}`] : ['No recent trades in window.'];
  return { title, metric, body, nextView: View.TREE };
}

function cloneEdgeAsAmbient(edge) {
  return { ...edge, kind: 'ambient', weight: edge.weight ?? 1 };
}

function buildSimpleEdges(edges, kind) {
  if (!Array.isArray(edges)) return [];
  return edges
    .map((entry, idx) => {
      const [source, target, weight] = Array.isArray(entry) ? entry : [];
      if (!state.nodeMap.has(source) || !state.nodeMap.has(target)) return null;
      return { id: `${kind}-${idx}`, source, target, weight: weight || 1, kind };
    })
    .filter(Boolean);
}
