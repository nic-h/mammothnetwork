import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db, dbPath } = openDatabase(ROOT);
if (!db) {
  console.error('No DB found to migrate. Set DATABASE_PATH or run npm run db:init');
  process.exit(1);
}
runMigrations(db);
db.close();
console.log('Migrations applied to', dbPath);

