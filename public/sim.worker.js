let N = 0;
let edges = []; // [i, j, w]
let posX, posY, velX, velY, mass;
let running = true;

// Tunables prioritized for stability/perf
let params = {
  repel: 600,        // repulsion strength
  repelRadius: 60,   // influence radius
  spring: 0.02,      // edge spring constant
  springLength: 30,  // natural edge length
  center: 0.005,     // centering force to origin
  damping: 0.85,     // velocity decay
  maxSpeed: 3.5,     // clamp velocity
  stepMs: 16,        // sim step cadence
  sendEveryMs: 33,   // how often to post positions to main
};

let lastSend = 0;
let timer = null;

self.onmessage = (e) => {
  const { type, payload } = e.data;
  if (type === 'init') {
    init(payload);
  } else if (type === 'setGraph') {
    setGraph(payload);
  } else if (type === 'pause') {
    running = false;
  } else if (type === 'resume') {
    running = true;
  } else if (type === 'reset') {
    randomizePositions();
  } else if (type === 'tune') {
    Object.assign(params, payload || {});
  }
};

function init({ nodes, edges: e }) {
  N = nodes;
  edges = e || [];
  allocate();
  randomizePositions();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, params.stepMs);
}

function setGraph({ nodes, edges: e }) {
  N = nodes;
  edges = e || [];
  allocate();
  randomizePositions();
}

function allocate() {
  posX = new Float32Array(N);
  posY = new Float32Array(N);
  velX = new Float32Array(N);
  velY = new Float32Array(N);
  mass = new Float32Array(N);
  for (let i = 0; i < N; i++) mass[i] = 1.0;
}

function randomizePositions() {
  // disc distribution for good start
  for (let i = 0; i < N; i++) {
    const t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 200;
    posX[i] = Math.cos(t) * r;
    posY[i] = Math.sin(t) * r;
    velX[i] = 0;
    velY[i] = 0;
  }
}

// Spatial hash grid
function buildGrid(cellSize) {
  const grid = new Map();
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(posX[i] / cellSize);
    const cy = Math.floor(posY[i] / cellSize);
    const key = (cx << 16) ^ (cy & 0xffff);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
  return grid;
}

function neighbors(grid, cx, cy) {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = ((cx+dx) << 16) ^ ((cy+dy) & 0xffff);
      const arr = grid.get(key);
      if (arr) out.push(arr);
    }
  }
  return out;
}

function tick() {
  if (!running || N === 0) return;
  const cs = params.repelRadius;
  const grid = buildGrid(cs);
  const repelK = params.repel;
  const centerK = params.center;
  const springK = params.spring;
  const L0 = params.springLength;
  const damp = params.damping;
  const vmax = params.maxSpeed;

  // Repulsion (local)
  for (let i = 0; i < N; i++) {
    const xi = posX[i], yi = posY[i];
    const cx = Math.floor(xi / cs), cy = Math.floor(yi / cs);
    const neigh = neighbors(grid, cx, cy);
    let fx = 0, fy = 0;
    for (const arr of neigh) {
      for (let k = 0; k < arr.length; k++) {
        const j = arr[k];
        if (j === i) continue;
        let dx = xi - posX[j];
        let dy = yi - posY[j];
        const d2 = dx*dx + dy*dy;
        if (d2 > 0.001 && d2 < cs*cs) {
          const inv = 1.0 / d2;
          const f = repelK * inv;
          const d = Math.sqrt(d2) + 1e-6;
          dx /= d; dy /= d;
          fx += dx * f;
          fy += dy * f;
        }
      }
    }
    // Centering force
    fx += -xi * centerK;
    fy += -yi * centerK;

    // Integrate velocity (semi-implicit)
    velX[i] = (velX[i] + fx) * damp;
    velY[i] = (velY[i] + fy) * damp;
    // Clamp velocity
    const sp2 = velX[i]*velX[i] + velY[i]*velY[i];
    if (sp2 > vmax*vmax) {
      const s = vmax / Math.sqrt(sp2);
      velX[i] *= s; velY[i] *= s;
    }
  }

  // Springs (edges)
  for (let e = 0; e < edges.length; e++) {
    const [a, b, w] = edges[e];
    const i = a - 1, j = b - 1;
    if (i < 0 || j < 0 || i >= N || j >= N) continue;
    let dx = posX[j] - posX[i];
    let dy = posY[j] - posY[i];
    const d = Math.sqrt(dx*dx + dy*dy) + 1e-6;
    const k = springK * (w || 1);
    const f = k * (d - L0);
    dx /= d; dy /= d;
    const fx = dx * f, fy = dy * f;
    velX[i] += fx; velY[i] += fy;
    velX[j] -= fx; velY[j] -= fy;
  }

  // Integrate positions
  for (let i = 0; i < N; i++) {
    posX[i] += velX[i];
    posY[i] += velY[i];
  }

  const now = Date.now();
  if (now - lastSend >= params.sendEveryMs) {
    lastSend = now;
    // Send by copy to avoid transferring away our buffers
    self.postMessage({ type: 'tick', positions: { x: posX.slice(0), y: posY.slice(0) } }, []);
  }
}

