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
  const full = process.env.FULL === '1' || process.env.BACKFILL_ALL === '1';
  const batch = await fetchTransfers({ since: full ? null : since, limit });
  const ins = db.prepare('INSERT INTO transfers (token_id, from_addr, to_addr, timestamp, price, tx_hash, event_type) VALUES (?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE transfers SET price=COALESCE(?,price), tx_hash=COALESCE(?,tx_hash), event_type=COALESCE(?,event_type) WHERE token_id=? AND timestamp=?');
  const tx = db.transaction((arr) => {
    for (const t of arr) {
      const ts = t.timestamp || nowSec;
      const u = upd.run(t.price ?? null, t.tx_hash ?? null, t.event_type ?? null, t.token_id, ts);
      if (u.changes === 0) ins.run(t.token_id, t.from, t.to, ts, t.price ?? null, t.tx_hash ?? null, t.event_type ?? null);
    }
  });
  tx(batch);
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-activity.txt'), new Date().toISOString() + ` transfers+=${batch.length}\n`);
  fs.writeFileSync(sincePath, String(nowSec));
  console.log('sync-activity complete; inserted:', batch.length);
}

try { await main(); } finally { db.close(); }
