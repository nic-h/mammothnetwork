import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db, dbPath } = openDatabase(ROOT);
if (!db) { console.error('No DB open'); process.exit(1); }
runMigrations(db);

function exec(sql){ try { db.exec(sql); } catch(e){ console.error('SQL error:', e.message); } }

// 1) Normalize addresses
exec(`UPDATE tokens SET owner=LOWER(owner) WHERE owner IS NOT NULL;`);
exec(`UPDATE transfers SET from_addr=LOWER(from_addr), to_addr=LOWER(to_addr) WHERE from_addr IS NOT NULL OR to_addr IS NOT NULL;`);
exec(`UPDATE wallet_metadata SET address=LOWER(address) WHERE address IS NOT NULL;`);

// 2) Classify event_type in transfers where missing
exec(`UPDATE transfers 
      SET event_type = CASE
        WHEN price IS NOT NULL AND price>0 THEN 'sale'
        WHEN from_addr IS NULL OR from_addr='' OR from_addr='0x0000000000000000000000000000000000000000' THEN 'mint'
        WHEN to_addr IS NULL OR to_addr='' OR to_addr='0x0000000000000000000000000000000000000000' THEN 'burn'
        ELSE 'transfer'
      END
      WHERE event_type IS NULL;`);

// 3) Update hold_days for tokens
exec(`UPDATE tokens 
      SET hold_days = CAST((julianday('now') - julianday(datetime(last_acquired_ts, 'unixepoch'))) AS INTEGER)
      WHERE last_acquired_ts IS NOT NULL;`);

// 4) Dormant flag for tokens with no activity in last 180 days
exec(`UPDATE tokens SET dormant=1 
      WHERE id NOT IN (
        SELECT DISTINCT token_id FROM transfers WHERE timestamp > (strftime('%s','now') - 86400*180)
      );`);

// 5) Velocity metric
try {
  const rows = db.prepare(`SELECT id FROM tokens`).all();
  const q = db.prepare(`SELECT COUNT(1) c, MIN(timestamp) mn, MAX(timestamp) mx FROM transfers WHERE token_id=?`);
  const up = db.prepare(`UPDATE tokens SET velocity=? WHERE id=?`);
  db.exec('BEGIN');
  for (const r of rows){
    const a = q.get(r.id)||{c:0,mn:null,mx:null};
    let v = 0; if (a.c>1 && a.mn && a.mx && a.mx>a.mn){ const months=(a.mx-a.mn)/86400/30; v = a.c/Math.max(1,months); }
    up.run(v, r.id);
  }
  db.exec('COMMIT');
} catch(e){ console.error('velocity error', e.message); db.exec('ROLLBACK'); }

console.log('Backfill completed for', dbPath);
db.close();

