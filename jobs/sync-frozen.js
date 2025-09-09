import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';
import { fetchFrozenTokens } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

async function main() {
  const frozenIds = await fetchFrozenTokens().catch(()=>[]);
  const set = new Set(frozenIds.map(Number));
  const N = db.prepare('SELECT COUNT(1) c FROM tokens').get().c;
  const tx = db.transaction(() => {
    db.exec('UPDATE tokens SET frozen=0');
    const up = db.prepare('UPDATE tokens SET frozen=1 WHERE id=?');
    for (const id of set) up.run(id);
  });
  tx();
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-frozen.txt'), new Date().toISOString() + ` frozen=${set.size} tokens=${N}\n`);
  console.log('sync-frozen complete; frozen tokens:', set.size);
}

try { await main(); } finally { db.close(); }

