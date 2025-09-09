import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';
import { fetchHolders } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function isFrozenFlag(v){
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'frozen';
}

async function main(){
  const items = await fetchHolders().catch(()=>[]);
  const frozenIds = new Set();
  for (const h of items){
    const id = Number(h.tokenId || h.id);
    const flag = h.frozenBalance ?? h.frozen ?? h.isFrozen ?? h.flag;
    if (Number.isFinite(id) && isFrozenFlag(flag)) frozenIds.add(id);
  }
  const tx = db.transaction(() => {
    db.exec('UPDATE tokens SET frozen=0');
    const up = db.prepare('UPDATE tokens SET frozen=1 WHERE id=?');
    for (const id of frozenIds) up.run(id);
  });
  tx();
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-frozen-from-holders.txt'), new Date().toISOString()+` frozen=${frozenIds.size}\n`);
  console.log('sync-frozen-from-holders complete; frozen tokens:', frozenIds.size);
}

try { await main(); } finally { db.close(); }

