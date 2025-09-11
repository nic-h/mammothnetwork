import 'dotenv/config';
import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function classifyWallet(address){
  const addr = (address||'').toLowerCase();
  const holdings = db.prepare('SELECT COUNT(1) AS c FROM tokens WHERE LOWER(owner)=?').get(addr).c;
  const trades = db.prepare(`
    SELECT COUNT(1) as total,
           SUM(CASE WHEN LOWER(from_addr)=? THEN 1 ELSE 0 END) as sells,
           SUM(CASE WHEN LOWER(to_addr)=? THEN 1 ELSE 0 END) as buys,
           AVG(price) as avg_price,
           MAX(price) as max_price
    FROM transfers
    WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?
  `).get(addr, addr, addr, addr);
  const lastTrade = db.prepare('SELECT MAX(timestamp) AS t FROM transfers WHERE LOWER(from_addr)=? OR LOWER(to_addr)=?').get(addr, addr).t || null;

  const now = Math.floor(Date.now()/1000);
  const holdRows = db.prepare(`
    SELECT t1.token_id, t1.timestamp AS acquired,
           COALESCE((SELECT MIN(t2.timestamp) FROM transfers t2 WHERE t2.token_id=t1.token_id AND t2.timestamp>t1.timestamp AND LOWER(t2.from_addr)=?), ?) AS sold,
           COALESCE((SELECT MIN(t2.timestamp) FROM transfers t2 WHERE t2.token_id=t1.token_id AND t2.timestamp>t1.timestamp AND LOWER(t2.from_addr)=?), ?) - t1.timestamp AS hold_time
    FROM transfers t1
    WHERE LOWER(t1.to_addr)=?
  `).all(addr, now, addr, now, addr);
  const avgHoldDays = holdRows.length ? holdRows.reduce((s, r)=>s+(r.hold_time||0),0)/holdRows.length/86400 : 0;
  const buyCount = trades.buys || 0;
  const sellCount = trades.sells || 0;
  const totalTrades = trades.total || 0;
  const sellRatio = totalTrades ? sellCount / totalTrades : 0;
  const flipRatio = (buyCount + sellCount) ? sellCount / (buyCount + sellCount) : 0;

  let walletType = 'casual';
  // Flipper: frequent selling with short holds
  if (sellCount >= 3 && avgHoldDays <= 30 && (flipRatio >= 0.6 || sellCount >= buyCount)) walletType = 'flipper';
  // Diamond hands: long holds, low sell ratio, and stale recent activity
  else if (avgHoldDays >= 180 && sellRatio <= 0.2 && (!lastTrade || (now - lastTrade) > 180*86400)) walletType = 'diamond_hands';
  // Collector: sizeable holdings and low sell pressure
  else if (holdings >= 10 && sellRatio <= 0.3) walletType = 'collector';
  // Whale trader: high ticket trades
  else if ((trades.max_price||0) >= 5) walletType = 'whale_trader';
  // Holder: no trades but currently holds
  else if (totalTrades === 0 && holdings > 0) walletType = 'holder';
  // Accumulator: buys much more than sells and growing holdings
  else if (buyCount >= Math.max(3, sellCount*2)) walletType = 'accumulator';

  return { type: walletType, avgHoldDays, flipRatio, buyCount, sellCount };
}

async function main(){
  console.log('Classifying wallet behaviors...');
  const wallets = db.prepare(`
    SELECT DISTINCT address FROM (
      SELECT LOWER(owner) AS address FROM tokens WHERE owner IS NOT NULL AND owner<>''
      UNION
      SELECT LOWER(from_addr) AS address FROM transfers WHERE from_addr IS NOT NULL AND from_addr<>''
      UNION
      SELECT LOWER(to_addr) AS address FROM transfers WHERE to_addr IS NOT NULL AND to_addr<>''
    )
  `).all();

  const update = db.prepare(`
    UPDATE wallet_metadata
    SET wallet_type=?, avg_hold_days=?, flip_ratio=?, buy_count=?, sell_count=?, updated_at=CURRENT_TIMESTAMP
    WHERE address=?
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO wallet_metadata (address, wallet_type, avg_hold_days, flip_ratio, buy_count, sell_count, updated_at)
    VALUES (?,?,?,?,?, ?, CURRENT_TIMESTAMP)
  `);

  const counts = { flipper:0, diamond_hands:0, collector:0, whale_trader:0, holder:0, accumulator:0, casual:0 };

  const tx = db.transaction((rows)=>{
    for (const w of rows){
      const c = classifyWallet(w.address);
      const r = update.run(c.type, c.avgHoldDays, c.flipRatio, c.buyCount, c.sellCount, w.address);
      if (r.changes === 0) insert.run(w.address, c.type, c.avgHoldDays, c.flipRatio, c.buyCount, c.sellCount);
      counts[c.type]++;
    }
  });
  tx(wallets);

  console.log('\nWallet classifications:');
  for (const [k,v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  try { fs.mkdirSync(path.join(ROOT, 'data', '.checkpoints'), { recursive: true }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'classify-wallets.txt'), new Date().toISOString() + ` total=${wallets.length}\n`);
}

try { await main(); } finally { db.close(); }
