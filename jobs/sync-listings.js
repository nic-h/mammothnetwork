import 'dotenv/config';
import { openDatabase, runMigrations } from '../server/db.js';
import { fetchListings } from './modularium.js';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

async function main() {
  console.log('Syncing listings from Modularium...');

  const upsert = db.prepare(`
    INSERT INTO listings (token_id, price, platform, marketplace, listed_at, delisted_at, status, seller_address, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_id, listed_at, platform) DO UPDATE SET
      price = excluded.price,
      delisted_at = excluded.delisted_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  let total = 0;
  const maxPages = Number(process.env.LISTINGS_PAGES || 50);

  for (let page = 1; page <= maxPages; page++) {
    try {
      const listings = await fetchListings({ page, limit: 1000 });
      if (!listings.length) break;

      const tx = db.transaction((items) => {
        for (const it of items) {
          upsert.run(
            it.token_id,
            it.price,
            it.platform,
            it.platform,
            it.listed_at,
            it.delisted_at,
            it.status,
            it.seller,
            Math.floor(Date.now()/1000)
          );
        }
      });
      tx(listings);
      total += listings.length;
      process.stdout.write(`\rListings synced: ${total} (page ${page})`);
    } catch (e) {
      console.error(`\nPage ${page} failed:`, e.message);
      break;
    }
  }

  // Mark older active listings as expired (30d)
  db.prepare(`
    UPDATE listings
    SET status='expired', delisted_at=?
    WHERE status='active' AND listed_at < ? AND delisted_at IS NULL
  `).run(Math.floor(Date.now()/1000), Math.floor(Date.now()/1000) - 30*86400);

  console.log(`\nListings sync complete: ${total} listings`);

  // Derive desire paths summary (>3 listings not sold)
  const desire = db.prepare(`
    SELECT token_id, COUNT(*) AS list_count, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price
    FROM listings WHERE status <> 'sold' GROUP BY token_id HAVING list_count > 3 ORDER BY list_count DESC
  `).all();
  console.log(`Found ${desire.length} tokens with desire paths (listed 3+ times)`);

  try { fs.mkdirSync(path.join(ROOT, 'data', '.checkpoints'), { recursive: true }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-listings.txt'), new Date().toISOString() + ` listings=${total}\n`);
}

try { await main(); } finally { db.close(); }
