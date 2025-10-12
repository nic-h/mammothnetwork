import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { hierarchy, tree as d3tree, pack as d3pack } from 'd3-hierarchy';

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
  treeNodes: new Map(),
  ownerNodes: [],
  ownerNodeMap: new Map(),
  ownerAddressMap: new Map(),
  ownerMetrics: { holdings: [], flow: [], p95Flow: 0, p95Holdings: 0 },
  ownerEdges: { holders: [], flow: [] },
  ownerTopNeighbors: new Map(),
  tokenNodes: [],
  tokenNodeMap: new Map(),
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
  activeView: 'dots',
  clusterMode: false,
  clusterMeshes: [],
  lastTreeRoot: null,
  colorMode: 'default',
  traitGroups: [],
  selectedTraits: new Map(),
  traitTokenCache: new Map(),
  traitRequestId: 0
};

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
  dots: {
    mode: 'holders',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': true,
      'layer-transfers': false,
      'layer-sales': false,
      'layer-mints': false,
      'layer-traits': false
    }
  },
  flow: {
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
  tree: {
    mode: 'traits',
    toggles: {
      'ambient-edges': false,
      'layer-ownership': false,
      'layer-transfers': false,
      'layer-sales': false,
      'layer-mints': false,
      'layer-traits': true
    }
  },
  rhythm: {
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

  graph.onNodeClick(node => {
    if (!node) return;
    if (state.activeView === 'tree') {
      renderTreeView(node.id);
    } else {
      focusNode(node.id);
    }
  });

  graph.onBackgroundClick(() => {
    state.selectedId = null;
    updateNodeStyles();
    updateSidebar(null);
    if (state.activeView === 'tree') {
      renderTreeView(state.lastTreeRoot ?? state.nodes[0]?.id ?? null);
    }
  });

  graph.onNodeHover(node => {
    const id = node?.id ?? null;
    if (state.hoveredId === id) return;
    state.hoveredId = id;
    updateNodeStyles();
    stageEl.style.cursor = id ? 'pointer' : 'grab';
  });

  applyStoredPanelState();
  bindUI();
  bindResize();
  initDraggablePanels();
  exposeApi();
  setupControlGuards();

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

    const ownerData = buildOwnerDataset(state.preset);
    seedOwnerLayout(ownerData.nodes);
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
      try { state.graph.zoomToFit(400, 50); } catch {}
      try { state.graph.refresh(); } catch {}
      state.lastZoomBucket = currentZoomBucket();
      try { window.__mammothDrawnFrame = true; } catch {}
    });
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

function scheduleZoomToFit(padding = 80, duration = 600) {
  if (!state.graph) return;
  requestAnimationFrame(() => {
    try { state.graph.zoomToFit(duration, padding); } catch {}
  });
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
  if (!state.graph) return;
  if (state.activeView === 'tree') {
    renderTreeView(state.selectedId ?? state.lastTreeRoot ?? state.nodes[0]?.id ?? null);
  } else if (state.activeView === 'flow') {
    renderFlowView();
  } else if (state.activeView === 'rhythm') {
    renderRhythmView();
  } else {
    renderDotsView();
  }
  updateViewControls();
}

function renderDotsView() {
  if (!state.graph) return;
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
  state.graph.linkColor(linkColor);
  state.graph.linkOpacity(linkOpacity);
  state.graph.linkWidth(linkWidth);
  if (typeof state.graph.linkDirectionalParticles === 'function') state.graph.linkDirectionalParticles(() => 0);
  if (typeof state.graph.linkLineDash === 'function') state.graph.linkLineDash(linkDash);
  applyLinkStylesForView();
  updateNodeStyles();
  scheduleZoomToFit();
}

function renderRhythmView() {
  if (!state.graph) return;
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
    return clone;
  });
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
  if (state.activeView === 'tree') return 1;
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
    state.graph.linkCurvature(state.activeView === 'flow' ? () => 0.15 : () => 0);
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
  if (state.activeView === 'dots' || state.activeView === 'flow') {
    const focus = state.selectedId;
    if (!focus) return '';
    if (node.id === focus) return node.label || node.address || '';
    const neighbors = state.ownerTopNeighbors.get(focus) || [];
    return neighbors.includes(node.id) ? (node.label || node.address || '') : '';
  }
  return `#${node.id}`;
}

function applyClusterModeIfNeeded() {
  if (state.activeView !== 'dots') return;
  if (!state.clusterMode) {
    releaseClusterMode();
    return;
  }
  applyClusterPacking('owner');
}

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

