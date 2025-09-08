import fs from 'fs';
import path from 'path';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

// Create wallet_metadata if missing; compute local stats (no external APIs)
db.exec(`CREATE TABLE IF NOT EXISTS wallet_metadata (
  address TEXT PRIMARY KEY,
  ens_name TEXT,
  ethos_score REAL,
  ethos_credibility REAL,
  social_verified INTEGER,
  total_holdings INTEGER,
  first_acquired INTEGER,
  last_activity INTEGER,
  trade_count INTEGER,
  updated_at DATETIME
);`);

const addresses = db.prepare(`
  WITH a AS (
    SELECT LOWER(owner) AS addr FROM tokens WHERE owner IS NOT NULL AND owner<>''
    UNION
    SELECT LOWER(from_addr) FROM transfers WHERE from_addr IS NOT NULL AND from_addr<>''
    UNION
    SELECT LOWER(to_addr) FROM transfers WHERE to_addr IS NOT NULL AND to_addr<>''
  ) SELECT addr FROM a WHERE addr IS NOT NULL AND addr<>''
`).all().map(r => r.addr);

const qHoldings = db.prepare('SELECT COUNT(1) AS c FROM tokens WHERE LOWER(owner)=?');
const qFirstAct = db.prepare('SELECT MIN(timestamp) AS t FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?');
const qLastAct = db.prepare('SELECT MAX(timestamp) AS t FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?');
const qTrades = db.prepare('SELECT COUNT(1) AS c FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?');
const upMeta = db.prepare(`
  INSERT INTO wallet_metadata (address, ens_name, ethos_score, ethos_credibility, social_verified, total_holdings, first_acquired, last_activity, trade_count, updated_at)
  VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(address) DO UPDATE SET
    total_holdings=excluded.total_holdings,
    first_acquired=excluded.first_acquired,
    last_activity=excluded.last_activity,
    trade_count=excluded.trade_count,
    updated_at=CURRENT_TIMESTAMP
`);

const tx = db.transaction((addrs) => {
  for (const a of addrs) {
    const holdings = qHoldings.get(a).c;
    const first = qFirstAct.get(a, a).t || null;
    const last = qLastAct.get(a, a).t || null;
    const trades = qTrades.get(a, a).c;
    upMeta.run(a, holdings, first, last, trades);
  }
});
tx(addresses);

fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'enrich-wallets.txt'), new Date().toISOString() + ` wallets=${addresses.length}\n`);
console.log('enrich-wallets complete; wallets:', addresses.length);
db.close();
