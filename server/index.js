import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import zlibCompression from 'compression';
import { openDatabase, runMigrations } from './db.js';
import { TTLCache } from './cache.js';
import { makeEtag } from './etag.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

app.use(morgan('tiny'));
app.use(zlibCompression());
app.use(express.json({ limit: '2mb' }));

// Serve frontend and vendor modules
// Static
app.use('/vendor', express.static(path.join(ROOT, 'node_modules')));
app.use('/lib', express.static(path.join(ROOT, 'node_modules', 'pixi.js', 'dist')));
// Serve images if present (local data folder or mounted disk)
const localImages = path.join(ROOT, 'data', 'images');
const diskImages = '/data/images';
if (fs.existsSync(localImages)) app.use('/images', express.static(localImages, { maxAge: '365d', immutable: true }));
if (fs.existsSync(diskImages)) app.use('/images', express.static(diskImages, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public'), { fallthrough: true }));

// DB
const { db, dbPath } = openDatabase(ROOT);
const haveDb = !!db;
if (haveDb) {
  runMigrations(db);
  console.log(`Connected to SQLite at ${dbPath}`);
} else {
  console.warn(`SQLite DB not found at ${path.join(ROOT, 'data', 'mammoths.db')} (set DATABASE_PATH to override). Running in fallback demo mode.`);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Utility: map id->color in black/white/green palette
function idToColor(id) {
  // cycle green hues; base bright green with slight variation
  const g = 0xB0 + (id * 23) % 0x4F; // 176..255
  const r = (id * 17) % 16; // very low red
  const b = (id * 11) % 16; // very low blue
  return (r << 16) | (g << 8) | b;
}

// Fallback demo graph generator (fast)
function generateFallbackGraph({ nodes = 10000, edges = 20000, seed = 42 }) {
  const nodesArr = new Array(nodes);
  for (let i = 0; i < nodes; i++) nodesArr[i] = { id: i + 1, color: idToColor(i + 1) };

  // Connect nodes with a few random clusters to simulate owners/traits
  const edgesArr = [];
  const rng = mulberry32(seed);
  const clusterCount = 50;
  const clusters = new Array(clusterCount).fill(0).map(() => Math.floor(rng() * nodes));
  for (let c = 0; c < clusterCount; c++) {
    const center = clusters[c];
    const size = 80 + Math.floor(rng() * 220);
    let last = center;
    for (let k = 0; k < size; k++) {
      const n = Math.floor(rng() * nodes);
      if (n === last) continue;
      edgesArr.push([last + 1, n + 1, 1]);
      last = n;
      if (edgesArr.length >= edges) break;
    }
    if (edgesArr.length >= edges) break;
  }
  return { nodes: nodesArr, edges: edgesArr, meta: { mode: 'demo' } };
}

// PRNG for deterministic fallback
function mulberry32(a) {
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Attempt to derive graph from DB; keep edges bounded
function generateGraphFromDb({ mode = 'holders', nodes = 10000, edges = 20000 }) {
  if (!haveDb || !db) return generateFallbackGraph({ nodes, edges });

  // Try to infer likely schema; if anything fails, fallback demo
  try {
    // Detect token table and count
    const tokenTable = detectTokenTable();
    const tokenCount = tokenTable ? db.prepare(`SELECT COUNT(1) as c FROM ${tokenTable}`).get().c : 0;
    if (!tokenCount || tokenCount < 100) return generateFallbackGraph({ nodes, edges });
    const N = clamp(tokenCount, 1, nodes);
    const nodesArr = new Array(N);
    for (let i = 0; i < N; i++) nodesArr[i] = { id: i + 1, color: idToColor(i + 1) };

    // Mode-specific edge derivation
    let edgesArr = [];
    if (mode === 'holders') {
      edgesArr = buildEdgesFromHolders(tokenTable, N, edges);
    } else if (mode === 'transfers') {
      edgesArr = buildEdgesFromTransfers(tokenTable, N, edges);
    } else if (mode === 'traits') {
      edgesArr = buildEdgesFromTraits(tokenTable, N, edges);
    } else {
      edgesArr = buildEdgesFromHolders(tokenTable, N, edges);
    }
    return { nodes: nodesArr, edges: edgesArr, meta: { mode, source: 'sqlite' } };
  } catch (e) {
    console.warn('DB graph generation failed; using fallback. Error:', e.message);
    return generateFallbackGraph({ nodes, edges });
  }
}

function detectTokenTable() {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map(r => r.name.toLowerCase());
  // Common possibilities
  const candidates = ['tokens', 'token', 'nfts', 'assets', 'items'];
  const table = names.find(n => candidates.includes(n));
  return table || null;
}

function buildEdgesFromHolders(tokenTable, N, maxEdges) {
  // Try to find holders table with owner info
  let ownerTable = null;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  for (const n of ['holders', 'ownership', 'owners']) if (names.includes(n)) { ownerTable = n; break; }
  if (!ownerTable) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  // Attempt to find columns
  const pragma = db.prepare(`PRAGMA table_info(${ownerTable})`).all();
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c));
  const ownerCol = cols.find(c => ['owner', 'holder', 'address', 'wallet'].includes(c));
  if (!tokenCol || !ownerCol) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  // Build sparse ring edges within each owner’s set to bound edges
  const stmt = db.prepare(`SELECT ${tokenCol} AS token_id, ${ownerCol} AS owner FROM ${ownerTable} WHERE ${tokenCol} <= ? ORDER BY owner`);
  const rows = stmt.all(N);
  const byOwner = new Map();
  for (const r of rows) {
    if (!byOwner.has(r.owner)) byOwner.set(r.owner, []);
    byOwner.get(r.owner).push(r.token_id);
  }
  const edges = [];
  for (const list of byOwner.values()) {
    // connect as a ring with stride to avoid O(k^2)
    list.sort((a,b)=>a-b);
    const stride = Math.max(1, Math.floor(list.length / 6));
    for (let i = 0; i < list.length - stride; i += stride) {
      const a = list[i];
      const b = list[i + stride];
      if (a !== b && a <= N && b <= N) edges.push([a, b, 1]);
      if (edges.length >= maxEdges) return edges;
    }
  }
  return edges;
}

function buildEdgesFromTransfers(tokenTable, N, maxEdges) {
  let xferTable = null;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  for (const n of ['transfers', 'sales', 'tx', 'events']) if (names.includes(n)) { xferTable = n; break; }
  if (!xferTable) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  const pragma = db.prepare(`PRAGMA table_info(${xferTable})`).all();
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c));
  const fromCol = cols.find(c => ['from', 'from_address', 'seller'].includes(c));
  const toCol = cols.find(c => ['to', 'to_address', 'buyer'].includes(c));
  const timeCol = cols.find(c => ['timestamp', 'block_time', 'time', 'ts'].includes(c));
  if (!tokenCol || !fromCol || !toCol) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  // Build edges by linking sequential transfers of the same token (simple chain)
  const sql = `SELECT ${tokenCol} AS token_id, ${fromCol} AS from_addr, ${toCol} AS to_addr ${timeCol ? (', '+timeCol+' AS t') : ''} FROM ${xferTable} WHERE ${tokenCol} <= ? ORDER BY ${tokenCol} ${timeCol ? ', t' : ''}`;
  const rows = db.prepare(sql).all(N);
  const byToken = new Map();
  for (const r of rows) {
    if (!byToken.has(r.token_id)) byToken.set(r.token_id, []);
    byToken.get(r.token_id).push(r);
  }
  const edges = [];
  for (const list of byToken.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i-1].token_id;
      const b = list[i].token_id;
      if (a !== b && a <= N && b <= N) edges.push([a, b, 1]);
      if (edges.length >= maxEdges) return edges;
    }
  }
  return edges;
}

