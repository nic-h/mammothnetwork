import 'dotenv/config';
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

  const ins = db.prepare('INSERT INTO transfers (token_id, from_addr, to_addr, timestamp, price, tx_hash, event_type) VALUES (?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE transfers SET price=COALESCE(?,price), tx_hash=COALESCE(?,tx_hash), event_type=COALESCE(?,event_type) WHERE token_id=? AND timestamp=?');
  const tx = db.transaction((arr) => {
    for (const t of arr) {
      const ts = t.timestamp || nowSec;
      const u = upd.run(t.price ?? null, t.tx_hash ?? null, t.event_type ?? null, t.token_id, ts);
      if (u.changes === 0) ins.run(t.token_id, t.from, t.to, ts, t.price ?? null, t.tx_hash ?? null, t.event_type ?? null);
    }
  });

  let inserted = 0;
  let batchNum = 0;
  let cursor = full ? null : since;
  while (true) {
    const batch = await fetchTransfers({ since: cursor, limit });
    if (!Array.isArray(batch) || batch.length === 0) break;
    tx(batch);
    inserted += batch.length;
    batchNum++;
    // advance cursor to strictly after the max timestamp to avoid duplicates
    const maxTs = Math.max(...batch.map(b => Number(b.timestamp || 0)));
    cursor = isFinite(maxTs) && maxTs > 0 ? (maxTs + 1) : cursor;
    // checkpoint progress every batch
    fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-activity.txt'), new Date().toISOString() + ` transfers+=${inserted} batches=${batchNum}\n`);
    // prevent infinite loops if endpoint returns the same set repeatedly
    if (batch.length < limit) break;
  }

  fs.writeFileSync(sincePath, String(nowSec));
  console.log('sync-activity complete; inserted:', inserted, 'batches:', batchNum);
}

try { await main(); } finally { db.close(); }
