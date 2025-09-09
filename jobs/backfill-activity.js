import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

const BASE = process.env.MODULARIUM_API || 'https://api.modularium.art';
const CONTRACT = (process.env.CONTRACT_ADDRESS || '').toLowerCase();

async function fetchPage(page=1, limit=1000){
  const url = `${BASE}/collection/${CONTRACT}/activity?limit=${limit}&page=${page}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function normEvent(ev){
  const token_id = Number(ev.tokenId || ev.token_id || ev.id || 0);
  if (!Number.isFinite(token_id) || token_id <= 0) return null;
  const ts = Number(ev.timestamp || ev.blockTime || ev.time || 0);
  const price = (typeof ev.price === 'number') ? ev.price : null;
  return { token_id, timestamp: ts || null, price: price || null };
}

async function main(){
  const limit = Number(process.env.ACT_LIMIT || 1000);
  const maxPages = Number(process.env.ACT_PAGES || 50);
  const ins = db.prepare('INSERT INTO transfers (token_id, from_addr, to_addr, timestamp, price) VALUES (?,?,?,?,?)');
  let total = 0;
  for (let p = 1; p <= maxPages; p++){
    const arr = await fetchPage(p, limit).catch(()=>[]);
    if (!Array.isArray(arr) || arr.length === 0) break;
    const rows = arr.map(normEvent).filter(Boolean);
    const tx = db.transaction((list)=>{ for(const r of list) ins.run(r.token_id, null, null, r.timestamp, r.price); });
    tx(rows);
    total += rows.length;
    process.stdout.write(`\ractivity ${total} (page ${p})`);
  }
  process.stdout.write(`\nactivity backfill complete: ${total}\n`);
  db.close();
}

try { await main(); } catch (e) { console.error('backfill failed', e.message); process.exit(1); }

