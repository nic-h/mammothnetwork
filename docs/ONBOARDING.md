# Mammoths Network — Onboarding (Deck.gl)

This is the fastest path to get productive on the project. It assumes Node 20+, git, and SQLite are available locally.

## TL;DR (Run it)
1. Install: `npm ci`
2. Migrate DB: `npm run db:migrate`
3. Backfill data (normalize/metrics): `node scripts/db.backfill.js`
4. Start server: `npm run dev` (defaults to `PORT=3000`)
5. Open deck engine: `http://localhost:3000/?engine=deck`
   - Left/right UI stay the same. Only the center canvas is deck.gl.
   - Keyboard: `1–5` switch views, `R` reset zoom.

If port 3000 is in use: `PORT=3001 npm run dev` or kill: `lsof -i :3000 | awk 'NR>1{print $2}' | xargs kill -9`

## Repo Map
- `public/` — client assets and engines
  - `engine.js` — chooses PIXI or Deck via `?engine=deck|pixi`
  - `deck.app.js` — deck.gl center renderer (Scatterplot/Line/Polygon/Glow)
  - `main.js` — PIXI fallback engine (center canvas)
  - `client/styles/tokens.css` — brand tokens (colors, spacing, font)
- `server/` — Express + SQLite
  - `index.js` — API routes (graph, preset-data, token, listings, traits, story, suspicious)
  - `db.js` — SQLite open/migrations (schema + views)
- `scripts/` — dev scripts
  - `db.migrate.js` — run migrations
  - `db.backfill.js` — address normalization, event_type classification, hold_days/dormant, velocity
  - `ui.screenshots.js` — Playwright screenshots

## Database
Default path: `data/mammoths.db` (override with `DATABASE_PATH=/path/to.db`).

Migrations (safe re-run)
```
npm run db:migrate
```
Backfill / normalize
```
node scripts/db.backfill.js
```
What migrations add (v2)
- Tables: `mint_events`, `token_events`, `wallet_relationships`, `collection_snapshots`
- Columns: `transfers.price_tia/price_usd/price_eth`, `listings.failure_reason/days_listed/relist_count`, `tokens.velocity`
- Views: `token_story`, `suspicious_trades`

Sanity checks
```
sqlite3 ./data/mammoths.db ".tables"
sqlite3 -json ./data/mammoths.db "SELECT 
  (SELECT COUNT(*) FROM tokens) AS tokens,
  (SELECT COUNT(*) FROM transfers) AS transfers,
  (SELECT COUNT(*) FROM wallet_metadata) AS wallets;"
```

Where DB is used
- `server/db.js` — `runMigrations(db)` ensures schema/indices exist.
- `server/index.js` — endpoints pull compact arrays and aggregates:
  - `/api/graph` — nodes/edges with TTL + ETag
  - `/api/preset-data` — compact arrays used by engines
  - `/api/token/:id`, `/api/token/:id/story` — right-panel details + STORY card
  - `/api/transfer-edges`, `/api/suspicious-trades`, `/api/wallet-relationships` — overlays

## Engines
- Deck.gl (default): `http://localhost:3000/?engine=deck`
- PIXI fallback: `http://localhost:3000/?engine=pixi`
- The left and right panels do not change. Only the center canvas swaps engine.

## Views (deck)
- Holders — gravitational clusters with owner hull rings and glow.
- Trading — profit waterfalls, optional flow arcs/particles.
- Traits — constellation lines and wobble clusters; labels on zoom.
- Whales — generational trees (in progress); radial tiers as fallback.
- Health — heatmap + pulses (in progress).

## Screenshots
- Generate desktop snapshots (1440 px):
```
npm run test:ui
```
- Output: `artifacts/ui/*.png`.

## Common Issues
- Red banner “Failed to initialize”: engine loader tried PIXI without pixi.js. Use deck (`?engine=deck`) or make sure `/lib/pixi.min.js` loads before `main.js` (the loader handles this).
- Port already in use: see TL;DR. 
- Empty graph: run migrations/backfill, then hit `/api/health` and `/api/preset-data` to confirm payload.

## Contributing
- Keep left/right UI intact; update only the center engine.
- Prefer brand tokens in CSS; avoid hard-coded colors.
- For DB changes: add to `runMigrations(db)` (idempotent), then update any scripts/endpoints and docs.

## Useful commands
```
# Graph payload
curl -s 'http://localhost:3000/api/graph?mode=holders&nodes=500&edges=0' | jq '.nodes|length'
# Preset arrays
curl -s 'http://localhost:3000/api/preset-data?nodes=500' | jq 'keys'
# Story/relationships
curl -s 'http://localhost:3000/api/token/1/story' | jq .
curl -s 'http://localhost:3000/api/wallet-relationships?min_trades=3' | jq .
```

