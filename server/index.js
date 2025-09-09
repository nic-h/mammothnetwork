import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import zlibCompression from 'compression';
import { openDatabase, runMigrations } from './db.js';
import { TTLCache } from './cache.js';
import { makeEtag } from './etag.js';
import { getEthosForAddress } from './ethos.js';

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
// Serve images + thumbnails if present (local data folder or mounted disk)
const localImages = path.join(ROOT, 'data', 'images');
const diskImages = '/data/images';
if (fs.existsSync(localImages)) app.use('/images', express.static(localImages, { maxAge: '365d', immutable: true }));
if (fs.existsSync(diskImages)) app.use('/images', express.static(diskImages, { maxAge: '365d', immutable: true }));
const localThumbs = path.join(ROOT, 'data', 'thumbnails');
const diskThumbs = '/data/thumbnails';
if (fs.existsSync(localThumbs)) app.use('/thumbnails', express.static(localThumbs, { maxAge: '365d', immutable: true }));
if (fs.existsSync(diskThumbs)) app.use('/thumbnails', express.static(diskThumbs, { maxAge: '365d', immutable: true }));
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
    // Build nodes with status colors (frozen/dormant) if columns exist
    let nodesArr = [];
    try {
      const cols = db.prepare(`PRAGMA table_info(${tokenTable})`).all().map(c => c.name.toLowerCase());
      const hasFrozen = cols.includes('frozen');
      const hasDormant = cols.includes('dormant');
      if (hasFrozen || hasDormant) {
        const rows = db.prepare(`SELECT id${hasFrozen ? ', frozen' : ''}${hasDormant ? ', dormant' : ''} FROM ${tokenTable} WHERE id<=? ORDER BY id`).all(N);
        for (const r of rows) {
          const isFrozen = hasFrozen ? !!r.frozen : false;
          const isDormant = hasDormant ? !!r.dormant : false;
          let color = 0x00ff66;
          if (isFrozen) color = 0x4488ff; // blue for frozen
          else if (isDormant) color = 0x666666; // gray for dormant
          else color = idToColor(r.id);
          nodesArr.push({ id: r.id, color, frozen: isFrozen, dormant: isDormant });
        }
      }
    } catch {}
    if (!nodesArr.length) {
      nodesArr = new Array(N);
      for (let i = 0; i < N; i++) nodesArr[i] = { id: i + 1, color: idToColor(i + 1), frozen: false, dormant: false };
    }

    // Mode-specific edge derivation
    let edgesArr = [];
    if (mode === 'holders') {
      edgesArr = buildEdgesFromHolders(tokenTable, N, edges);
    } else if (mode === 'transfers') {
      edgesArr = buildEdgesFromTransfers(tokenTable, N, edges);
    } else if (mode === 'traits') {
      edgesArr = buildEdgesFromTraits(tokenTable, N, edges);
    } else if (mode === 'wallets') {
      edgesArr = buildEdgesFromWallets(N, edges);
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
  // Prefer tokens table owner column; fall back to a holders table if present
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  let rows = [];
  if (tokenTable) {
    rows = db.prepare(`SELECT id AS token_id, owner FROM ${tokenTable} WHERE id <= ? AND owner IS NOT NULL AND owner<>'' ORDER BY owner`).all(N);
  } else {
    let ownerTable = null;
    for (const n of ['holders', 'ownership', 'owners']) if (names.includes(n)) { ownerTable = n; break; }
    if (ownerTable) {
      const pragma = db.prepare(`PRAGMA table_info(${ownerTable})`).all();
      const cols = pragma.map(c => c.name.toLowerCase());
      const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c)) || 'token_id';
      const ownerCol = cols.find(c => ['owner', 'holder', 'address', 'wallet'].includes(c)) || 'owner';
      rows = db.prepare(`SELECT ${tokenCol} AS token_id, ${ownerCol} AS owner FROM ${ownerTable} WHERE ${tokenCol} <= ? ORDER BY owner`).all(N);
    }
  }
  if (!rows.length) return [];
  const byOwner = new Map();
  for (const r of rows) {
    const o = (r.owner || '').toLowerCase();
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(r.token_id);
  }
  const edges = [];
  for (const list of byOwner.values()) {
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

function getOwnerTokens(dbRef, owner, N) {
  return dbRef.prepare('SELECT id FROM tokens WHERE LOWER(owner)=? AND id<=? ORDER BY id').all(owner, N).map(r => r.id);
}

function degreeLimitedPush(edges, a, b, degree, cap) {
  if (a === b) return false;
  if ((degree.get(a) || 0) >= cap) return false;
  if ((degree.get(b) || 0) >= cap) return false;
  edges.push([a, b, 1]);
  degree.set(a, (degree.get(a) || 0) + 1);
  degree.set(b, (degree.get(b) || 0) + 1);
  return true;
}

function buildEdgesFromWallets(N, maxEdges) {
  const degree = new Map();
  const edges = [];

  // Same-owner clusters (top owners by holdings)
  const topOwners = db.prepare(`SELECT LOWER(owner) as o, COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>'' AND id<=? GROUP BY LOWER(owner) ORDER BY c DESC LIMIT 200`).all(N);
  for (const row of topOwners) {
    const list = getOwnerTokens(db, row.o, N);
    if (list.length < 2) continue;
    const center = list[0];
    const step = Math.max(1, Math.floor(list.length / 8));
    for (let i = 1; i < list.length; i += step) {
      if (degreeLimitedPush(edges, center, list[i], degree, 6) && edges.length >= maxEdges) return edges;
    }
    if (edges.length >= maxEdges) return edges;
  }

  if (edges.length >= maxEdges) return edges;

  // Wallet-to-wallet trades
  const pairs = db.prepare(`
    SELECT LOWER(from_addr) AS a, LOWER(to_addr) AS b, COUNT(1) AS cnt
    FROM transfers
    WHERE from_addr IS NOT NULL AND from_addr<>'' AND to_addr IS NOT NULL AND to_addr<>'' AND token_id<=?
    GROUP BY a,b
    HAVING cnt >= 2
    ORDER BY cnt DESC
    LIMIT 1000
  `).all(N);
  for (const p of pairs) {
    const aTokens = getOwnerTokens(db, p.a, N);
    const bTokens = getOwnerTokens(db, p.b, N);
    if (!aTokens.length || !bTokens.length) continue;
    degreeLimitedPush(edges, aTokens[0], bTokens[0], degree, 6);
    if (edges.length >= maxEdges) break;
  }
  return edges;
}

// API: Graph
const memCache = new TTLCache(5 * 60 * 1000);
// Periodically purge expired cache entries
setInterval(() => memCache.purge && memCache.purge(), 60 * 1000).unref?.();

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
  if (!haveDb || !db) return res.json({ buckets: [] });
  const interval = (req.query.interval || 'day').toString();
  const valid = interval === 'day' || interval === 'hour';
  const sec = interval === 'hour' ? 3600 : 86400;
  try {
    const rows = db.prepare('SELECT (timestamp / ?) * ? AS bucket, COUNT(1) AS count, SUM(COALESCE(price,0)) AS volume FROM transfers GROUP BY bucket ORDER BY bucket').all(sec, sec);
    const buckets = rows.map(r => ({ t: r.bucket * 1000, count: r.count, volume: r.volume }));
    res.json({ buckets });
  } catch (e) {
    res.json({ buckets: [] });
  }
});

