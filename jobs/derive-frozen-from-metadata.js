import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function main(){
  const rows = db.prepare('SELECT id, metadata FROM tokens WHERE metadata IS NOT NULL AND LENGTH(metadata)>2').all();
  const up = db.prepare('UPDATE tokens SET frozen=1 WHERE id=?');
  let count = 0;
  const tx = db.transaction(()=>{
    for (const r of rows){
      try {
        const j = JSON.parse(r.metadata);
        const root = j || {};
        const meta = root.tokenMetadata || root.metadata || root;
        const fro = !!(meta.frozen || meta.isFrozen || (meta.status==='frozen'));
        if (fro){ up.run(r.id); count++; }
      } catch {}
    }
  });
  tx();
  console.log('derive-frozen-from-metadata complete; marked', count);
  db.close();
}

main();

