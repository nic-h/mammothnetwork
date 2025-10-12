Mammoths Network Integration Audit
=================================

Scope
- Integrate Three.js force-directed renderer into existing repo
- Use existing SQLite cache (tokens, attributes, images) without data loss
- Add jobs for holders/activity/edges/enrichment
- Add API with ETag + 5‑min memory cache
- Prepare Render deploy with persistent disk and cron guidance

Findings (repo state)
- DB files present: `data/mammoths.db-wal`, `data/mammoths.db-shm` but main `data/mammoths.db` is missing.
- Images and thumbnails present under `data/images` and `data/thumbnails`.
- No framework lock-in; simple Node scripts exist in the reference repo for init and fetching.

Decisions
- Standardize env var to `DATABASE_PATH` (fallback to `DB_PATH` still supported).
- Add idempotent migrations (only create missing tables/indexes; do not drop/alter existing data).
- Introduce `graph_cache` with `etag` for cached graph payloads.
- Keep runtime images unused for node rendering (colored dots only).

Migrations
- Create tables if missing: `tokens`, `attributes`, `collection_stats`, `transfers`, `graph_cache`, `wallets`.
- Add indices for attributes and transfers for query speed.

Jobs
- `jobs/sync-holders.js`: placeholder (expects holders in `tokens.owner`, writes checkpoint).
- `jobs/sync-activity.js`: placeholder for ingesting transfers, writes checkpoint.
- `jobs/enrich-wallets.js`: creates `wallets` table and seeds from distinct owners.
- `jobs/compute-edges.js`: computes bounded-degree edges for mode holders|transfers|traits and stores in `graph_cache`.
- `jobs/run-all.js`: orchestrates the above (safe/idempotent).

API
- `GET /api/network-graph` (alias `/api/graph`): uses memory cache (5m), ETag, DB-backed `graph_cache` with edge cap 500.
- `GET /api/token/:id`: returns token row (+attributes JSON).
- `GET /api/wallet/:address`: returns token ids owned.
- `GET /api/stats`: includes counts and holders if available.
- `GET /api/activity`: lightweight stub.
- `GET /api/health`: status and DB path.

Frontend (Three.js)
- Engine bundles from `client/three/app.js` → `public/three.app.js` (esbuild).
- ForceGraph3D nodes rendered via custom sprite textures; additive glow and whale bubble scaling options.
- Edge modes cover ownership, transfers, sales, mints, and trait links with zoom-aware throttling.
- Timeline/preset toggles managed in vanilla JS UI; cluster mode leverages d3-hierarchy helpers.

Performance alignment
- Initial load: fast path uses cached `graph_cache` and Brotli/gzip compression (shrink-ray-current).
- Runtime rendering: 10k sprites at 60fps (no images), worker tick ~30Hz.
- Transitions between modes under 800ms when data cached.

Render deploy
- `render.yaml` includes persistent disk at `/data` and Node runtime.
- Cron/Jobs: add a Render Cron Job (separate service) to run `node jobs/run-all.js` weekly; see README.

Pre-merge checklist
- [x] No Canvas 2D or per-node image rendering in UI.
- [x] No heavy build tooling; plain Express + static files.
- [x] Standard DB path via `DATABASE_PATH` with fallback.
- [x] `/api/health` present.
- [x] Edge cap 500 enforced at API + UI.
- [x] Memory cache (5 min) + ETag.
- [x] Brotli/gzip enabled.
- [x] Degree caps and rarity threshold in edge builders.
- [x] Three.js force graph only

Open items / optional
- Hook Modularium client or RPC to fill holders/transfers offline.
- Optionally precompute multiple graphs (modes) for instant switching.
- If DB is still absent, run `npm run db:init` then populate using your existing scripts or the reference repo procedures.
