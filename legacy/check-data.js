// check-data.js (sanity report for local cache)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const imgDir = path.join(DATA_DIR, 'images');
const thDir = path.join(DATA_DIR, 'thumbnails');

const total = db.prepare('SELECT COUNT(*) c FROM tokens').get().c;
const withLocal = db
  .prepare("SELECT COUNT(*) c FROM tokens WHERE image_local IS NOT NULL AND image_local <> ''")
  .get().c;
const withThumb = db
  .prepare("SELECT COUNT(*) c FROM tokens WHERE thumbnail_local IS NOT NULL AND thumbnail_local <> ''")
  .get().c;

const sample = db
  .prepare(
    `SELECT id, image_url, image_local, thumbnail_local FROM tokens ORDER BY id LIMIT 5`
  )
  .all();

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const filesImg = exists(imgDir) ? fs.readdirSync(imgDir).length : 0;
const filesTh = exists(thDir) ? fs.readdirSync(thDir).length : 0;

console.log('DATA_DIR        :', DATA_DIR);
console.log('DB tokens       :', total);
console.log('DB has image_local  :', withLocal);
console.log('DB has thumbnail_local:', withThumb);
console.log('FS images count :', filesImg, imgDir);
console.log('FS thumbs count :', filesTh, thDir);
console.log('Sample rows:');
for (const r of sample) {
  const ip = r.image_local ? path.join(DATA_DIR, r.image_local) : '(null)';
  const tp = r.thumbnail_local ? path.join(DATA_DIR, r.thumbnail_local) : '(null)';
  console.log(`#${r.id}`, {
    image_url: r.image_url,
    image_local: r.image_local,
    exists_image: exists(ip),
    thumbnail_local: r.thumbnail_local,
    exists_thumb: exists(tp)
  });
}
