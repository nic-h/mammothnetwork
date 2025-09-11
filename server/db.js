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
  try { db.pragma('busy_timeout = 5000'); } catch {}
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
    -- Listings for active and historical marketplace asks
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      price REAL,
      platform TEXT,
      marketplace TEXT,
      listed_at INTEGER,
      delisted_at INTEGER,
      status TEXT,
      seller_address TEXT,
      updated_at INTEGER,
      UNIQUE(token_id, listed_at, platform)
    );
    CREATE INDEX IF NOT EXISTS idx_listings_token ON listings(token_id);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_time ON listings(listed_at, delisted_at);
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
    -- Lean Ethos cache per wallet
    CREATE TABLE IF NOT EXISTS ethos_profiles (
      wallet TEXT PRIMARY KEY,
      has_ethos INTEGER NOT NULL DEFAULT 0,
      profile_json TEXT,
      updated_at INTEGER
    );
    -- Token similarity cache
    CREATE TABLE IF NOT EXISTS token_similarity (
      token_a INTEGER,
      token_b INTEGER,
      similarity REAL,
      similarity_type TEXT,
      PRIMARY KEY (token_a, token_b, similarity_type)
    );
    CREATE INDEX IF NOT EXISTS idx_similarity_high ON token_similarity(similarity);
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
      { name: 'wallet_type', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN wallet_type TEXT' },
      { name: 'avg_hold_days', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN avg_hold_days REAL' },
      { name: 'flip_ratio', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN flip_ratio REAL' },
      { name: 'buy_count', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN buy_count INTEGER DEFAULT 0' },
      { name: 'sell_count', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN sell_count INTEGER DEFAULT 0' },
      { name: 'buy_volume_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN buy_volume_tia REAL' },
      { name: 'sell_volume_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN sell_volume_tia REAL' },
      { name: 'realized_pnl_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN realized_pnl_tia REAL' },
      { name: 'avg_buy_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN avg_buy_tia REAL' },
      { name: 'avg_sell_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN avg_sell_tia REAL' },
      { name: 'last_buy_ts', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN last_buy_ts INTEGER' },
      { name: 'last_sell_ts', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN last_sell_ts INTEGER' },
      { name: 'unrealized_pnl_tia', ddl: 'ALTER TABLE wallet_metadata ADD COLUMN unrealized_pnl_tia REAL' },
    ];
    for (const c of want2) if (!cols2.includes(c.name)) db.exec(c.ddl);
  } catch {}
}