app.get('/api/heatmap', (req, res) => {
  if (!haveDb || !db) return res.json({ grid: [] });
  // 7x24 grid: dayOfWeek (0-6), hour (0-23)
  try {
    const rows = db.prepare("SELECT CAST(strftime('%w', timestamp, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) AS hr, COUNT(1) AS count, SUM(COALESCE(price,0)) AS volume FROM transfers GROUP BY dow, hr").all();
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ count: 0, volume: 0 })));
    for (const r of rows) {
      const d = Number(r.dow); const h = Number(r.hr);
      grid[d][h] = { count: r.count, volume: r.volume };
    }
    res.json({ grid });
  } catch (e) {
    res.json({ grid: [] });
  }
});

// API: Preset data for layouts (compact arrays for performance)
app.get('/api/preset-data', (req, res) => {
  if (!haveDb || !db) return res.json({ owners: [], ownerIndex: [], ownerEthos: [], tokenLastActivity: [], tokenPrice: [], traitKeys: [], tokenTraitKey: [], rarity: [] });
  const N = parseInt(req.query.nodes || '10000', 10) || 10000;
  try {
    const rows = db.prepare("SELECT id, LOWER(COALESCE(owner,'')) AS owner FROM tokens WHERE id<=? ORDER BY id").all(N);
    const owners = [];
    const ownerMap = new Map();
    const ownerIndex = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i].owner || '';
      if (!ownerMap.has(o)) { ownerMap.set(o, owners.length); owners.push(o); }
      ownerIndex[i] = ownerMap.get(o);
    }
    // ownerEthos aligned with owners array
    const ownerEthos = new Array(owners.length).fill(null);
    const ethosRows = db.prepare('SELECT address, ethos_score FROM wallet_metadata WHERE ethos_score IS NOT NULL').all();
    const ethosMap = new Map(ethosRows.map(r => [r.address?.toLowerCase?.() || '', r.ethos_score]));
    for (let i = 0; i < owners.length; i++) ownerEthos[i] = ethosMap.get(owners[i]) ?? null;

    // last activity per token
    const lastRows = db.prepare('SELECT token_id AS id, MAX(timestamp) AS t FROM transfers WHERE token_id<=? GROUP BY token_id').all(N);
    const lastMap = new Map(lastRows.map(r => [r.id, r.t || 0]));
    const tokenLastActivity = rows.map(r => lastMap.get(r.id) || 0);

    // price per token (last known)
    let tokenPrice = rows.map(_ => null);
    try {
      const priceRows = db.prepare('SELECT token_id AS id, MAX(COALESCE(price,0)) AS p FROM transfers WHERE token_id<=? GROUP BY token_id').all(N);
      const pm = new Map(priceRows.map(r => [r.id, r.p || null]));
      tokenPrice = rows.map(r => pm.get(r.id) ?? null);
    } catch {}

    // trait frequencies and token dominant traitKey
    const traitCountRows = db.prepare("SELECT trait_type||':'||trait_value AS k, COUNT(1) AS c FROM attributes WHERE token_id<=? GROUP BY k").all(N);
    const freq = new Map(traitCountRows.map(r => [r.k, r.c]));
    const tokenAttrs = db.prepare('SELECT token_id, trait_type, trait_value FROM attributes WHERE token_id<=?').all(N);
    const tokenTraitKey = new Array(rows.length).fill(-1);
    const traitKeys = [];
    const traitKeyMap = new Map();
    // build rarest attribute per token
    const perToken = new Map();
    for (const a of tokenAttrs) {
      const k = `${a.trait_type}:${a.trait_value}`;
      const c = freq.get(k) || 1;
      const cur = perToken.get(a.token_id);
      if (!cur || c < cur.c) perToken.set(a.token_id, { k, c });
    }
    for (let i = 0; i < rows.length; i++) {
      const rec = perToken.get(rows[i].id);
      if (!rec) { tokenTraitKey[i] = -1; continue; }
      if (!traitKeyMap.has(rec.k)) { traitKeyMap.set(rec.k, traitKeys.length); traitKeys.push(rec.k); }
      tokenTraitKey[i] = traitKeyMap.get(rec.k);
    }

    // rarity score (approx): sum of -log(freq/total) across traits, normalized 0..1
    const totalAttrs = tokenAttrs.length || 1;
    const rarityRaw = new Array(rows.length).fill(0);
    const sumMap = new Map();
    for (const a of tokenAttrs) {
      const k = `${a.trait_type}:${a.trait_value}`;
      const c = freq.get(k) || 1;
      const s = Math.max(0, Math.log(totalAttrs / c));
      sumMap.set(a.token_id, (sumMap.get(a.token_id) || 0) + s);
    }
    let maxS = 1e-6; let minS = 1e9;
    for (let i = 0; i < rows.length; i++) { const s = sumMap.get(rows[i].id) || 0; rarityRaw[i] = s; maxS = Math.max(maxS, s); minS = Math.min(minS, s); }
    const rarity = rarityRaw.map(s => (s - minS) / (maxS - minS + 1e-9));

    res.json({ owners, ownerIndex, ownerEthos, tokenLastActivity, tokenPrice, traitKeys, tokenTraitKey, rarity });
  } catch (e) {
    res.json({ owners: [], ownerIndex: [], ownerEthos: [], tokenLastActivity: [], tokenPrice: [], traitKeys: [], tokenTraitKey: [], rarity: [] });
  }
});

