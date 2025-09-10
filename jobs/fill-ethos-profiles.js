import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ETHOS_API = process.env.ETHOS_API || 'https://api.ethos.network';
const BATCH = Math.min(Math.max(Number(process.env.ETHOS_BATCH || 250), 1), 500);

const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function uniq(arr){ return Array.from(new Set(arr.filter(Boolean).map(a=>a.toLowerCase()))); }

const ETHOS_HEADERS = { 'content-type': 'application/json', 'accept': 'application/json', 'X-Ethos-Client': (process.env.ETHOS_CLIENT || 'mammothnetwork/0.1.0') };

async function postJson(url, body){
  const r = await fetch(url, { method:'POST', headers: ETHOS_HEADERS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP '+r.status);
  return await r.json();
}

async function main(){
  const addrs = uniq(db.prepare("SELECT LOWER(owner) a FROM tokens WHERE owner IS NOT NULL AND owner<>'' GROUP BY LOWER(owner)").all().map(r=>r.a));
  if (!addrs.length) { console.log('no owners'); return; }
  const up = db.prepare(`INSERT INTO ethos_profiles (wallet, has_ethos, profile_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET has_ethos=excluded.has_ethos, profile_json=excluded.profile_json, updated_at=excluded.updated_at`);

  for (let i=0;i<addrs.length;i+=BATCH){
    const batch = addrs.slice(i, i+BATCH);
    let users = [];
    try { users = await postJson(`${ETHOS_API}/api/v2/users/by/address`, { addresses: batch }); } catch {}
    const now = Math.floor(Date.now()/1000);
    const byAddr = new Map();
    if (Array.isArray(users)){
      for (const u of users){
        const keys = Array.isArray(u?.userkeys) ? u.userkeys : [];
        let addr = (u.address || '').toLowerCase();
        const key = keys.find(k => typeof k==='string' && k.toLowerCase().startsWith('address:'));
        if (!addr && key) addr = key.slice('address:'.length).toLowerCase();
        if (!addr) continue;
        byAddr.set(addr, u);
      }
    }
    const tx = db.transaction((pairs)=>{
      for (const [addr, user] of pairs){
        const active = !!(user && ((typeof user.profileId === 'number' && user.profileId > 0) || String(user.status||'').toUpperCase() === 'ACTIVE'));
        const prof = active ? user : null;
        up.run(addr, active?1:0, active? JSON.stringify(prof) : null, now);
      }
    });
    const pairs = batch.map(a => [a, byAddr.get(a) || null]);
    tx(pairs);
    process.stdout.write(`\rprofiles ${Math.min(i+BATCH, addrs.length)}/${addrs.length}`);
  }
  process.stdout.write(`\rprofiles ${addrs.length}/${addrs.length}\n`);
}

try { await main(); } finally { db.close(); }
