import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

// Placeholder: Ingest recent transfers into `transfers` table from cached source.
// Expect an offline process to write CSV/JSON; or hook Modularium if available.

const count = db.prepare('SELECT COUNT(1) c FROM transfers').get().c;
fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-activity.txt'), new Date().toISOString() + ` transfers=${count}\n`);
console.log('sync-activity checkpoint written; transfers present:', count);
db.close();

