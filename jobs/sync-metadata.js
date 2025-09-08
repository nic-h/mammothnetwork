import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';
import { fetchCollectionStats, fetchTokenIds, fetchTokenMeta } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

for (const d of ['data/images', 'data/thumbnails', 'data/.checkpoints']) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

const DOWNLOAD = process.env.DOWNLOAD_IMAGES === '1' || process.env.DOWNLOAD_IMAGES === 'true';
const CONC = Number(process.env.METADATA_CONC || 8);
const START_ID = process.env.START_ID ? Number(process.env.START_ID) : null;
const END_ID = process.env.END_ID ? Number(process.env.END_ID) : null;

const insertToken = db.prepare(`
INSERT INTO tokens (id, owner, token_uri, name, description, image_url, image_local, thumbnail_local, metadata, attributes, updated_at)
VALUES (@id, @owner, @token_uri, @name, @description, @image_url, @image_local, @thumbnail_local, @metadata, @attributes, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
  owner=COALESCE(excluded.owner, tokens.owner),
  token_uri=excluded.token_uri,
  name=excluded.name,
  description=excluded.description,
  image_url=excluded.image_url,
  image_local=COALESCE(excluded.image_local, tokens.image_local),
  thumbnail_local=COALESCE(excluded.thumbnail_local, tokens.thumbnail_local),
  metadata=excluded.metadata,
  attributes=excluded.attributes,
  updated_at=CURRENT_TIMESTAMP
`);
const clearAttrs = db.prepare('DELETE FROM attributes WHERE token_id=?');
const addAttr = db.prepare('INSERT OR IGNORE INTO attributes (token_id, trait_type, trait_value) VALUES (?,?,?)');
const upStats = db.prepare('UPDATE collection_stats SET total_supply=?, updated_at=CURRENT_TIMESTAMP WHERE id=1');

function toHttp(u) {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5);
  return u;
}

async function fetchBuffer(u) {
  const r = await fetch(u, { headers: { 'user-agent': 'mammoths-network/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function writeImage(id, url) {
  try {
    if (!DOWNLOAD) return { image: null, thumb: null };
    const http = toHttp(url);
    if (!http) return { image: null, thumb: null };
    const imgPath = path.join(ROOT, 'data', 'images', `${id}.jpg`);
    const thPath = path.join(ROOT, 'data', 'thumbnails', `${id}.jpg`);
    const hasImg = fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0;
    const hasTh = fs.existsSync(thPath) && fs.statSync(thPath).size > 0;
    if (hasImg && hasTh) return { image: `images/${id}.jpg`, thumb: `thumbnails/${id}.jpg` };
    const buf = await fetchBuffer(http);
    if (!hasImg) fs.writeFileSync(imgPath, buf);
    // Try to generate 256x256 thumbnail if sharp is available
    try {
      const sharp = (await import('sharp')).default;
      if (!hasTh) {
        const jpg = await sharp(buf).resize(256, 256, { fit: 'inside' }).jpeg({ quality: 80, progressive: true }).toBuffer();
        fs.writeFileSync(thPath, jpg);
      }
    } catch {
      if (!hasTh) fs.writeFileSync(thPath, buf); // fallback: original
    }
    return { image: `images/${id}.jpg`, thumb: `thumbnails/${id}.jpg` };
  } catch (e) {
    console.warn('Thumbnail generation failed, using original image for', id, e.message);
    return { image: null, thumb: null };
  }
}

async function main() {
  // Stats & ids
  try {
    const s = await fetchCollectionStats().catch(() => ({}));
    if (s && (s.totalSupply || s.total_supply)) upStats.run(s.totalSupply || s.total_supply);
  } catch {}
  const idsRaw = await fetchTokenIds();
  const ids = idsRaw.filter(id => (START_ID ? id >= START_ID : true) && (END_ID ? id <= END_ID : true));

  let i = 0; let active = 0; let done = 0;
  await new Promise(resolve => {
    const next = () => {
      if (done >= ids.length) return resolve();
      while (active < CONC && i < ids.length) {
        const id = ids[i++];
        active++;
        (async () => {
          try {
            const m = await fetchTokenMeta(id);
            const tokenMeta = m.tokenMetadata || m.metadata || {};
            const name = tokenMeta.name || m.name || `Mammoth #${id}`;
            const description = tokenMeta.description || m.description || null;
            const token_uri = m.tokenURI || m.token_uri || null;
            const owner = (m.owner || m.currentOwner || null);
            const imgSrc = m.image || m.image_url || tokenMeta.image || tokenMeta.image_url || null;
            const attrs = Array.isArray(tokenMeta.attributes) ? tokenMeta.attributes : [];
            let image_local = null, thumbnail_local = null;
            if (imgSrc) {
              const w = await writeImage(id, imgSrc);
              image_local = w.image; thumbnail_local = w.thumb;
            }
            insertToken.run({
              id,
              owner,
              token_uri,
              name,
              description,
              image_url: imgSrc || null,
              image_local,
              thumbnail_local,
              metadata: JSON.stringify(tokenMeta || {}),
              attributes: JSON.stringify(attrs || [])
            });
            clearAttrs.run(id);
            for (const a of attrs) {
              const t = String(a.trait_type || a.type || '').trim();
              const v = String(a.value || '').trim();
              if (t && v) addAttr.run(id, t, v);
            }
          } catch {}
          done++; active--;
          if (done % 200 === 0) process.stdout.write(`\rmeta ${done}/${ids.length}`);
          next();
        })();
      }
    };
    next();
  });
  process.stdout.write(`\rmeta ${ids.length}/${ids.length}\n`);
}

try { await main(); } finally { db.close(); }
