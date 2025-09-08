import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db, dbPath } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

// This job is a placeholder; holders are expected to be cached already in tokens.owner.
// If Modularium or on-chain RPC is configured, integrate here to update tokens.owner.

const updated = db.prepare('SELECT COUNT(1) c FROM tokens WHERE owner IS NOT NULL AND owner<>""').get().c;
fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-holders.txt'), new Date().toISOString() + ` owners=${updated}\n`);
console.log('sync-holders checkpoint written; owners present:', updated);
db.close();

