import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db, dbPath } = openDatabase(ROOT);
if (!db) {
  console.error('DB not found. Set DATABASE_PATH or put data/mammoths.db in repo');
  process.exit(1);
}
runMigrations(db);

const MODE = process.env.MODE || 'holders';
const NODES = Number(process.env.NODES || 10000);
const EDGE_CAP = Number(process.env.EDGES || 500);
const DEGREE_CAP = Number(process.env.DEGREE_CAP || 6);
const TRADE_THRESHOLD = Number(process.env.TRADE_THRESHOLD || 2);
const ETHOS_MIN = Number(process.env.ETHOS_MIN || 1200);

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function idToColor(id) {
  const g = 0xB0 + (id * 23) % 0x4F;
  const r = (id * 17) % 16;
  const b = (id * 11) % 16;
  return (r << 16) | (g << 8) | b;
}

function nodesList(N) {
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = { id: i + 1, color: idToColor(i + 1) };
  return arr;
}

function degreeCappedPush(edges, a, b, degree, cap) {
  if (a === b) return;
  if ((degree.get(a) || 0) >= cap) return;
  if ((degree.get(b) || 0) >= cap) return;
  edges.push([a, b, 1]);
  degree.set(a, (degree.get(a) || 0) + 1);
  degree.set(b, (degree.get(b) || 0) + 1);
}

function buildHolders(N, cap) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  const ownerTable = ['holders', 'ownership', 'owners'].find(n => names.includes(n));
  const tokenTable = ['tokens', 'token', 'nfts', 'assets', 'items'].find(n => names.includes(n));
  if (!ownerTable && !tokenTable) return [];
  const pragma = ownerTable ? db.prepare(`PRAGMA table_info(${ownerTable})`).all() : [];
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c)) || 'id';
  const ownerCol = cols.find(c => ['owner', 'holder', 'address', 'wallet'].includes(c)) || 'owner';
  const rows = ownerTable ? db.prepare(`SELECT ${tokenCol} AS token_id, ${ownerCol} AS owner FROM ${ownerTable} WHERE ${tokenCol}<=? ORDER BY owner`).all(N) : db.prepare(`SELECT id AS token_id, owner FROM ${tokenTable} WHERE id<=? ORDER BY owner`).all(N);
  const byOwner = new Map();
  for (const r of rows) { if (!byOwner.has(r.owner)) byOwner.set(r.owner, []); byOwner.get(r.owner).push(r.token_id); }
  const edges = []; const degree = new Map();
  for (const list of byOwner.values()) {
    list.sort((a,b)=>a-b);
    const stride = Math.max(1, Math.floor(list.length / 6));
    for (let i = 0; i < list.length - stride && edges.length < cap; i += stride) {
      degreeCappedPush(edges, list[i], list[i+stride], degree, DEGREE_CAP);
    }
    if (edges.length >= cap) break;
  }
  return edges;
}

function buildTransfers(N, cap) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  const xfer = ['transfers', 'sales', 'tx', 'events'].find(n => names.includes(n));
  const pragma = xfer ? db.prepare(`PRAGMA table_info(${xfer})`).all() : [];
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c)) || 'token_id';
  const timeCol = cols.find(c => ['timestamp', 'block_time', 'time', 'ts'].includes(c));
  if (!xfer) return [];
  const sql = `SELECT ${tokenCol} AS token_id ${timeCol ? (', '+timeCol+' AS t') : ''} FROM ${xfer} WHERE ${tokenCol}<=? ORDER BY ${tokenCol} ${timeCol ? ', t' : ''}`;
  const rows = db.prepare(sql).all(N);
  const byToken = new Map();
  for (const r of rows) { if (!byToken.has(r.token_id)) byToken.set(r.token_id, []); byToken.get(r.token_id).push(r); }
  const edges = []; const degree = new Map();
  for (const list of byToken.values()) {
    for (let i = 1; i < list.length && edges.length < cap; i++) {
      degreeCappedPush(edges, list[i-1].token_id, list[i].token_id, degree, DEGREE_CAP);
    }
    if (edges.length >= cap) break;
  }
  return edges;
}

