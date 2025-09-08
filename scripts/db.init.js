import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const d of ['data', 'data/images', 'data/thumbnails', 'data/.checkpoints']) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

const { db, dbPath } = openDatabase(ROOT);
if (!db) {
  // create a new DB at default path
  const p = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'mammoths.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const Database = (await import('better-sqlite3')).default;
  const created = new Database(p);
  runMigrations(created);
  created.close();
  console.log('Initialized DB at', p);
} else {
  runMigrations(db);
  db.close();
  console.log('DB ready at', dbPath);
}