// API: traits list and tokens by trait
app.get('/api/traits', (req, res) => {
  if (!haveDb || !db) return res.json({ traits: [] });
  try {
    // Try attributes table first
    let rows = [];
    try {
      rows = db.prepare('SELECT trait_type AS type, trait_value AS value, COUNT(1) AS count FROM attributes GROUP BY trait_type, trait_value ORDER BY type, value').all();
    } catch {}
    let traits = [];
    if (rows && rows.length) {
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r.type)) map.set(r.type, []);
        map.get(r.type).push({ value: r.value, count: r.count });
      }
      traits = Array.from(map.entries()).map(([type, values]) => ({ type, values }));
    } else {
      // Fallback: parse tokens.attributes JSON
      const tokenTable = detectTokenTable() || 'tokens';
      const trows = db.prepare(`SELECT attributes FROM ${tokenTable} WHERE attributes IS NOT NULL AND LENGTH(attributes)>2 LIMIT 5000`).all();
      const freq = new Map(); // key: type:value => count
      for (const tr of trows) {
        try {
          const arr = JSON.parse(tr.attributes);
          if (Array.isArray(arr)) {
            for (const a of arr) {
              const type = String(a.trait_type || a.type || '').trim();
              const value = String(a.value || '').trim();
              if (!type || !value) continue;
              const k = `${type}:${value}`;
              freq.set(k, (freq.get(k) || 0) + 1);
            }
          }
        } catch {}
      }
      const byType = new Map();
      for (const [k, c] of freq.entries()) {
        const i = k.indexOf(':');
        const type = k.slice(0, i);
        const value = k.slice(i + 1);
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push({ value, count: c });
      }
      traits = Array.from(byType.entries()).map(([type, values]) => ({ type, values }));
    }
    res.json({ traits });
  } catch (e) {
    res.json({ traits: [] });
  }
});

