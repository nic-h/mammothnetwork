import 'dotenv/config';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function hashStr(s){
  let h = 2166136261>>>0; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h>>>0;
}
function rng(seed){ let a=seed>>>0; return ()=>{ a+=0x6D2B79F5; let t=a; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }

function polar(cx, cy, r, ang){ return [cx + Math.cos(ang)*r, cy + Math.sin(ang)*r]; }

function computeWalletLayout(){
  const owners = db.prepare("SELECT LOWER(owner) addr, COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>'' GROUP BY LOWER(owner) ORDER BY c DESC").all();
  const N = owners.length;
  const R = 1000; // ring radius
  const out = [];
  for (let i=0;i<N;i++){
    const ang = (i / Math.max(1,N)) * Math.PI*2;
    // slight radial jitter by holdings to separate hubs
    const r = R + Math.min(200, Math.sqrt(owners[i].c||1)*3);
    const [x,y] = polar(0,0,r, ang);
    out.push({ address: owners[i].addr, x, y, mode: 'holders' });
  }
  const up = db.prepare('INSERT INTO wallet_layout (address, x, y, mode, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET x=excluded.x, y=excluded.y, mode=excluded.mode, updated_at=excluded.updated_at');
  const now = Math.floor(Date.now()/1000);
  const tx = db.transaction((rows)=>{ for (const r of rows) up.run(r.address, r.x, r.y, r.mode, now); });
  tx(out);
  return out.length;
}

function computeTokenLayout(){
  const tokens = db.prepare('SELECT id, LOWER(COALESCE(owner,\'\')) AS owner FROM tokens ORDER BY id').all();
  // load wallet centers
  const centers = new Map(db.prepare('SELECT address, x, y FROM wallet_layout').all().map(r=>[(r.address||'').toLowerCase(), [r.x, r.y]]));
  const up = db.prepare('INSERT INTO token_layout (token_id, x, y, mode, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET x=excluded.x, y=excluded.y, mode=excluded.mode, updated_at=excluded.updated_at');
  const now = Math.floor(Date.now()/1000);
  const out = [];
  for (const t of tokens){
    const c = centers.get(t.owner) || [0,0];
    // deterministic orbit per token around owner center
    const seed = hashStr(String(t.id) + ':' + (t.owner||''));
    const rgen = rng(seed);
    const ring = 40 + Math.floor(rgen()*120); // distance from center
    const ang = (rgen()*Math.PI*2);
    const [x,y] = [ c[0] + Math.cos(ang)*ring, c[1] + Math.sin(ang)*ring ];
    out.push({ token_id: t.id, x, y, mode: 'holders' });
  }
  const tx = db.transaction((rows)=>{ for (const r of rows) up.run(r.token_id, r.x, r.y, r.mode, now); });
  tx(out);
  return out.length;
}

try {
  const wc = computeWalletLayout();
  const tc = computeTokenLayout();
  console.log('precompute-layouts complete; wallets:', wc, 'tokens:', tc);
} finally { db.close(); }

