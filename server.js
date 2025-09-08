const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';

const DB_PATH = path.join(DATA_DIR, 'mammoths.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('Missing DB:', DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH);

app.use('/images', express.static(path.join(DATA_DIR, 'images'), { maxAge: '365d', immutable: true }));
app.use('/thumbnails', express.static(path.join(DATA_DIR, 'thumbnails'), { maxAge: '365d', immutable: true }));
app.use('/', express.static(__dirname, { index: 'index.html' }));

const STMT = {
  stats: db.prepare('SELECT total_supply, floor_price, holders, updated_at FROM collection_stats WHERE id=1'),
  ids: db.prepare('SELECT id FROM tokens ORDER BY id'),
  token: db.prepare('SELECT * FROM tokens WHERE id=?'),
  attrsFor: db.prepare('SELECT trait_type, trait_value FROM attributes WHERE token_id=? ORDER BY trait_type, trait_value'),
  traits: db.prepare(`
    SELECT trait_type, trait_value, COUNT(*) as count
    FROM attributes
    GROUP BY trait_type, trait_value
    ORDER BY trait_type, count DESC
  `)
};

app.get('/api/stats', (req, res) => {
  const s = STMT.stats.get() || { total_supply: 0, floor_price: 0, holders: 0 };
  // map to UI shape
  res.json({
    totalSupply: s.total_supply || 0,
    floorPrice: s.floor_price || 0,
    holders: s.holders || 0,
    lastUpdated: s.updated_at || null
  });
});

app.get('/api/token-ids', (req, res) => {
  const ids = STMT.ids.all().map(r => r.id);
  res.json(ids);
});

app.get('/api/token/:id', (req, res) => {
  const id = Number(req.params.id);
  const t = STMT.token.get(id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const attrs = STMT.attrsFor.all(id).map(r => ({ trait_type: r.trait_type, value: r.trait_value }));

  // tokenMetadata for UI (preserve your older shape)
  const meta = t.metadata ? safeJSON(t.metadata) : {};
  meta.attributes = attrs;

  const thumb = t.thumbnail_local ? ('/' + t.thumbnail_local) : toHttp(t.image_url || null);
  const full = t.image_local ? ('/' + t.image_local) : toHttp(t.image_url || null);
  const name = t.name || `Mammoth #${t.id}`;
  const description = t.description || '';

  res.json({
    id: t.id,
    name,
    owner: t.owner,
    frozen: t.frozen ? 1 : 0,
    dormant: t.dormant ? 1 : 0,
    lastActivity: t.last_activity || null,
    tokenURI: t.token_uri,
    fullImage: full,
    thumbImage: thumb,
    attributes: attrs.map(a => ({ trait_type: a.trait_type, trait_value: a.value })),
    tokenMetadata: {
      ...meta,
      image: thumb,
      fullImage: full,
      name,
      description
    }
  });
});

app.get('/api/tokens-batch', (req, res) => {
  const raw = String(req.query.ids || '');
  const ids = raw.split(',').map(x => Number(x)).filter(Boolean);
  if (!ids.length) return res.json([]);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM tokens WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);

  const out = rows.map(t => {
    const attrs = STMT.attrsFor.all(t.id).map(r => ({ trait_type: r.trait_type, value: r.trait_value }));
    const thumb = t.thumbnail_local ? ('/' + t.thumbnail_local) : toHttp(t.image_url || null);
    const full = t.image_local ? ('/' + t.image_local) : toHttp(t.image_url || null);
    const name = t.name || `Mammoth #${t.id}`;
    return {
      id: t.id,
      name,
      owner: t.owner,
      frozen: t.frozen ? 1 : 0,
      dormant: t.dormant ? 1 : 0,
      lastActivity: t.last_activity || null,
      fullImage: full,
      thumbImage: thumb,
      attributes: attrs.map(a => ({ trait_type: a.trait_type, trait_value: a.value })),
      tokenMetadata: {
        attributes: attrs,
        image: thumb,
        fullImage: full,
        name,
        description: t.description || ''
      }
    };
  });
  res.json(out);
});

app.get('/api/traits', (req, res) => {
  res.json(STMT.traits.all());
});

// IDs that match a specific trait/value (case-insensitive)
app.get('/api/ids-by-trait', (req, res) => {
  const type = String(req.query.type || '').trim();
  const value = String(req.query.value || '').trim();
  if (!type || !value) return res.json([]);
  const sql = `SELECT token_id AS id FROM attributes WHERE LOWER(trait_type)=LOWER(?) AND LOWER(trait_value)=LOWER(?) ORDER BY token_id`;
  try {
    const rows = db.prepare(sql).all(type, value);
    res.json(rows.map(r => r.id));
  } catch (e) {
    res.status(500).json({ error: 'query-failed' });
  }
});

app.get('/api/status-counts', (req, res) => {
  const frozen = db.prepare('SELECT COUNT(*) c FROM tokens WHERE frozen=1').get().c;
  const dormant = db.prepare('SELECT COUNT(*) c FROM tokens WHERE dormant=1').get().c;
  const total = db.prepare('SELECT COUNT(*) c FROM tokens').get().c;
  res.json({ frozen, dormant, active: Math.max(0, total - dormant) , total });
});

function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

// Build a lightweight wallet↔token graph for visualization
app.get('/api/owners-graph', (req, res) => {
  // Pull owner + a single representative trait to color by (Body)
  const rows = db.prepare(`
    SELECT t.id,
           LOWER(COALESCE(t.owner,'')) AS owner,
           t.frozen AS frozen,
           t.dormant AS dormant,
           (
             SELECT trait_value FROM attributes a
             WHERE a.token_id = t.id AND a.trait_type = 'Body'
             LIMIT 1
           ) AS body
    FROM tokens t
    ORDER BY t.id
  `).all();

  const wallets = new Map();
  const nodes = [];
  const edges = [];

  for (const r of rows) {
    if (!r.owner) continue; // skip unknown owners
    if (!wallets.has(r.owner)) wallets.set(r.owner, { id: r.owner, kind: 'wallet', holdCount: 0 });
    const w = wallets.get(r.owner);
    w.holdCount++;
    nodes.push({ id: `m#${r.id}`, mid: r.id, kind: 'mammoth', trait: { body: r.body || null }, owner: r.owner, frozen: r.frozen?1:0, dormant: r.dormant?1:0 });
    edges.push({ source: r.owner, target: `m#${r.id}` });
  }

  const walletNodes = Array.from(wallets.values());
  const out = { nodes: walletNodes.concat(nodes), edges, meta: { generatedAt: new Date().toISOString() } };
  res.json(out);
});

function toHttp(u) {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return (IPFS_GATEWAY.endsWith('/') ? IPFS_GATEWAY : IPFS_GATEWAY + '/') + u.slice(7);
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5);
  return u;
}

app.listen(PORT, () => {
  console.log(`OK http://localhost:${PORT}  DATA_DIR=${DATA_DIR}`);
});
