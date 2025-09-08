import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export function openDatabase(rootDir) {
  const envPath = process.env.DATABASE_PATH;
  const defaultPath = path.join(rootDir, 'data', 'mammoths.db');
  const dbPath = envPath ? envPath : defaultPath;

  let db = null;
  if (fs.existsSync(dbPath)) {
    db = new Database(dbPath, { fileMustExist: true });
  }
  return { db, dbPath };
}

export function runMigrations(db) {
  if (!db) return;
  db.pragma('journal_mode = WAL');
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
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER,
      from_addr TEXT,
      to_addr TEXT,
      timestamp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_token_time ON transfers (token_id, timestamp);
    CREATE TABLE IF NOT EXISTS graph_cache (
      key TEXT PRIMARY KEY,
      etag TEXT,
      payload TEXT,
      updated_at DATETIME
    );
  `);
}