function buildTraits(N, cap) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name.toLowerCase());
  const traitsTable = ['traits', 'attributes', 'metadata'].find(n => names.includes(n));
  if (!traitsTable) return [];
  const pragma = db.prepare(`PRAGMA table_info(${traitsTable})`).all();
  const cols = pragma.map(c => c.name.toLowerCase());
  const tokenCol = cols.find(c => ['token_id', 'token', 'id', 'nft_id'].includes(c)) || 'token_id';
  const traitCol = cols.find(c => ['trait', 'trait_type', 'attribute', 'name', 'key'].includes(c)) || 'trait_type';
  const valueCol = cols.find(c => ['value', 'trait_value', 'val'].includes(c)) || 'trait_value';
  const rows = db.prepare(`SELECT ${tokenCol} AS token_id, ${traitCol} AS trait, ${valueCol} AS value FROM ${traitsTable} WHERE ${tokenCol}<=?`).all(N);
  const byPair = new Map();
  for (const r of rows) { const k = `${r.trait}=${r.value}`; if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(r.token_id); }
  const edges = []; const degree = new Map();
  for (const list of byPair.values()) {
    if (list.length < 3 || list.length > 40) continue;
    list.sort((a,b)=>a-b);
    for (let i = 0; i < list.length - 1 && edges.length < cap; i++) {
      degreeCappedPush(edges, list[i], list[i+1], degree, DEGREE_CAP);
    }
    if (edges.length >= cap) break;
  }
  return edges;
}

function getOwnerTokens(owner, N) {
  return db.prepare('SELECT id FROM tokens WHERE LOWER(owner)=? AND id<=? ORDER BY id').all(owner, N).map(r => r.id);
}

