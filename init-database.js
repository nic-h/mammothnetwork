const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

for (const dir of ['./data', './data/images', './data/thumbnails']) {
  fs.mkdirSync(dir, { recursive: true });
}

const dbPath = path.join(__dirname, 'data', 'mammoths.db');
const db = new Database(dbPath);

// tables
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  owner TEXT,
  token_uri TEXT,
  name TEXT,
  description TEXT,
  image_url TEXT,
  image_local TEXT,
  thumbnail_local TEXT,
  metadata TEXT,
  attributes TEXT,
  frozen INTEGER DEFAULT 0,
  dormant INTEGER DEFAULT 0,
  last_activity INTEGER,
  updated_at DATETIME
);
CREATE TABLE IF NOT EXISTS attributes (
  token_id INTEGER,
  trait_type TEXT,
  trait_value TEXT,
  PRIMARY KEY (token_id, trait_type, trait_value)
);
CREATE INDEX IF NOT EXISTS idx_attr_type ON attributes (trait_type);
CREATE INDEX IF NOT EXISTS idx_attr_type_value ON attributes (trait_type, trait_value);
CREATE TABLE IF NOT EXISTS collection_stats (
  id INTEGER PRIMARY KEY,
  total_supply INTEGER,
  floor_price REAL,
  holders INTEGER,
  updated_at DATETIME
);
INSERT OR IGNORE INTO collection_stats (id, total_supply, floor_price, holders, updated_at)
VALUES (1, 0, 0, 0, CURRENT_TIMESTAMP);
PRAGMA journal_mode=WAL;
`);

console.log('DB ready at', dbPath);
db.close();
