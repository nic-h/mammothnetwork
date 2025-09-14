import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { openDatabase, runMigrations } from '../server/db.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function buildLastTradePriceMap(){
  const rows = db.prepare(`
    SELECT t1.token_id, t1.price FROM transfers t1
    JOIN (
      SELECT token_id, MAX(timestamp) AS ts FROM transfers WHERE price IS NOT NULL GROUP BY token_id
    ) t2 ON t1.token_id=t2.token_id AND t1.timestamp=t2.ts
  `).all();
  const map = new Map();
  for (const r of rows) map.set(r.token_id, Number(r.price)||0);
  return map;
}

function metricsForWallet(addr, lastPriceByToken){
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
  // Realized/Unrealized PnL by token using FIFO lots and royalty deduction on sales
  const ROYALTY_BPS = Number(process.env.ROYALTY_BPS || 250); // 2.5% default
  const royaltyRate = Math.max(0, ROYALTY_BPS) / 10000;
  const fifo = new Map(); // token_id -> array of buy lots (oldest first)
  for (const b of buys){
    const arr = fifo.get(b.token_id) || [];
    arr.push({ price: Number(b.price)||0, ts: b.timestamp });
    fifo.set(b.token_id, arr);
  }
  let realized = 0;
  for (const s of sells){
    const sale = Number(s.price)||0;
    const arr = fifo.get(s.token_id) || [];
    let basis = 0;
    if (arr.length){ basis = arr.shift().price; }
    // net seller proceeds after royalty
    const netSale = sale * (1 - royaltyRate);
    realized += (netSale - basis);
    fifo.set(s.token_id, arr);
  }
  // Unrealized: remaining lots valued at latest trade price net of royalty
  let unreal = 0;
  for (const [tok, lots] of fifo.entries()){
    if (!lots || !lots.length) continue;
    const mark = Number(lastPriceByToken.get(tok) || 0);
    if (!isFinite(mark) || mark<=0) continue; // skip if unknown
    const netMark = mark * (1 - royaltyRate);
    for (const lot of lots){ unreal += (netMark - (Number(lot.price)||0)); }
  }
  return { buyCount, sellCount, buyVol, sellVol, avgBuy, avgSell, lastBuy, lastSell, pnl: realized, upnl: unreal };
}

async function main(){
  console.log('Computing wallet metrics (TIA volumes + PnL)...');
  const wallets = db.prepare(`
    SELECT DISTINCT address FROM wallet_metadata WHERE address IS NOT NULL AND address<>''
  `).all().map(r=>r.address.toLowerCase());
  const lastPriceByToken = buildLastTradePriceMap();
  const update = db.prepare(`
    UPDATE wallet_metadata SET 
      buy_count=?, sell_count=?,
      buy_volume_tia=?, sell_volume_tia=?, realized_pnl_tia=?,
      avg_buy_tia=?, avg_sell_tia=?, last_buy_ts=?, last_sell_ts=?, unrealized_pnl_tia=?,
      degree=?, buy_volume_30d_tia=?, sell_volume_30d_tia=?, volume_30d_tia=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE address=?
  `);
  // helpers for 30d window + degree
  const nowSec = Math.floor(Date.now()/1000);
  const win30 = nowSec - 30*86400;
  const qBuy30 = db.prepare('SELECT COALESCE(SUM(price),0) v FROM transfers WHERE price IS NOT NULL AND LOWER(to_addr)=? AND timestamp>=?');
  const qSell30 = db.prepare('SELECT COALESCE(SUM(price),0) v FROM transfers WHERE price IS NOT NULL AND LOWER(from_addr)=? AND timestamp>=?');
  const qDegree = db.prepare(`
    SELECT COUNT(DISTINCT CASE WHEN LOWER(from_addr)=? THEN LOWER(to_addr) ELSE LOWER(from_addr) END) AS d
    FROM transfers WHERE (LOWER(from_addr)=? OR LOWER(to_addr)=?) AND (from_addr IS NOT NULL AND from_addr<>'' AND to_addr IS NOT NULL AND to_addr<>'')
  `);

  const tx = db.transaction((rows)=>{
    for (const addr of rows){
      const m = metricsForWallet(addr, lastPriceByToken);
      const b30 = qBuy30.get(addr, win30).v || 0;
      const s30 = qSell30.get(addr, win30).v || 0;
      const deg = qDegree.get(addr, addr, addr).d || 0;
      update.run(
        m.buyCount||0, m.sellCount||0,
        m.buyVol||0, m.sellVol||0, m.pnl||0,
        m.avgBuy, m.avgSell, m.lastBuy, m.lastSell, m.upnl||0,
        deg, b30, s30, (b30 + s30),
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
