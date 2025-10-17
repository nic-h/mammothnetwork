export function bubbleMapLayout(nodes, {
  groupBy = n => n.segment || n.owner_segment || n.walletType || 'Other',
  radius = n => Math.max(4, Math.sqrt(n.trades || n.flowMetric || 1)),
  padding = 2
} = {}) {
  const canonicalCount = nodes.filter(node => Number.isFinite(node?.layoutX) && Number.isFinite(node?.layoutY)).length;
  nodes.forEach(node => {
    const key = groupBy(node);
    node.groupKey = key;
    node.r = radius(node);
  });
  if (canonicalCount >= Math.max(1, Math.floor(nodes.length * 0.6))) {
    nodes.forEach(node => {
      const x = Number.isFinite(node.layoutX) ? node.layoutX : Number(node.x ?? 0) || 0;
      const y = Number.isFinite(node.layoutY) ? node.layoutY : Number(node.y ?? 0) || 0;
      node.x = x;
      node.y = y;
      node.z = 0;
    });
    resolveCollisions(nodes, {
      iterations: 2,
      cellSize: Math.max(24, 2 * medianRadius(nodes) + padding),
      padding: Math.max(0.8, padding * 0.6)
    });
    return nodes;
  }

  const groups = new Map();
  nodes.forEach(node => {
    const key = node.groupKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });

  const clusters = [];
  groups.forEach((items, key) => {
    const packed = packCircles(items, padding);
    const area = packed.reduce((sum, item) => sum + (item.r + padding) ** 2, 0);
    const radiusApprox = Math.pow(area, 0.5) || 0;
    clusters.push({ key, nodes: packed, radius: radiusApprox });
  });

  clusters.sort((a, b) => b.radius - a.radius);
  const cols = Math.ceil(Math.sqrt(clusters.length));
  const gap = Math.max(160, Math.sqrt(clusters.reduce((sum, c) => sum + c.radius, 0)));

  clusters.forEach((cluster, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const offsetX = col * gap;
    const offsetY = row * gap;
    cluster.nodes.forEach(node => {
      node.x = offsetX + node.x;
      node.y = offsetY + node.y;
      node.z = 0;
    });
  });

  resolveCollisions(nodes, { iterations: 3, cellSize: 2 * medianRadius(nodes) + padding, padding });
  return nodes;
}

function medianRadius(nodes) {
  const radii = nodes.map(n => n.r || 0).filter(Number.isFinite).sort((a, b) => a - b);
  if (!radii.length) return 0;
  const mid = Math.floor(radii.length / 2);
  return radii.length % 2 === 0 ? (radii[mid - 1] + radii[mid]) / 2 : radii[mid];
}

function packCircles(items, padding = 2) {
  const nodes = items.map(item => ({ ...item }));
  nodes.sort((a, b) => (b.r || 0) - (a.r || 0));
  const placed = [];
  nodes.forEach(node => {
    let angle = 0;
    let radius = 0;
    let attempts = 0;
    while (attempts < 1000) {
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (placed.every(other => distanceSquared(x, y, other.x, other.y) >= (node.r + other.r + padding) ** 2)) {
        node.x = x;
        node.y = y;
        placed.push(node);
        break;
      }
      angle += 0.45;
      radius += 0.5;
      attempts++;
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      node.x = 0;
      node.y = 0;
      placed.push(node);
    }
  });
  placed.forEach((node, index) => {
    Object.assign(items[index], node);
  });
  return items;
}

function distanceSquared(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

export function resolveCollisions(nodes, { iterations = 2, cellSize = 32, padding = 2 } = {}) {
  const size = Math.max(8, cellSize);
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map();
    nodes.forEach(node => {
      const cx = Math.floor(node.x / size);
      const cy = Math.floor(node.y / size);
      const key = `${cx}:${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(node);
    });
    nodes.forEach(node => {
      const cx = Math.floor(node.x / size);
      const cy = Math.floor(node.y / size);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(`${gx}:${gy}`);
          if (!bucket) continue;
          bucket.forEach(other => {
            if (node === other) return;
            const minDist = (node.r || 0) + (other.r || 0) + padding;
            let dx = node.x - other.x;
            let dy = node.y - other.y;
            let dist = Math.hypot(dx, dy);
            if (dist === 0) {
              const random = (nodes.indexOf(node) + nodes.indexOf(other)) * 0.61803398875;
              dx = Math.cos(random) * 0.01;
              dy = Math.sin(random) * 0.01;
              dist = Math.hypot(dx, dy);
            }
            if (dist < minDist && dist > 0) {
              const push = (minDist - dist) * 0.5;
              const ux = dx / dist;
              const uy = dy / dist;
              node.x += ux * push;
              node.y += uy * push;
              other.x -= ux * push;
              other.y -= uy * push;
            }
          });
        }
      }
    });
  }
}
