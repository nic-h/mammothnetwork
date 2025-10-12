import * as THREE from 'three';

function normalizeAddress(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function ensureNode(map, id, level) {
  if (!map.has(id)) {
    map.set(id, { id, level });
  } else if (map.get(id).level > level) {
    map.get(id).level = level;
  }
}

export async function buildTopdownTree(rootAddress, {
  depth = 2,
  minTrades = 1,
  edgesLimit = 500
} = {}) {
  const root = normalizeAddress(rootAddress);
  if (!root) return { nodes: [], links: [] };
  const response = await fetch(`/api/transfer-edges?limit=${edgesLimit}&nodes=10000`);
  const rows = await response.json();
  const adjacency = new Map();
  for (const edge of Array.isArray(rows) ? rows : []) {
    const from = normalizeAddress(edge.from_addr || edge.a);
    const to = normalizeAddress(edge.to_addr || edge.b);
    const count = Number(edge.sales_count ?? edge.count ?? 0) || 0;
    if (!from || !to || count < minTrades) continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({
      source: from,
      target: to,
      count,
      recent: Number(edge.sales_count_30d ?? 0) || 0,
      totalTrades: Number(edge.total_trades ?? count) || count,
      lastTs: Number(edge.last_ts ?? 0) || 0
    });
  }

  const nodes = new Map();
  const links = [];
  ensureNode(nodes, root, 0);
  let frontier = [root];
  for (let level = 0; level < depth; level++) {
    const next = [];
    for (const current of frontier) {
      const edges = adjacency.get(current) || [];
      for (const edge of edges) {
        ensureNode(nodes, edge.target, level + 1);
        links.push({ ...edge });
        if (!next.includes(edge.target)) next.push(edge.target);
      }
    }
    frontier = next;
  }

  const metrics = new Map();
  nodes.forEach((_value, key) => {
    metrics.set(key, { trades: 0, volume: 0 });
  });

  links.forEach(link => {
    const count = Number(link.count || 0) || 0;
    const vol = Number(link.totalTrades || 0) || 0;
    const src = metrics.get(link.source);
    const dst = metrics.get(link.target);
    if (src) { src.trades += count; src.volume += vol; }
    if (dst) { dst.trades += count; dst.volume += vol; }
  });

  const dataNodes = Array.from(nodes.entries()).map(([id, value]) => ({
    id,
    level: value.level,
    trades: metrics.get(id)?.trades || 0,
    volume: metrics.get(id)?.volume || 0
  }));

  return {
    nodes: dataNodes,
    links
  };
}

export function attachTopdownTree(graph, data, {
  levelDistance = 90,
  radiusFn = node => Math.max(4, Math.sqrt(node.trades || 1)),
  onHover,
  onClick
} = {}) {
  graph
    .graphData({
      nodes: data.nodes,
      links: data.links.map(link => ({
        source: link.source,
        target: link.target,
        count: link.count,
        recent: link.recent,
        totalTrades: link.totalTrades,
        lastTs: link.lastTs
      }))
    })
    .dagMode('td')
    .dagLevelDistance(levelDistance)
    .cooldownTicks(0)
    .d3AlphaDecay(1);

  if (typeof onHover === 'function') {
    graph.onNodeHover(node => onHover(node, data));
  }
  if (typeof onClick === 'function') {
    graph.onNodeClick(node => onClick(node, data));
  }

  graph.linkDirectionalParticles(link => Math.min(8, Math.ceil((link.count || 0) / 2)));

  graph.nodeThreeObject(node => {
    const radius = radiusFn(node);
    const container = new THREE.Group();
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius + 0.8, radius + 1.4, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 1, transparent: true })
    );
    container.add(fill);
    container.add(ring);
    return container;
  });
}

export function highlightBranch(graph, focusNode, data) {
  const highlightIds = new Set();
  if (focusNode) {
    const nodeById = new Map(data.nodes.map(n => [n.id, n]));
    let current = focusNode;
    highlightIds.add(current.id || current);
    while (current && current.level > 0) {
      const parentLink = data.links.find(link => {
        const targetId = link.target.id || link.target;
        return targetId === (current.id || current);
      });
      if (!parentLink) break;
      const parentId = parentLink.source.id || parentLink.source;
      highlightIds.add(parentId);
      current = nodeById.get(parentId);
      if (!current) break;
    }
  }

  const colorHighlighted = 'rgba(255,255,255,0.95)';
  const colorDim = 'rgba(255,255,255,0.18)';

  graph
    .linkColor(link => {
      const sourceId = link.source.id || link.source;
      const targetId = link.target.id || link.target;
      return highlightIds.has(sourceId) && highlightIds.has(targetId) ? colorHighlighted : colorDim;
    })
    .nodeOpacity(node => !focusNode || highlightIds.has(node.id) ? 1 : 0.25);
}
