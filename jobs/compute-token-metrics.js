import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function getTokenIds() {
  const rows = db.prepare('SELECT id FROM tokens ORDER BY id').all();
  return rows.map(r => r.id);
}

function computeForToken(id, owner) {
  const saleAgg = db.prepare(`
    SELECT COUNT(1) AS c, AVG(price) AS avg_p, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
    FROM transfers WHERE token_id=? AND price IS NOT NULL AND price>0
  `).get(id);
  const lastSale = db.prepare(`
    SELECT price AS p, timestamp AS ts
    FROM transfers WHERE token_id=? AND price IS NOT NULL AND price>0
    ORDER BY timestamp DESC LIMIT 1
  `).get(id) || { p: null, ts: null };
  const acq = db.prepare(`
    SELECT timestamp AS ts, price AS p
    FROM transfers WHERE token_id=? AND LOWER(to_addr)=?
    ORDER BY timestamp DESC LIMIT 1
  `).get(id, (owner||'').toLowerCase());
  const nowSec = Math.floor(Date.now()/1000);
  const last_acquired_ts = acq?.ts || null;
  const last_buy_price = (acq && acq.p!=null) ? Number(acq.p) : null;
  const hold_days = last_acquired_ts ? (nowSec - Number(last_acquired_ts)) / 86400 : null;
  const sale_count = Number(saleAgg?.c || 0);
  const avg_sale_price = saleAgg?.avg_p != null ? Number(saleAgg.avg_p) : null;
  const first_sale_ts = saleAgg?.first_ts || null;
  const last_sale_ts = saleAgg?.last_ts || null;
  const last_sale_price = (lastSale && lastSale.p!=null) ? Number(lastSale.p) : null;
  return { sale_count, avg_sale_price, last_sale_price, first_sale_ts, last_sale_ts, last_acquired_ts, last_buy_price, hold_days };
}

async function main(){
  console.log('Computing token-level sales/hold metrics...');
  const ids = db.prepare("SELECT id, LOWER(COALESCE(owner, '')) AS owner FROM tokens ORDER BY id").all();
  const update = db.prepare(`
    UPDATE tokens SET
      sale_count=?, avg_sale_price=?, last_sale_price=?,
      first_sale_ts=?, last_sale_ts=?, last_acquired_ts=?, last_buy_price=?, hold_days=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);
  const tx = db.transaction(rows => {
    for (const r of rows) {
      const m = computeForToken(r.id, r.owner);
      update.run(
        m.sale_count || 0,
        m.avg_sale_price,
        m.last_sale_price,
        m.first_sale_ts,
        m.last_sale_ts,
        m.last_acquired_ts,
        m.last_buy_price,
        m.hold_days,
        r.id
      );
    }
  });
  tx(ids);
  try { fs.mkdirSync(path.join(ROOT, 'data', '.checkpoints'), { recursive: true }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'compute-token-metrics.txt'), new Date().toISOString() + ` tokens=${ids.length}\n`);
  console.log('Token metrics updated for', ids.length, 'tokens');
}

try { await main(); } finally { db.close(); }