function buildEdgesFromTraits(tokenTable, N, maxEdges) {
  // Try to find traits table or metadata JSON
  let traitsTable = null;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  for (const n of ['traits', 'attributes', 'metadata']) if (names.includes(n)) { traitsTable = n; break; }
  if (!traitsTable) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  const pragma = db.prepare(`PRAGMA table_info(${traitsTable})`).all();
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c));
  const traitCol = cols.find(c => ['trait', 'attribute', 'name', 'key'].includes(c));
  const valueCol = cols.find(c => ['value', 'val'].includes(c));
  if (!tokenCol || !traitCol || !valueCol) return generateFallbackGraph({ nodes: N, edges: maxEdges }).edges;

  // Connect tokens that share a rare trait (low frequency)
  const rows = db.prepare(`SELECT ${tokenCol} AS token_id, ${traitCol} AS trait, ${valueCol} AS value FROM ${traitsTable} WHERE ${tokenCol} <= ?`).all(N);
  const byPair = new Map(); // trait=value => [token_ids]
  for (const r of rows) {
    const key = `${r.trait}=${r.value}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r.token_id);
  }
  const edges = [];
  for (const list of byPair.values()) {
    if (list.length < 3 || list.length > 40) continue; // focus on moderately rare
    list.sort((a,b)=>a-b);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i+1];
      if (a !== b && a <= N && b <= N) edges.push([a, b, 1]);
      if (edges.length >= maxEdges) return edges;
    }
  }
  return edges;
}

// API: Graph
const memCache = new TTLCache(5 * 60 * 1000);

function cacheKey({ mode, nodes, edges }) {
  return `graph:${mode}:${nodes}:${edges}`;
}

function sendWithCaching(req, res, key, payload) {
  const etag = makeEtag(payload);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    return res.status(304).end();
  }
  res.json(payload);
  // store in memory
  memCache.set(key, payload, etag);
  // store in DB
  if (haveDb) {
    try {
      const up = db.prepare('INSERT INTO graph_cache (key, etag, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET etag=excluded.etag, payload=excluded.payload, updated_at=CURRENT_TIMESTAMP');
      up.run(key, etag, JSON.stringify(payload));
    } catch {}
  }
}

app.get(['/api/graph', '/api/network-graph'], (req, res) => {
  const mode = (req.query.mode || 'holders').toString();
  const nodes = clamp(parseInt(req.query.nodes || '10000', 10), 100, 10000);
  const edges = clamp(parseInt(req.query.edges || '200', 10), 0, 500); // cap at 500
  const key = cacheKey({ mode, nodes, edges });

  // memory cache
  const cached = memCache.get(key);
  if (cached) {
    const etag = cached.etag || makeEtag(cached.value || cached);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    const inm = req.headers['if-none-match'];
    if (inm && inm === etag) return res.status(304).end();
    return res.json(cached.value || cached);
  }

  // DB cache
  if (haveDb) {
    try {
      const row = db.prepare('SELECT etag, payload FROM graph_cache WHERE key=?').get(key);
      if (row && row.payload) {
        const payload = JSON.parse(row.payload);
        res.setHeader('ETag', row.etag || makeEtag(payload));
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
        const inm = req.headers['if-none-match'];
        if (inm && inm === row.etag) return res.status(304).end();
        memCache.set(key, payload, row.etag);
        return res.json(payload);
      }
    } catch {}
  }

  // Build fresh
  const result = generateGraphFromDb({ mode, nodes, edges });
  return sendWithCaching(req, res, key, result);
});

// API: Stats (lightweight)
app.get('/api/stats', (req, res) => {
  if (haveDb && db) {
    try {
      const tokenTable = detectTokenTable();
      const tokenCount = tokenTable ? db.prepare(`SELECT COUNT(1) as c FROM ${tokenTable}`).get().c : null;
      const holdersRow = db.prepare('SELECT holders as h FROM collection_stats WHERE id=1').get?.();
      const holders = holdersRow ? holdersRow.h : null;
      return res.json({ haveDb: true, tokens: tokenCount, holders });
    } catch (e) {
      // fallthrough
    }
  }
  res.json({ haveDb: false, tokens: 10000 });
});

// API: Minimal activity stub (placeholder for Modularium)
app.get('/api/activity', (req, res) => {
  // Keep cheap: return simple rolling window stub; real impl would query cached tables
  const now = Date.now();
  const buckets = [];
  for (let i = 0; i < 24; i++) {
    buckets.push({ t: now - i * 3600_000, count: Math.floor((Math.sin(i/3)+1)*50) });
  }
  res.json({ buckets: buckets.reverse() });
});

// API: Token detail
app.get('/api/token/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const row = db.prepare('SELECT id, owner, name, description, image_local, thumbnail_local, attributes FROM tokens WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: 'db-error' });
  }
});

// API: Wallet holdings
app.get('/api/wallet/:address', (req, res) => {
  const addr = (req.params.address || '').toLowerCase();
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const rows = db.prepare('SELECT id FROM tokens WHERE LOWER(owner)=? ORDER BY id').all(addr);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({ address: addr, tokens: rows.map(r => r.id) });
  } catch (e) {
    return res.status(500).json({ error: 'db-error' });
  }
});

// Health
app.get('/api/health', (req, res) => {
  const status = { ok: true, haveDb, dbPath: haveDb ? dbPath : null };
  res.setHeader('Cache-Control', 'no-store');
  res.json(status);
});

// Fallback to index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Mammoths Network server listening on http://localhost:${PORT}`);
  if (!haveDb) {
    console.log('DB not found; using demo graph. Set DB_PATH to your sqlite file for real data.');
  }
});
