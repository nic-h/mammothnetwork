import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export function openDatabase(rootDir) {
  const envPath = process.env.DATABASE_PATH;
  const defaultPath = path.join(rootDir, 'data', 'mammoths.db');
  const dbPath = envPath ? envPath : defaultPath;

  // Create if missing at default path; if env provided and missing, also create unless READONLY
  const mustExist = false;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, { fileMustExist: mustExist });
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
    CREATE TABLE IF NOT EXISTS wallet_metadata (
      address TEXT PRIMARY KEY,
      ens_name TEXT,
      ethos_score REAL,
      ethos_credibility REAL,
      social_verified INTEGER,
      links_profile TEXT,
      links_x TEXT,
      links_fc TEXT,
      total_holdings INTEGER,
      first_acquired INTEGER,
      last_activity INTEGER,
      trade_count INTEGER,
      updated_at DATETIME
    );
  `);

  // Conditional column adds for transfers (price, tx_hash, event_type)
  try {
    const cols = db.prepare(`PRAGMA table_info(transfers)`).all().map(c => c.name);
    const want = [
      { name: 'price', ddl: 'ALTER TABLE transfers ADD COLUMN price REAL' },
      { name: 'tx_hash', ddl: 'ALTER TABLE transfers ADD COLUMN tx_hash TEXT' },
      { name: 'event_type', ddl: 'ALTER TABLE transfers ADD COLUMN event_type TEXT' },
    ];
    for (const c of want) if (!cols.includes(c.name)) db.exec(c.ddl);
  } catch {}

  // Conditional columns for wallet_metadata links/social
  try {
    const cols2 = db.prepare(`PRAGMA table_info(wallet_metadata)`).all().map(c => c.name);
    const want2 = [
      { name: 'links_profile', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN links_profile TEXT' },
      { name: 'links_x', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN links_x TEXT' },
      { name: 'links_fc', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN links_fc TEXT' },
      { name: 'social_verified', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN social_verified INTEGER' },
    ];
    for (const c of want2) if (!cols2.includes(c.name)) db.exec(c.ddl);
  } catch {}
}
