// update-owners-modapi.js
// Use Modularium holders API to set owners and frozen flags quickly (no on-chain calls).
// Usage: node update-owners-modapi.js

const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const CONTRACT = process.env.CONTRACT_ADDRESS || '0xbE25A97896b9CE164a314C70520A4df55979a0c6';
const API = process.env.MOD_API || 'https://api.modularium.art';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');

if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }

const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL');

async function j(url) { const r = await fetch(url, { headers:{'user-agent':'mammoths-network/owners/1.0'} }); if(!r.ok) throw new Error(r.status+' '+url); return r.json(); }

async function run() {
  console.log('Fetching holders from Modularium...');
  const rows = await j(`${API}/collection/${CONTRACT}/holders`).catch(async () => await j(`${API}/collection/${CONTRACT}/minters`));
  if (!Array.isArray(rows) || !rows.length) throw new Error('No holders/minters from API');

  const up = db.prepare('UPDATE tokens SET owner=?, frozen=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');

  // rows can be either {owner, tokenId, balance, frozenBalance} or {minter, tokenId, minted}
  let count=0; for (const r of rows) {
    const owner = (r.owner || r.minter || '').toLowerCase();
    const tokenId = Number(r.tokenId || 0);
    if (!owner || !tokenId) continue;
    const frozen = Number(r.frozenBalance || 0) > 0 ? 1 : 0;
    up.run(owner, frozen, tokenId); count++;
  }
  console.log('Updated owner/frozen for', count, 'rows');
}

run().catch(e=>{ console.error(e); process.exit(1); }).finally(()=>db.close());

