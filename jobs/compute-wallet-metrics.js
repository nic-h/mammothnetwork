import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function metricsForWallet(addr){
  const a = (addr||'').toLowerCase();
  const buys = db.prepare(`SELECT token_id, price, timestamp FROM transfers WHERE LOWER(to_addr)=? AND price IS NOT NULL ORDER BY timestamp`).all(a);
  const sells = db.prepare(`SELECT token_id, price, timestamp FROM transfers WHERE LOWER(from_addr)=? AND price IS NOT NULL ORDER BY timestamp`).all(a);
  const buyCount = buys.length;
  const sellCount = sells.length;
  const buyVol = buys.reduce((s,r)=>s+(Number(r.price)||0),0);
  const sellVol = sells.reduce((s,r)=>s+(Number(r.price)||0),0);
  const avgBuy = buyCount? buyVol/buyCount : null;
  const avgSell = sellCount? sellVol/sellCount : null;
  const lastBuy = buyCount? buys[buys.length-1].timestamp : null;
  const lastSell = sellCount? sells[sells.length-1].timestamp : null;
  // Realized PnL by token: sell price - last buy price for same token by this wallet
  const lastBuyByToken = new Map();
  for (const b of buys) lastBuyByToken.set(b.token_id, { price: Number(b.price)||0, ts: b.timestamp });
  let pnl = 0;
  for (const s of sells){
    const got = lastBuyByToken.get(s.token_id);
    if (got && got.price!=null){ pnl += (Number(s.price)||0) - (got.price||0); lastBuyByToken.delete(s.token_id); }
  }
  return { buyCount, sellCount, buyVol, sellVol, avgBuy, avgSell, lastBuy, lastSell, pnl };
}

async function main(){
  console.log('Computing wallet metrics (TIA volumes + PnL)...');
  const wallets = db.prepare(`
    SELECT DISTINCT address FROM wallet_metadata WHERE address IS NOT NULL AND address<>''
  `).all().map(r=>r.address.toLowerCase());
  const update = db.prepare(`
    UPDATE wallet_metadata SET 
      buy_count=?, sell_count=?,
      buy_volume_tia=?, sell_volume_tia=?, realized_pnl_tia=?,
      avg_buy_tia=?, avg_sell_tia=?, last_buy_ts=?, last_sell_ts=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE address=?
  `);
  const tx = db.transaction((rows)=>{
    for (const addr of rows){
      const m = metricsForWallet(addr);
      update.run(
        m.buyCount||0, m.sellCount||0,
        m.buyVol||0, m.sellVol||0, m.pnl||0,
        m.avgBuy, m.avgSell, m.lastBuy, m.lastSell,
        addr
      );
    }
  });
  tx(wallets);
  try { fs.mkdirSync(path.join(ROOT, 'data', '.checkpoints'), { recursive: true }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'compute-wallet-metrics.txt'), new Date().toISOString() + ` wallets=${wallets.length}\n`);
  console.log('Wallet metrics updated for', wallets.length, 'wallets');
}

try { await main(); } finally { db.close(); }

