// backfill-images.js
// Download/convert any missing images and thumbnails using local DB rows.
// Usage:
//   node backfill-images.js
// Optional env:
//   DATA_DIR=./data
//   IMAGE_CONCURRENCY=8
//   START_ID=1 END_ID=10000   // optional range

const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');
const API = process.env.MOD_API || 'https://api.modularium.art';
const CONTRACT = process.env.CONTRACT_ADDRESS || '0xbE25A97896b9CE164a314C70520A4df55979a0c6';
const START_ID = process.env.START_ID ? Number(process.env.START_ID) : null;
const END_ID = process.env.END_ID ? Number(process.env.END_ID) : null;
const CONC = Number(process.env.IMAGE_CONCURRENCY || 8);

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
      const r = await fetch(url, { headers: { 'user-agent': 'mammoths-network/backfill/1.0' } });
      if (r.ok) return await r.buffer();
    } catch {}
  }
  throw new Error('All gateways failed for ' + u);
}

async function getJson(urls) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'mammoths-network/backfill/1.0' } });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

async function processImageIdem(tokenId, imageUrl) {
  try {
    const httpUrl = toHttp(imageUrl);
    if (!httpUrl) return { image: null, thumbnail: null };

    const imagePath = path.join(DATA_DIR, 'images', `${tokenId}.jpg`);
    const thumbPath = path.join(DATA_DIR, 'thumbnails', `${tokenId}.jpg`);
    const relImage = `images/${tokenId}.jpg`;
    const relThumb = `thumbnails/${tokenId}.jpg`;

    const hasImage = fs.existsSync(imagePath) && fs.statSync(imagePath).size > 0;
    const hasThumb = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
    if (hasImage && hasThumb) return { image: relImage, thumbnail: relThumb };

    const buf = await fetchFromGateways(httpUrl);

    if (!hasImage) {
      await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85, progressive: true }).toFile(imagePath);
    }
    if (!hasThumb) {
      await sharp(buf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80, progressive: true }).toFile(thumbPath);
    }
    return { image: relImage, thumbnail: relThumb };
  } catch (e) {
    console.error('img fail', tokenId, e.message);
    return { image: null, thumbnail: null };
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('DB not found at', DB_PATH);
    process.exit(1);
  }
  const db = new Database(DB_PATH);

  const rows = db.prepare('SELECT id, image_url, image_local, thumbnail_local FROM tokens ORDER BY id').all();
  const filtered = rows.filter(r => {
    if (START_ID && r.id < START_ID) return false;
    if (END_ID && r.id > END_ID) return false;
    const imgPath = r.image_local ? path.join(DATA_DIR, r.image_local) : '';
    const thPath = r.thumbnail_local ? path.join(DATA_DIR, r.thumbnail_local) : '';
    const okImg = imgPath && fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0;
    const okTh  = thPath && fs.existsSync(thPath) && fs.statSync(thPath).size > 0;
    return !(okImg && okTh);
  });

  console.log(`Backfilling images for ${filtered.length}/${rows.length} tokens... (conc=${CONC})`);

  const limit = pLimit(CONC);
  const upd = db.prepare('UPDATE tokens SET image_local=?, thumbnail_local=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');

  let done=0, ok=0; await Promise.all(filtered.map(r => limit(async () => {
    let src = r.image_url;
    if (!src) {
      const meta = await getJson([
        `${API}/collection/${CONTRACT}/${r.id}`,
        `${API}/v1/collection/${CONTRACT}/${r.id}`,
        `${API}/v1/collections/forma/${CONTRACT}/${r.id}`
      ]);
      src = meta && (meta.image || (meta.tokenMetadata && (meta.tokenMetadata.image || meta.tokenMetadata.thumbnail)));
    }
    if (src) {
      const out = await processImageIdem(r.id, src);
      if (out.image && out.thumbnail) { upd.run(out.image, out.thumbnail, r.id); ok++; }
    }
    done++; if (done % 200 === 0) process.stdout.write(`\r${done}/${filtered.length} ok=${ok}`);
  })));
  process.stdout.write(`\r${done}/${filtered.length} ok=${ok}\n`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
