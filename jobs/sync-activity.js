import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';
import { fetchTransfers, envEnabled } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

async function main() {
  if (!envEnabled()) {
    console.log('Modularium not configured; skipping sync-activity.');
    const count = db.prepare('SELECT COUNT(1) c FROM transfers').get().c;
    fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-activity.txt'), new Date().toISOString() + ` transfers=${count}\n`);
    return;
  }

  const sincePath = path.join(ROOT, 'data', '.checkpoints', 'sync-activity.since');
  let since = null;
  if (fs.existsSync(sincePath)) {
    const s = fs.readFileSync(sincePath, 'utf-8').trim();
    since = Number(s) || null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const limit = Number(process.env.MOD_LIMIT || 5000);
  const batch = await fetchTransfers({ since, limit });
  const ins = db.prepare('INSERT INTO transfers (token_id, from_addr, to_addr, timestamp) VALUES (?,?,?,?)');
  const tx = db.transaction((arr) => { for (const t of arr) ins.run(t.token_id, t.from, t.to, t.timestamp || nowSec); });
  tx(batch);
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-activity.txt'), new Date().toISOString() + ` transfers+=${batch.length}\n`);
  fs.writeFileSync(sincePath, String(nowSec));
  console.log('sync-activity complete; inserted:', batch.length);
}

try { await main(); } finally { db.close(); }
