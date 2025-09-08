// fetch-owners.js
// Fills `tokens.owner` by calling ERC721 ownerOf on-chain.
// Usage:
//   RPC_URL=https://<your-rpc> node fetch-owners.js
// Optional env:
//   DATA_DIR=./data           Where mammoths.db lives
//   CONCURRENCY=5             Parallel ownerOf calls
//   BATCH_DELAY_MS=300        Sleep between chunks
//   START_ID=1 END_ID=10000   Restrict id range (optional)

const Database = require('better-sqlite3');
const pLimit = require('p-limit');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error('Missing RPC_URL. Example:');
  console.error('  $env:RPC_URL = "https://<your-rpc>"; npm run fetch-owners');
  process.exit(1);
}

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0xbE25A97896b9CE164a314C70520A4df55979a0c6';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 300);
const START_ID = process.env.START_ID ? Number(process.env.START_ID) : null;
const END_ID = process.env.END_ID ? Number(process.env.END_ID) : null;

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

async function rpcCall(method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

function hexPad64(n) {
  const h = BigInt(n).toString(16);
  return h.padStart(64, '0');
}

async function ownerOf(tokenId) {
  // ownerOf(uint256) -> 0x6352211e
  const data = '0x6352211e' + hexPad64(tokenId);
  const result = await rpcCall('eth_call', [{ to: CONTRACT_ADDRESS, data }, 'latest']).catch(() => null);
  if (!result || result === '0x') return null;
  const clean = result.replace(/^0x/, '');
  if (clean.length < 64) return null;
  const addr = '0x' + clean.slice(clean.length - 40);
  return addr.toLowerCase();
}

const qAllIds = db.prepare('SELECT id FROM tokens ORDER BY id');
const upOwner = db.prepare('UPDATE tokens SET owner=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
const qCountDistinctOwners = db.prepare('SELECT COUNT(DISTINCT LOWER(COALESCE(owner, ""))) AS c FROM tokens WHERE owner IS NOT NULL AND owner <> ""');
const updateStats = db.prepare('UPDATE collection_stats SET holders=?, updated_at=CURRENT_TIMESTAMP WHERE id=1');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const idsRaw = qAllIds.all().map(r => r.id);
  const ids = idsRaw.filter(id => (START_ID ? id >= START_ID : true) && (END_ID ? id <= END_ID : true));
  console.log(`Owner fill: ${ids.length} ids  (concurrency=${CONCURRENCY})  RPC=${RPC_URL}`);

  const limit = pLimit(CONCURRENCY);
  let done = 0, ok = 0, fail = 0;

  for (let i = 0; i < ids.length; i += CONCURRENCY * 4) {
    const batch = ids.slice(i, i + CONCURRENCY * 4);
    await Promise.all(batch.map(id => limit(async () => {
      try {
        const addr = await ownerOf(id);
        upOwner.run(addr, id);
        ok++;
      } catch (e) {
        fail++;
      } finally {
        done++;
        if (done % 200 === 0) {
          process.stdout.write(`\rProgress ${done}/${ids.length}  ok=${ok} fail=${fail}`);
        }
      }
    })));

    if (i + CONCURRENCY * 4 < ids.length) await sleep(BATCH_DELAY_MS);
  }
  process.stdout.write(`\rProgress ${done}/${ids.length}  ok=${ok} fail=${fail}\n`);

  // update holders stat
  const holders = qCountDistinctOwners.get().c;
  updateStats.run(holders);
  console.log('Distinct holders:', holders);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.close());