function renderTreeView(targetId) {
  if (!state.graph) return;
  useTokenDataset();
  state.highlighted = null;
  state.graph.nodeThreeObject(node => buildSprite(node));
  state.graph.nodeThreeObjectExtend(false);
  state.graph.nodeThreeObject(node => buildSprite(node));
  state.colorMode = 'tree';
  toggleControl('time', false);
  toggleControl('edges', false);
  const focusId = Number.isFinite(Number(targetId)) ? Number(targetId) : state.selectedId ?? state.nodes[0]?.id ?? null;
  if (!Number.isFinite(focusId) || !state.nodeMap.has(focusId)) {
    state.graph.graphData({ nodes: [], links: [] });
    return;
  }
  const sub = lineageGraph(focusId);
  if (!sub || !sub.nodeMap.size) return;
  state.selectedId = focusId;
  state.lastTreeRoot = focusId;
  state.treeNodes = sub.nodeMap;
  state.viewNodes = sub.nodeMap;

  const baseRadius = Math.max(220, sub.nodeMap.size * 18);
  const treeRoot = hierarchy(buildTreeHierarchy(sub.rootId, sub.parentMap, sub.nodeMap));
  d3tree().size([Math.PI * 2, baseRadius])(treeRoot);

  treeRoot.descendants().forEach(node => {
    const clone = node.data.__node;
    if (!clone) return;
    const angle = node.x;
    const radius = node.y;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    clone.x = x;
    clone.y = y;
    clone.z = 0;
    clone.fx = x;
    clone.fy = y;
    clone.fz = 0;
  });

  state.graph.d3VelocityDecay(1);
  if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(0);
  state.graph.graphData({ nodes: Array.from(sub.nodeMap.values()), links: sub.links });
  state.graph.linkColor(linkColor);
  state.graph.linkOpacity(() => 0.9);
  state.graph.linkWidth(linkWidth);
  if (typeof state.graph.linkDirectionalParticles === 'function') state.graph.linkDirectionalParticles(linkParticles);
  if (typeof state.graph.linkDirectionalParticleWidth === 'function') state.graph.linkDirectionalParticleWidth(linkParticleWidth);
  if (typeof state.graph.linkLineDash === 'function') state.graph.linkLineDash(linkDash);
  applyLinkStylesForView();
  updateNodeStyles();
  updateSidebar(focusId);
  try { state.graph.refresh(); } catch {}
  try { if (typeof state.graph.centerAt === 'function') state.graph.centerAt(0, 0, 0, 600); } catch {}
  try { if (typeof state.graph.zoom === 'function') state.graph.zoom(5, 600); } catch {}
  scheduleZoomToFit();
}

