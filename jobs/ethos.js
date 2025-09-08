// Ethos v2 enrichment (no keys). Batches addresses to /score/addresses and /users/by/address
import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ETHOS_API = process.env.ETHOS_API || 'https://api.ethos.network';
const BATCH = Math.min(Math.max(Number(process.env.ETHOS_BATCH || 300), 1), 500);

const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean).map(a => a.toLowerCase()))); }

const ETHOS_HEADERS = { 'content-type': 'application/json', 'accept': 'application/json', 'X-Ethos-Client': 'mammoths-network/1.0' };

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: ETHOS_HEADERS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function rankFromLevel(level) {
  const order = ['untrusted','questionable','neutral','known','established','reputable','exemplary','distinguished','revered','renowned'];
  const i = order.indexOf((level || '').toLowerCase());
  return i >= 0 ? i : null;
}

async function main() {
  // gather top holders and recent traders (bounded)
  const TOP_HOLDERS = Math.min(Math.max(Number(process.env.ETHOS_TOP_HOLDERS || 1000), 1), 5000);
  const RECENT_TRADERS = Math.min(Math.max(Number(process.env.ETHOS_RECENT_TRADERS || 2000), 1), 10000);
  const top = db.prepare(`SELECT LOWER(owner) a FROM tokens WHERE owner IS NOT NULL AND owner<>'' GROUP BY LOWER(owner) ORDER BY COUNT(1) DESC LIMIT ?`).all(TOP_HOLDERS).map(r=>r.a);
  const traders = db.prepare(`
    WITH alladdr AS (
      SELECT LOWER(from_addr) a, timestamp t FROM transfers WHERE from_addr IS NOT NULL AND from_addr<>''
      UNION ALL
      SELECT LOWER(to_addr) a, timestamp t FROM transfers WHERE to_addr IS NOT NULL AND to_addr<>''
    )
    SELECT a FROM alladdr ORDER BY t DESC LIMIT ?
  `).all(RECENT_TRADERS).map(r=>r.a);
  const addrs = uniq([...top, ...traders]);
  if (!addrs.length) { console.log('no addresses to enrich'); return; }

  const up = db.prepare(`
    INSERT INTO wallet_metadata (address, ens_name, ethos_score, ethos_credibility, social_verified, links_profile, links_x, links_fc, total_holdings, first_acquired, last_activity, trade_count, updated_at)
    VALUES (?, COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL), COALESCE(?, NULL),
            (SELECT COUNT(1) FROM tokens WHERE LOWER(owner)=?),
            (SELECT MIN(timestamp) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
            (SELECT MAX(timestamp) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
            (SELECT COUNT(1) FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?),
            CURRENT_TIMESTAMP)
    ON CONFLICT(address) DO UPDATE SET
      ens_name=COALESCE(excluded.ens_name, wallet_metadata.ens_name),
      ethos_score=COALESCE(excluded.ethos_score, wallet_metadata.ethos_score),
      ethos_credibility=COALESCE(excluded.ethos_credibility, wallet_metadata.ethos_credibility),
      social_verified=COALESCE(excluded.social_verified, wallet_metadata.social_verified),
      links_profile=COALESCE(excluded.links_profile, wallet_metadata.links_profile),
      links_x=COALESCE(excluded.links_x, wallet_metadata.links_x),
      links_fc=COALESCE(excluded.links_fc, wallet_metadata.links_fc),
      total_holdings=excluded.total_holdings,
      first_acquired=excluded.first_acquired,
      last_activity=excluded.last_activity,
      trade_count=excluded.trade_count,
      updated_at=CURRENT_TIMESTAMP
  `);

  for (let i = 0; i < addrs.length; i += BATCH) {
    const batch = addrs.slice(i, i + BATCH);
    // Fetch scores
    let scores = {};
    try {
      const s = await postJson(`${ETHOS_API}/api/v2/score/addresses`, { addresses: batch });
      // Expect format: array of { address, score, level }
      if (Array.isArray(s)) {
        for (const r of s) scores[(r.address||'').toLowerCase()] = { score: r.score ?? null, level: r.level ?? null };
      } else if (s && Array.isArray(s.values)) {
        for (const r of s.values) scores[(r.address||'').toLowerCase()] = { score: r.score ?? null, level: r.level ?? null };
      }
    } catch {}
    // Fetch users
    let users = {};
    try {
      const u = await postJson(`${ETHOS_API}/api/v2/users/by/address`, { addresses: batch });
      if (Array.isArray(u)) {
        for (const r of u) {
          const key = Array.isArray(r?.userkeys) ? r.userkeys.find(k => typeof k === 'string' && k.toLowerCase().startsWith('address:')) : null;
          const addr = key ? key.slice('address:'.length).toLowerCase() : (r.address || '').toLowerCase();
          if (addr) users[addr] = r;
        }
      }
    } catch {}

    const tx = db.transaction((arr) => {
      for (const a of arr) {
        const s = scores[a] || {};
        const u = users[a] || {};
        const ensName = u.username || u.displayName || null;
        const links = u.links || {};
        const prof = links.profile || null;
        const lX = links.x || links.twitter || null;
        const lFc = links.fc || links.farcaster || null;
        const verified = (prof || lX || lFc) ? 1 : null;
        const sc = s.score ?? (typeof u.score === 'number' ? u.score : null);
        const cred = rankFromLevel(s.level);
        // Params: address, ens, score, cred, social, links_profile, links_x, links_fc, owner=?, min=?, max=?, count=?
        up.run(a, ensName, sc, cred, verified, prof, lX, lFc, a, a, a, a, a, a, a);
      }
    });
    tx(batch);
    process.stdout.write(`\rens ${Math.min(i+BATCH,addrs.length)}/${addrs.length}`);
  }
  process.stdout.write(`\rens ${addrs.length}/${addrs.length}\n`);

  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'enrich-ethos.txt'), new Date().toISOString());
  console.log('ethos enrichment complete for', addrs.length, 'addresses');
}

try { await main(); } finally { db.close(); }
