import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

// Placeholder: add a wallets table if missing and enrich labels via cached sources
db.exec(`CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, label TEXT, updated_at DATETIME);`);
const distinct = db.prepare('SELECT DISTINCT LOWER(owner) AS a FROM tokens WHERE owner IS NOT NULL AND owner<>""').all();
const up = db.prepare('INSERT OR IGNORE INTO wallets (address, label, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)');
let added = 0;
for (const r of distinct) { added += up.run(r.a, null).changes; }
fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'enrich-wallets.txt'), new Date().toISOString() + ` wallets=${distinct.length}\n`);
console.log('enrich-wallets checkpoint written; wallet rows:', distinct.length, 'added', added);
db.close();