app.get('/api/trait-tokens', (req, res) => {
  if (!haveDb || !db) return res.json({ tokens: [] });
  const type = String(req.query.type || '').trim();
  const value = String(req.query.value || '').trim();
  if (!type || !value) return res.status(400).json({ tokens: [] });
  try {
    const rows = db.prepare('SELECT token_id AS id FROM attributes WHERE trait_type=? AND trait_value=?').all(type, value);
    res.json({ tokens: rows.map(r => r.id) });
  } catch (e) {
    res.json({ tokens: [] });
  }
});

// API: Token detail
app.get('/api/token/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const row = db.prepare('SELECT id, owner, name, description, image_local, thumbnail_local, attributes, frozen, dormant, last_activity FROM tokens WHERE id=?').get(id);
    if (!row) return res.status(404).json({ error: 'not-found' });
    // traits from attributes table (authoritative)
    let traits = [];
    try { traits = db.prepare('SELECT trait_type, trait_value FROM attributes WHERE token_id=?').all(id); } catch {}
    // parse attributes JSON fallback
    if ((!traits || traits.length === 0) && row.attributes) {
      try { const j = JSON.parse(row.attributes); if (Array.isArray(j)) traits = j.map(a=>({ trait_type: a.trait_type||a.type||'', trait_value: a.value||'' })); } catch {}
    }
    const out = {
      id: row.id,
      owner: row.owner,
      name: row.name,
      description: row.description,
      image_local: row.image_local,
      thumbnail_local: row.thumbnail_local,
      traits,
      frozen: row.frozen || 0,
      dormant: row.dormant || 0,
      last_activity: row.last_activity || null,
    };
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'db-error' });
  }
});

// Token transfers (history)
app.get('/api/token/:id/transfers', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const rows = db.prepare('SELECT from_addr, to_addr, timestamp, price FROM transfers WHERE token_id=? ORDER BY timestamp DESC LIMIT 100').all(id);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({ transfers: rows });
  } catch (e) {
    return res.status(500).json({ error: 'db-error' });
  }
});