function lineageGraph(rootId, depthLimit = 4) {
  if (!Number.isFinite(rootId) || !state.nodeMap.has(rootId)) return null;
  const visited = new Set([rootId]);
  const queue = [{ id: rootId, depth: 0 }];
  const nodeMap = new Map();
  const parentMap = new Map();
  const links = [];

  const rootClone = cloneNodeForView(state.nodeMap.get(rootId), 'root');
  nodeMap.set(rootId, rootClone);

  const adjacency = buildAdjacencyIndex();

  while (queue.length) {
    const { id, depth } = queue.shift();
    const connections = adjacency.get(id) || [];
    for (const { neighbor, edge, dir } of connections) {
      if (!Number.isFinite(neighbor) || neighbor === id) continue;
      if (!state.nodeMap.has(neighbor)) continue;
      if (parentMap.get(id) === neighbor) continue;
      if (visited.has(neighbor)) continue;
      const stage = stageFromEdge(edge, dir === 'in' ? 'branch' : 'branch');
      if (!nodeMap.has(neighbor)) {
        const clone = cloneNodeForView(state.nodeMap.get(neighbor), stage);
        nodeMap.set(neighbor, clone);
        parentMap.set(neighbor, id);
      }
      visited.add(neighbor);
      const key = `${id}->${neighbor}`;
      if (!links.some(link => `${link.source}->${link.target}` === key)) {
        links.push({
          source: id,
          target: neighbor,
          kind: (edge?.kind || edge?.type || 'transfer').toLowerCase(),
          weight: edge?.weight ?? 1,
          ts: edge?.ts ?? edge?.timestamp ?? null
        });
      }
      if (depth + 1 < depthLimit) {
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  return { nodeMap, links, parentMap, rootId };
}

function buildTreeHierarchy(rootId, parentMap, nodeMap) {
  const build = (id) => {
    const children = [];
    parentMap.forEach((parent, child) => {
      if (parent === id) children.push(build(child));
    });
    return { id, __node: nodeMap.get(id), children };
  };
  return build(rootId);
}

function cloneNodeForView(source, stage) {
  if (!source) return null;
  const color = stageColor(stage);
  return {
    ...source,
    x: source.homeX ?? source.x ?? 0,
    y: source.homeY ?? source.y ?? 0,
    z: 0,
    fx: undefined,
    fy: undefined,
    fz: undefined,
    stage,
    baseColor: color.slice(),
    displayColor: color.slice(),
    baseSize: stage === 'root' ? 26 : 18,
    displaySize: stage === 'root' ? 26 : 18
  };
}

function stageColor(stage) {
  const key = String(stage || '').toLowerCase();
  if (key === 'root') return [255, 255, 255, 255];
  if (key === 'mint') return parseCssColor('#4c9aff', 1) || [76, 154, 255, 255];
  if (key === 'buy') return CSS_COLORS.accent.slice();
  if (key === 'sell' || key === 'sale') return parseCssColor('#ff9f43', 1) || [255, 159, 67, 255];
  if (key === 'branch') return rgbaMultiply(CSS_COLORS.accent, 0.7);
  return CSS_COLORS.nodeFill.slice();
}

function stageFromEdge(edge, fallback) {
  const raw = String(edge?.kind || edge?.type || '').toLowerCase();
  if (raw === 'mint') return 'mint';
  if (raw === 'buy') return 'buy';
  if (raw === 'sell' || raw === 'sale') return 'sell';
  return fallback || 'branch';
}

function buildAdjacencyIndex() {
  const adjacency = new Map();
  const sources = [
    state.rawEdges.sales,
    state.rawEdges.transfers,
    state.rawEdges.mints,
    state.rawEdges.mixed,
    state.rawEdges.ownership
  ];
  sources.forEach(list => {
    list.forEach(edge => {
      const source = Number(edge?.source);
      const target = Number(edge?.target);
      if (!Number.isFinite(source) || !Number.isFinite(target)) return;
      if (!adjacency.has(source)) adjacency.set(source, []);
      adjacency.get(source).push({ neighbor: target, edge, dir: 'out' });
      if (!adjacency.has(target)) adjacency.set(target, []);
      adjacency.get(target).push({ neighbor: source, edge, dir: 'in' });
    });
  });
  return adjacency;
}

function updateViewControls() {
  const clusterRow = document.getElementById('cluster-mode-row');
  if (clusterRow) clusterRow.hidden = state.activeView !== 'dots';
  const clusterToggle = document.getElementById('dots-cluster-mode');
  if (clusterToggle) clusterToggle.checked = !!state.clusterMode;
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
    const color = computeNodeColor(node, { isSelected, isHovered: false, isHighlighted });
    const material = sprite.material;
    if (material?.color && typeof material.color.setRGB === 'function') {
      const tint = colorToThree(color, 1);
      material.color.setRGB(tint.r, tint.g, tint.b);
      if (!sprite.userData) sprite.userData = {};
      sprite.userData.baseAlpha = color[3] ?? 210;
      sprite.userData.nodeId = node.id;
    }
    const base = node.baseSize || node.displaySize || 20;
    const scale = base * (isSelected ? 1.25 : 1);
    if (sprite.scale?.set) sprite.scale.set(scale, scale, scale);
    if (material) material.opacity = 1;
  });
  try { state.graph.refresh(); } catch {}
}

function focusNode(id) {
  if (state.activeView === 'tree') {
    renderTreeView(id);
    return;
  }
  const node = (state.viewNodes && state.viewNodes.get(id)) || state.nodeMap.get(id);
  if (!node) return;
  state.selectedId = id;
  if (state.activeView === 'dots' || state.activeView === 'flow') {
    const neighbors = state.ownerTopNeighbors.get(id) || [];
    state.highlighted = neighbors.length ? new Set([id, ...neighbors]) : new Set([id]);
  } else {
    state.highlighted = null;
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
    const owner = state.ownerNodeMap.get(id);
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
  setFieldText('sb-owner', owner.address || '—');
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

  const clusterToggle = document.getElementById('dots-cluster-mode');
  if (clusterToggle && !clusterToggle.dataset.threeBound) {
    clusterToggle.dataset.threeBound = '1';
    clusterToggle.checked = !!state.clusterMode;
    clusterToggle.addEventListener('change', () => {
      state.clusterMode = !!clusterToggle.checked;
      if (state.activeView === 'dots') renderCurrentView();
    });
  }

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
        if (state.activeView === 'tree') renderTreeView(id);
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
  if (name !== 'dots') releaseClusterMode();
  if (name !== 'tree') {
    state.treeNodes.clear();
    state.viewNodes = new Map(state.nodeMap);
    if (state.graph) {
      state.graph.d3VelocityDecay(DEFAULT_DECAY);
      state.graph.d3ReheatSimulation();
      if (typeof state.graph.cooldownTicks === 'function') state.graph.cooldownTicks(300);
    }
  }
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
        if (!Number.isFinite(Number(id))) return;
        state.selectedId = Number(id);
        updateNodeStyles();
        focusNode(Number(id));
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
