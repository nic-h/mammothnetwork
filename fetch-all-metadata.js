const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');

const CONTRACT_ADDRESS = '0xbE25A97896b9CE164a314C70520A4df55979a0c6';
const MODULARIUM_API = 'https://api.modularium.art';

for (const d of ['./data', './data/images', './data/thumbnails']) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const db = new Database('./data/mammoths.db');

// schema (idempotent)
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  owner TEXT,
  token_uri TEXT,
  name TEXT,
  description TEXT,
  image_url TEXT,
  image_local TEXT,
  thumbnail_local TEXT,
  metadata TEXT,
  attributes TEXT,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS attributes (
  token_id INTEGER,
  trait_type TEXT,
  trait_value TEXT,
  PRIMARY KEY (token_id, trait_type, trait_value)
);

CREATE TABLE IF NOT EXISTS collection_stats (
  id INTEGER PRIMARY KEY,
  total_supply INTEGER,
  floor_price REAL,
  holders INTEGER,
  updated_at DATETIME
);

INSERT OR IGNORE INTO collection_stats (id,total_supply,floor_price,holders,updated_at)
VALUES (1,0,0,0,CURRENT_TIMESTAMP);
`);

const insertToken = db.prepare(`
INSERT INTO tokens (id, owner, token_uri, name, description, image_url, image_local, thumbnail_local, metadata, attributes, updated_at)
VALUES (@id, @owner, @token_uri, @name, @description, @image_url, @image_local, @thumbnail_local, @metadata, @attributes, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
  owner=excluded.owner,
  token_uri=excluded.token_uri,
  name=excluded.name,
  description=excluded.description,
  image_url=excluded.image_url,
  image_local=excluded.image_local,
  thumbnail_local=excluded.thumbnail_local,
  metadata=excluded.metadata,
  attributes=excluded.attributes,
  updated_at=CURRENT_TIMESTAMP
`);

const clearAttrs = db.prepare(`DELETE FROM attributes WHERE token_id=?`);
const addAttr = db.prepare(`INSERT OR IGNORE INTO attributes (token_id, trait_type, trait_value) VALUES (?,?,?)`);
const updateStats = db.prepare(`
UPDATE collection_stats SET total_supply=?, floor_price=?, holders=?, updated_at=CURRENT_TIMESTAMP WHERE id=1
`);

const limit = pLimit(Number(process.env.METADATA_CONCURRENCY || 10));
const imageLimit = pLimit(Number(process.env.IMAGE_CONCURRENCY || 8));
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);
const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 1000);

function toHttp(u) {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5);
  return u;
}

async function fetchFromGateways(u) {
  const urls = [];
  if (u.startsWith('ipfs://')) {
    const cid = u.slice(7);
    urls.push(
      'https://ipfs.io/ipfs/' + cid,
      'https://dweb.link/ipfs/' + cid,
      'https://cloudflare-ipfs.com/ipfs/' + cid,
      'https://gateway.pinata.cloud/ipfs/' + cid
    );
  } else {
    urls.push(u);
  }
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'mammoths-network/img/1.0' } });
      if (r.ok) return await r.buffer();
    } catch {}
  }
  throw new Error('All gateways failed');
}
async function getJson(paths) {
  for (const u of paths) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'mammoths-network/1.0' } });
      if (r.ok) return await r.json();
    } catch {}
  }
  throw new Error('All endpoints failed: ' + paths.join(' | '));
}

// Idempotent image processor (skips existing non-empty files)
async function processImageIdem(tokenId, imageUrl) {
  try {
    const httpUrl = toHttp(imageUrl);
    if (!httpUrl) return { image: null, thumbnail: null };

    const imagePath = path.join('data', 'images', `${tokenId}.jpg`);
    const thumbPath = path.join('data', 'thumbnails', `${tokenId}.jpg`);
    const hasImage = fs.existsSync(imagePath) && fs.statSync(imagePath).size > 0;
    const hasThumb = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
    if (hasImage && hasThumb) {
      return { image: `images/${tokenId}.jpg`, thumbnail: `thumbnails/${tokenId}.jpg` };
    }

    const buf = await fetchFromGateways(httpUrl);

    if (!hasImage) {
      await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85, progressive: true }).toFile(imagePath);
    }
    if (!hasThumb) {
      await sharp(buf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80, progressive: true }).toFile(thumbPath);
    }

    return { image: `images/${tokenId}.jpg`, thumbnail: `thumbnails/${tokenId}.jpg` };
  } catch (e) {
    console.error(`  img fail ${tokenId}:`, e.message);
    return { image: null, thumbnail: null };
  }
}

async function processImage(tokenId, imageUrl) {
  try {
    const httpUrl = toHttp(imageUrl);
    if (!httpUrl) return { image: null, thumbnail: null };

    const res = await fetch(httpUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.buffer();

    const imagePath = path.join('data', 'images', `${tokenId}.jpg`);
    const thumbPath = path.join('data', 'thumbnails', `${tokenId}.jpg`);

    await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85, progressive: true }).toFile(imagePath);
    await sharp(buf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80, progressive: true }).toFile(thumbPath);

    return { image: `images/${tokenId}.jpg`, thumbnail: `thumbnails/${tokenId}.jpg` };
  } catch (e) {
    console.error(`  ✗ Image ${tokenId}:`, e.message);
    return { image: null, thumbnail: null };
  }
}

async function fetchAllTokens() {
  console.log('Fetching stats...');
  try {
    const s = await getJson([
      `${MODULARIUM_API}/collection/${CONTRACT_ADDRESS}/stats`,
      `${MODULARIUM_API}/v1/collection/${CONTRACT_ADDRESS}/stats`,
      `${MODULARIUM_API}/v1/collections/forma/${CONTRACT_ADDRESS}/stats`
    ]);
    updateStats.run(s.totalSupply || s.total_supply || 10000, s.floorPrice || s.floor_price || 0, s.holders || 0);
  } catch (e) {
    console.warn('stats failed:', e.message);
  }

  console.log('Fetching token id list...');
  const ids = await getJson([
    `${MODULARIUM_API}/collection/${CONTRACT_ADDRESS}/token-ids`,
    `${MODULARIUM_API}/v1/collection/${CONTRACT_ADDRESS}/token-ids`,
    `${MODULARIUM_API}/v1/collections/forma/${CONTRACT_ADDRESS}/token-ids`
  ]);
  const tokenIds = Array.isArray(ids) ? ids : (ids.ids || []);
  console.log('Total', tokenIds.length);

  for (let i = 0; i < tokenIds.length; i += BATCH_SIZE) {
    const batch = tokenIds.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${i}..${i + batch.length - 1}`);

    const metas = await Promise.all(
      batch.map(id => limit(async () => {
        try {
          return await getJson([
            `${MODULARIUM_API}/collection/${CONTRACT_ADDRESS}/${id}`,
            `${MODULARIUM_API}/v1/collection/${CONTRACT_ADDRESS}/${id}`,
            `${MODULARIUM_API}/v1/collections/forma/${CONTRACT_ADDRESS}/${id}`
          ]);
        } catch {
          return null;
        }
      }))
    );

    await Promise.all(metas.map((data, idx) => limit(async () => {
      if (!data) return;
      const tokenId = batch[idx];

      const imgSrc =
        data.image || data.image_url ||
        (data.tokenMetadata && (data.tokenMetadata.image || data.tokenMetadata.image_url)) || null;

      let imgLocal = null, thumbLocal = null;
      if (imgSrc) {
        const r = await imageLimit(() => processImageIdem(tokenId, imgSrc));
        imgLocal = r.image;
        thumbLocal = r.thumbnail;
      }

      const owner = data.owner || null;
      const token_uri = data.tokenURI || null;
      const name = (data.tokenMetadata && data.tokenMetadata.name) || `Mammoth #${tokenId}`;
      const description = (data.tokenMetadata && data.tokenMetadata.description) || null;
      const attributes = (data.tokenMetadata && Array.isArray(data.tokenMetadata.attributes)) ? data.tokenMetadata.attributes : [];

      insertToken.run({
        id: tokenId,
        owner,
        token_uri,
        name,
        description,
        image_url: imgSrc || null,
        image_local: imgLocal,
        thumbnail_local: thumbLocal,
        metadata: JSON.stringify(data.tokenMetadata || {}),
        attributes: JSON.stringify(attributes)
      });

      clearAttrs.run(tokenId);
      for (const a of attributes) {
        const t = String(a.trait_type || '').trim();
        const v = String(a.value || '').trim();
        if (!t || !v) continue;
        addAttr.run(tokenId, t, v);
      }
    })));

    if (i + BATCH_SIZE < tokenIds.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const tokenCount = db.prepare('SELECT COUNT(*) c FROM tokens').get().c;
  const imageCount = db.prepare('SELECT COUNT(*) c FROM tokens WHERE COALESCE(image_local,"")<>""').get().c;
  const thumbCount = db.prepare('SELECT COUNT(*) c FROM tokens WHERE COALESCE(thumbnail_local,"")<>""').get().c;
  console.log(`Done. tokens=${tokenCount} images=${imageCount} thumbs=${thumbCount}`);
}

fetchAllTokens()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.close());
