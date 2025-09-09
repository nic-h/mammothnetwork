import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function main() {
  const now = Math.floor(Date.now()/1000);
  const dormantDays = Number(process.env.DORMANT_DAYS||90);
  // 1) set last_activity for tokens that have transfers
  const lastRows = db.prepare('SELECT token_id AS id, MAX(timestamp) AS t FROM transfers GROUP BY token_id').all();
  const upLast = db.prepare('UPDATE tokens SET last_activity=? WHERE id=?');
  const tx1 = db.transaction((arr)=>{ for (const r of arr) upLast.run(r.t || null, r.id); });
  tx1(lastRows);
  // 2) dormant = true if a token has zero transfers (NEVER moved/listed in our data)
  const zeroRows = db.prepare('SELECT id FROM tokens WHERE id NOT IN (SELECT DISTINCT token_id FROM transfers)').all();
  db.exec('UPDATE tokens SET dormant=0');
  const upDorm = db.prepare('UPDATE tokens SET dormant=1 WHERE id=?');
  const tx2 = db.transaction((arr)=>{ for (const r of arr) upDorm.run(r.id); });
  tx2(zeroRows);
  console.log('mark-dormant complete; zero-transfer tokens:', zeroRows.length);
  db.close();
}

main();