// Similar tokens by rarest trait
app.get('/api/token/:id/similar', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const attrs = db.prepare('SELECT trait_type, trait_value FROM attributes WHERE token_id=?').all(id);
    if (!attrs || !attrs.length) return res.json({ similar: [] });
    const freq = new Map(db.prepare('SELECT trait_type||":"||trait_value AS k, COUNT(1) AS c FROM attributes GROUP BY k').all().map(r=>[r.k, r.c]));
    let rare = null;
    for (const a of attrs) {
      const k = `${a.trait_type}:${a.trait_value}`;
      const c = freq.get(k) || 1e9;
      if (!rare || c < rare.c) rare = { k, c, trait_type: a.trait_type, trait_value: a.trait_value };
    }
    if (!rare) return res.json({ similar: [] });
    const rows = db.prepare('SELECT token_id AS id FROM attributes WHERE trait_type=? AND trait_value=? AND token_id<>? LIMIT 30').all(rare.trait_type, rare.trait_value, id);
    return res.json({ trait: { type: rare.trait_type, value: rare.trait_value, count: rare.c }, similar: rows.map(r=>r.id) });
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

// API: Wallet metadata
app.get('/api/wallet/:address/meta', (req, res) => {
  const addr = (req.params.address || '').toLowerCase();
  if (!haveDb || !db) return res.status(404).json({ error: 'no-db' });
  try {
    const meta = db.prepare('SELECT address, ens_name, ethos_score, ethos_credibility, social_verified, total_holdings, first_acquired, last_activity, trade_count, updated_at FROM wallet_metadata WHERE address=?').get(addr) || null;
    const now = Math.floor(Date.now() / 1000);
    const stale = !meta || !meta.updated_at || (Date.parse(meta.updated_at)/1000 < now - 7*24*3600);
    if (stale) {
      refreshEthos(addr).catch(()=>{});
    }
    if (meta) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(meta);
    }
    // compute lightweight fallback
    const holdings = db.prepare('SELECT COUNT(1) c FROM tokens WHERE LOWER(owner)=?').get(addr).c;
    const first = db.prepare('SELECT MIN(timestamp) t FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?').get(addr, addr).t || null;
    const last = db.prepare('SELECT MAX(timestamp) t FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?').get(addr, addr).t || null;
    const trades = db.prepare('SELECT COUNT(1) c FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?').get(addr, addr).c;
    return res.json({ address: addr, ens_name: null, ethos_score: null, ethos_credibility: null, social_verified: null, total_holdings: holdings, first_acquired: first, last_activity: last, trade_count: trades });
  } catch (e) {
    return res.status(500).json({ error: 'db-error' });
  }
});

async function refreshEthos(addr) {
  const ETHOS_API = process.env.ETHOS_API || 'https://api.ethos.network';
  const headers = { 'accept': 'application/json', 'X-Ethos-Client': (process.env.ETHOS_CLIENT || 'mammothnetwork/0.1.0') };
  const [score, user] = await Promise.all([
    fetch(`${ETHOS_API}/api/v2/score/address?address=${addr}`, { headers }).then(r => r.ok ? r.json() : null).catch(()=>null),
    fetch(`${ETHOS_API}/api/v2/user/by/address/${addr}`, { headers }).then(r => r.ok ? r.json() : null).catch(()=>null),
  ]);
  const ens = user?.username || user?.displayName || null;
  const sc = typeof score?.score === 'number' ? score.score : (typeof user?.score === 'number' ? user.score : null);
  const level = (score?.level || '').toLowerCase();
  const rank = ['untrusted','questionable','neutral','known','established','reputable','exemplary','distinguished','revered','renowned'].indexOf(level);
  const cred = rank >= 0 ? rank : null;
  const up = db.prepare(`
    INSERT INTO wallet_metadata (address, ens_name, ethos_score, ethos_credibility, social_verified, total_holdings, first_acquired, last_activity, trade_count, updated_at)
    VALUES (?, COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL), NULL,
      (SELECT COUNT(1) FROM tokens WHERE LOWER(owner)=?),
      (SELECT MIN(timestamp) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
      (SELECT MAX(timestamp) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
      (SELECT COUNT(1) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
      CURRENT_TIMESTAMP)
    ON CONFLICT(address) DO UPDATE SET ens_name=COALESCE(excluded.ens_name, wallet_metadata.ens_name), ethos_score=COALESCE(excluded.ethos_score, wallet_metadata.ethos_score), ethos_credibility=COALESCE(excluded.ethos_credibility, wallet_metadata.ethos_credibility), total_holdings=excluded.total_holdings, first_acquired=excluded.first_acquired, last_activity=excluded.last_activity, trade_count=excluded.trade_count, updated_at=CURRENT_TIMESTAMP
  `);
  up.run(addr, ens, sc, cred, addr, addr, addr, addr, addr, addr, addr);
}

// Ethos profile proxy (v1 search + stats)
app.get('/api/ethos/profile', async (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ ok:false, error:'bad-address' });
    const data = await getEthosForAddress(address);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok:false, error:'ethos-failed' });
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
