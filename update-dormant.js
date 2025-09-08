// update-dormant.js
// Mark tokens as dormant based on collection activity recency.
// Simple heuristic: tokens not appearing in last N days of activity are dormant.

const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const CONTRACT = process.env.CONTRACT_ADDRESS || '0xbE25A97896b9CE164a314C70520A4df55979a0c6';
const API = process.env.MOD_API || 'https://api.modularium.art';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');
const DAYS = Number(process.env.DORMANT_DAYS || 45); // window of recency

if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }

const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function j(url) { const r = await fetch(url, { headers:{'user-agent':'mammoths-network/dormant/1.0'} }); if(!r.ok) throw new Error(r.status+' '+url); return r.json(); }

async function fetchActivityPagesUntil(untilMs, maxPages=50, perPage=1000){
  let page=1, out=[]; const base=`${API}/collection/${CONTRACT}/activity`;
  while(page<=maxPages){
    const url = `${base}?page=${page}&per_page=${perPage}`;
    const r = await fetch(url);
    if(!r.ok) break;
    const rows = await r.json();
    if(!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    const oldestMs = (rows[rows.length-1]?.timestamp||0)*1000;
    if(oldestMs < untilMs) break;
    page++;
    if(page%3===0) await sleep(120);
  }
  return out;
}

async function run(){
  const cutoff = Date.now() - DAYS*24*3600*1000;
  console.log('Scanning activity since', new Date(cutoff).toISOString());
  const rows = await fetchActivityPagesUntil(cutoff, 60, 1000);
  const seen = new Set();
  for (const r of rows){ const id = Number(r.tokenId||0); if(id>0) seen.add(id); }
  const markDormant = db.prepare('UPDATE tokens SET dormant=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const markLast = db.prepare('UPDATE tokens SET last_activity=? WHERE id=?');

  // fill last_activity from seen set with the latest per token
  const lastById = new Map();
  for (const r of rows){ const tid=Number(r.tokenId||0); const ts=(r.timestamp||0)*1000; if(tid>0){ const prev=lastById.get(tid)||0; if(ts>prev) lastById.set(tid, ts); } }
  for (const [id,ts] of lastById.entries()) markLast.run(Math.floor(ts/1000), id);

  // tokens in DB
  const ids = db.prepare('SELECT id FROM tokens').all().map(r=>r.id);
  let dCount=0, aCount=0; for (const id of ids){ const d = seen.has(id) ? 0 : 1; markDormant.run(d, id); d?dCount++:aCount++; }
  console.log('Dormant=', dCount, 'Active=', aCount);
}

run().catch(e=>{ console.error(e); process.exit(1); }).finally(()=>db.close());