function buildWallets(N, cap) {
  const edges = []; const degree = new Map();

  // 1) Tight clusters for same wallet (top owners by holdings)
  const topOwners = db.prepare(`SELECT LOWER(owner) as o, COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>'' AND id<=? GROUP BY LOWER(owner) ORDER BY c DESC LIMIT 200`).all(N);
  for (const row of topOwners) {
    const list = getOwnerTokens(row.o, N);
    if (list.length < 2) continue;
    const center = list[0];
    const step = Math.max(1, Math.floor(list.length / 8));
    for (let i = 1; i < list.length; i += step) {
      degreeCappedPush(edges, center, list[i], degree, DEGREE_CAP);
      if (edges.length >= cap) return edges;
    }
  }

  if (edges.length >= cap) return edges;

  // 2) Wallet-to-wallet trade relationships (frequent traders)
  const pairs = db.prepare(`
    SELECT LOWER(from_addr) AS a, LOWER(to_addr) AS b, COUNT(1) AS cnt
    FROM transfers
    WHERE from_addr IS NOT NULL AND from_addr<>'' AND to_addr IS NOT NULL AND to_addr<>''
      AND token_id<=?
    GROUP BY a,b
    HAVING cnt >= ?
    ORDER BY cnt DESC
    LIMIT 1000
  `).all(N, TRADE_THRESHOLD);

  for (const p of pairs) {
    const aTokens = getOwnerTokens(p.a, N);
    const bTokens = getOwnerTokens(p.b, N);
    if (!aTokens.length || !bTokens.length) continue;
    const a = aTokens[0], b = bTokens[0];
    degreeCappedPush(edges, a, b, degree, DEGREE_CAP);
    if (edges.length >= cap) break;
  }

  if (edges.length >= cap) return edges;

  // 3) Social edges: both wallets have high ethos score
  const wm = db.prepare(`SELECT address, ethos_score FROM wallet_metadata WHERE ethos_score IS NOT NULL AND ethos_score>=?`).all(ETHOS_MIN);
  const high = new Set(wm.map(r => (r.address||'').toLowerCase()));
  let added = 0;
  for (const p of pairs) {
    if (high.has(p.a) && high.has(p.b)) {
      const aTokens = getOwnerTokens(p.a, N);
      const bTokens = getOwnerTokens(p.b, N);
      if (!aTokens.length || !bTokens.length) continue;
      degreeCappedPush(edges, aTokens[0], bTokens[0], degree, DEGREE_CAP);
      added++;
      if (edges.length >= cap) break;
    }
  }

  // 4) Wallet trait similarity (Jaccard on rarest traits), bounded
  if (edges.length < cap) {
    const top = db.prepare(`SELECT LOWER(owner) as o, COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>'' AND id<=? GROUP BY LOWER(owner) ORDER BY c DESC LIMIT 120`).all(N);
    // Build trait sets per owner (dominant trait per token)
    const traitCountRows = db.prepare("SELECT trait_type||':'||trait_value AS k, COUNT(1) AS c FROM attributes WHERE token_id<=? GROUP BY k").all(N);
    const freq = new Map(traitCountRows.map(r=>[r.k, r.c]));
    const tokenAttrs = db.prepare('SELECT token_id, trait_type, trait_value FROM attributes WHERE token_id<=?').all(N);
    const rarest = new Map();
    for (const a of tokenAttrs) {
      const k = `${a.trait_type}:${a.trait_value}`;
      const c = freq.get(k) || 1;
      const cur = rarest.get(a.token_id);
      if (!cur || c < cur.c) rarest.set(a.token_id, { k, c });
    }
    const ownerSets = new Map();
    for (const ow of top) {
      const toks = getOwnerTokens(ow.o, N);
      const set = new Set();
      for (const t of toks) { const r = rarest.get(t); if (r) set.add(r.k); }
      ownerSets.set(ow.o, set);
    }
    const owners = top.map(r=>r.o);
    for (let i=0;i<owners.length && edges.length<cap;i++) {
      for (let j=i+1;j<owners.length && edges.length<cap;j++) {
        const A = ownerSets.get(owners[i]);
        const B = ownerSets.get(owners[j]);
        if (!A || !B || A.size===0 || B.size===0) continue;
        let inter=0;
        for (const k of A) if (B.has(k)) inter++;
        const jac = inter / (A.size + B.size - inter);
        if (jac >= 0.15) {
          const aTokens = getOwnerTokens(owners[i], N);
          const bTokens = getOwnerTokens(owners[j], N);
          if (aTokens.length && bTokens.length) degreeCappedPush(edges, aTokens[0], bTokens[0], degree, DEGREE_CAP);
        }
      }
    }
  }

  return edges;
}

function main() {
  const N = clamp(NODES, 100, 10000);
  const cap = clamp(EDGE_CAP, 0, 500);
  let edges = [];
  if (MODE === 'holders') edges = buildHolders(N, cap);
  else if (MODE === 'transfers') edges = buildTransfers(N, cap);
  else if (MODE === 'traits') edges = buildTraits(N, cap);
  else if (MODE === 'wallets') edges = buildWallets(N, cap);
  else edges = buildHolders(N, cap);
  const payload = { nodes: nodesList(N), edges, meta: { mode: MODE, source: 'sqlite' } };
  const key = `graph:${MODE}:${N}:${cap}`;
  const etag = `W/"${Buffer.from(key).toString('hex')}"`;
  const up = db.prepare('INSERT INTO graph_cache (key, etag, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET etag=excluded.etag, payload=excluded.payload, updated_at=CURRENT_TIMESTAMP');
  up.run(key, etag, JSON.stringify(payload));
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', `compute-edges.${MODE}.txt`), new Date().toISOString());
  console.log('graph_cache updated', key, 'edges', edges.length);
}

try { main(); } finally { db.close(); }
