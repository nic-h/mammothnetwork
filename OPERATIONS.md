# Operations Runbook

A quick guide for bootstrapping, operating, and recovering the Mammoths Network deploy.

## First Boot (Local or Render Shell)
1. Set environment variables (Render → Dashboard → Service → Environment):
   - `CONTRACT_ADDRESS`
   - `MODULARIUM_API`
   - `ETHOS_API`
   - Optional: `DATABASE_PATH` (default `./data/mammoths.db`), `DOWNLOAD_IMAGES=1`, `ROYALTY_BPS=250`
2. Initialize DB: `npm run db:init`
3. Populate data: `npm run jobs:all`
4. Start app: `npm run dev` (local) or let Render start `npm start`.

## Environment Changes
- Changing `DATABASE_PATH` → rerun `npm run db:init`
- Changing contract/API URLs → re-run `npm run jobs:all` to refresh holdings/activity/metadata
- Adjust job limits via env (`LISTINGS_PAGES`, `ACTIVITY_PAGES`, etc.)

## Routine Refresh
- Weekly cron triggers `node jobs/run-all.js` (see `jobs/run-all.js`).
- Ad hoc run: `npm run jobs:all`

## Health & Stats
- Health: `GET /api/health` (shows DB path; cached `false`)
- Stats: `GET /api/stats` (token count, holder count)

## Recovery
- If transfers seem stale: set `FULL=1` for `jobs/sync-activity.js` to backfill, or delete `data/.checkpoints/sync-activity.since` and rerun.
- If owners seem missing: re-run `jobs/sync-holders.js` (uses Modularium holders endpoint or metadata fallback).
- If Ethos missing: re-run `jobs/ethos.js` (batch mode, no keys required; uses `ETHOS_CLIENT`).
- If listings stale: re-run `jobs/sync-listings.js` (tune `LISTINGS_PAGES`).

## SQLite Sanity
```
sqlite3 ./data/mammoths.db ".tables"
sqlite3 -json ./data/mammoths.db "SELECT (SELECT COUNT(*) FROM tokens) AS tokens,
                                       (SELECT COUNT(*) FROM attributes) AS attrs,
                                       (SELECT COUNT(*) FROM transfers) AS xfers,
                                       (SELECT COUNT(*) FROM wallet_metadata) AS wallets;"
```

## Render Tips
- Use Render “Shell” for one-off migrations or job runs.
- Ensure a persistent disk is mounted and `DATABASE_PATH` points to it (e.g., `/data/mammoths.db`).
- Set adequate timeouts for long-running jobs (backfills) and verify memory limits.

## Troubleshooting
- better-sqlite3 native errors: `npm rebuild better-sqlite3 --build-from-source`
- HTTP 500 from API routes: check server logs and DB availability (`/api/health`).
- Empty graph: verify `/api/preset-data` keys, confirm `jobs:all` ran without errors.
