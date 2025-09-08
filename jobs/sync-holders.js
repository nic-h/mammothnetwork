import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';
import { fetchCollectionStats, fetchTokenIds, fetchHolders, fetchHoldersViaMetadata, envEnabled } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

async function main() {
  const enabled = envEnabled();
  if (!enabled) {
    console.log('Modularium not configured; skipping network. Set MODULARIUM_API and CONTRACT_ADDRESS.');
    const updated = db.prepare("SELECT COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>''").get().c;
    fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-holders.txt'), new Date().toISOString() + ` owners=${updated}\n`);
    return;
  }

  // Ensure tokens exist; if not, seed ids from Modularium without metadata
  const tokenCount = db.prepare('SELECT COUNT(1) c FROM tokens').get().c;
  if (tokenCount < 100) {
    const ids = await fetchTokenIds();
    const insert = db.prepare('INSERT OR IGNORE INTO tokens (id, updated_at) VALUES (?, CURRENT_TIMESTAMP)');
    const tx = db.transaction((arr) => { for (const id of arr) insert.run(id); });
    tx(ids);
    console.log('Seeded token ids:', ids.length);
  }

  // Prefer bulk holders endpoint; fallback to metadata fanout
  const bulk = await fetchHolders().catch(() => []);
  if (bulk && bulk.length) {
    const up = db.prepare('UPDATE tokens SET owner=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
    const tx = db.transaction((arr) => {
      for (const r of arr) {
        const id = Number(r.tokenId || r.id);
        const o = (r.owner || '').toLowerCase();
        if (id > 0 && o) up.run(o, id);
      }
    });
    tx(bulk);
    console.log('Holders bulk applied:', bulk.length);
  } else {
    const ids = db.prepare('SELECT id FROM tokens ORDER BY id').all().map(r => r.id);
    const map = await fetchHoldersViaMetadata(ids, { concurrency: Number(process.env.MOD_CONC || 8) });
    const up = db.prepare('UPDATE tokens SET owner=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
    const tx2 = db.transaction((entries) => { for (const [id, owner] of entries) up.run(owner, id); });
    tx2(map.entries());
  }

  // holders stat
  const holders = db.prepare("SELECT COUNT(DISTINCT LOWER(owner)) c FROM tokens WHERE owner IS NOT NULL AND owner<>''").get().c;
  db.prepare('UPDATE collection_stats SET holders=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(holders);
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-holders.txt'), new Date().toISOString() + ` owners=${holders}\n`);
  console.log('sync-holders complete; holders:', holders);
}

try { await main(); } finally { db.close(); }
