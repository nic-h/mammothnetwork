// migrate-db.js: add new columns if missing
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mammoths.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);

function hasColumn(table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name.toLowerCase() === name.toLowerCase());
}

const adds = [];
if (!hasColumn('tokens', 'frozen')) adds.push("ALTER TABLE tokens ADD COLUMN frozen INTEGER DEFAULT 0");
if (!hasColumn('tokens', 'dormant')) adds.push("ALTER TABLE tokens ADD COLUMN dormant INTEGER DEFAULT 0");
if (!hasColumn('tokens', 'last_activity')) adds.push("ALTER TABLE tokens ADD COLUMN last_activity INTEGER");

for (const sql of adds) {
  try { db.exec(sql); console.log('Applied:', sql); } catch (e) { console.warn('Skip:', sql, e.message); }
}

db.close();
console.log('Migration complete.');

