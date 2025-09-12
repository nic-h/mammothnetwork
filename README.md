Mammoths Network Visualization
=============================

WebGL network for the Mammoths NFT collection.

At‑a‑Glance System Overview
- Frontend: PIXI.js v7 renders 10k token nodes (colored circles) with thin, layered edges; unified “Views” selector toggles Ownership, Trading, Traits, Whales, Health.
- Backend: Express + SQLite (better-sqlite3). `/api/graph` delivers nodes/edges; `/api/preset-data` provides compact arrays for fast view encoding; ETag + TTL cache.
- Data sources: Modularium API (holders, activity/transfers, listings), Ethos API (scores/users). Jobs fetch and cache into SQLite; UI reads only from DB.
- Storage: images/thumbnails on disk (optional); no per-node images in the graph, only in the sidebar.
- Deployment: Render.com with persistent disk; weekly cron refreshes data (see `jobs/run-all.js`).

Current Status
- PIXI v7 WebGL (UMD at `/lib/pixi.min.js`), 10k nodes via `PIXI.ParticleContainer`
- Deterministic layouts (grid default + preset-specific)
- Modes: `holders`, `transfers`, `traits`, `wallets`
- Presets (6): Ownership, Trading, Rarity, Social, Whales, Frozen
- Transfers mode now uses transaction-aware edges:
  - Sales: solid red with arrowheads (→ buyer)
  - Transfers: dashed blue
  - Mints: dotted white
  - Multiple trades between same parties: thicker gold
  - Layer toggles: Sales / Transfers / Mints (plus Ownership/Trades/Traits/Value)
- Sidebar: owner, ENS, Ethos (strict ACTIVE/profileId/profile link), holdings, trades, last activity, traits, thumbnail
- Styling: black + brand green (#00ff66), frozen blue (#4488ff), dormant gray (#666666)
- Header is sticky (40px row); grid background alpha ≈ 0.12

Local setup
1. `npm install`
2. `npm run db:init`
3. Populate (idempotent):
   - `export CONTRACT_ADDRESS=0xbE25A97896b9CE164a314C70520A4df55979a0c6`
   - `export MODULARIUM_API=https://api.modularium.art`
   - `export ETHOS_API=https://api.ethos.network`
   - Optional: `export DOWNLOAD_IMAGES=1`
   - `npm run jobs:all`
4. `npm run dev` → http://localhost:3000

Environment
- Required: `CONTRACT_ADDRESS`, `MODULARIUM_API`, `ETHOS_API`
- Optional: `DATABASE_PATH` (default `./data/mammoths.db`), `DOWNLOAD_IMAGES=1`, `ROYALTY_BPS` (default `250`), and job tuning vars (see Jobs & Data Flow)

Endpoints
- `/api/network-graph?mode=holders|transfers|traits|wallets&nodes=10000&edges=0..500` (alias `/api/graph`)
- `/api/preset-data?nodes=10000`
- `/api/token/:id`
  - Includes token sales/hold metrics: `sale_count`, `avg_sale_price`, `last_sale_price`, `first_sale_ts`, `last_sale_ts`, `last_acquired_ts`, `last_buy_price`, `hold_days`.
- `/api/wallet/:address`, `/api/wallet/:address/meta`
- `/api/ethos/profile?address=0x…` (v2 user + score)
- `/api/activity?interval=day|hour`, `/api/heatmap`, `/api/stats`, `/api/health`
- `/api/transfer-edges?limit=500&nodes=10000` (aggregated wallet→wallet, mapped to representative tokens; used in transfers mode)
- `/api/top-traded-tokens?limit=50` — top tokens by total transfers (with sales count and last trade)
- `/api/longest-held-tokens?limit=50` — currently held tokens with longest `hold_days`
- `/api/trait-sale-stats?min_sales=3&limit=200` — average/min/max sale price aggregated per trait value

Preset data payload (compact arrays)
`GET /api/preset-data?nodes=10000` returns fast arrays for UI encodings:
- Token arrays: `tokenLastActivity`, `tokenPrice`, `tokenSaleCount`, `tokenLastSaleTs`, `tokenLastSalePrice`, `tokenHoldDays`, `tokenTraitKey`, `rarity`
- Owner arrays: `owners`, `ownerIndex`, `ownerEthos`, `ownerWalletType`, `ownerPnl`, `ownerBuyVol`, `ownerSellVol`, `ownerAvgHoldDays`, `ownerFlipRatio`

Database overview (SQLite)
- Tables
  - `tokens` — core NFT data; owner, metadata, image paths, `frozen`, `dormant`, `last_activity`
    - Derived metrics: `sale_count`, `avg_sale_price`, `last_sale_price`, `first_sale_ts`, `last_sale_ts`, `last_acquired_ts`, `last_buy_price`, `hold_days`
  - `attributes` — normalized traits (`trait_type`, `trait_value`) with indexes for fast filtering
  - `transfers` — history (`token_id`, `from_addr`, `to_addr`, `timestamp`, `price`, `event_type`)
  - `wallet_metadata` — ENS, Ethos scores/credibility, social links, holdings, activity rollups
  - `ethos_profiles` — lean cache for ACTIVE/signed‑up Ethos users (`has_ethos`, `profile_json`, `updated_at`)
  - `graph_cache` — precomputed graphs (holders/transfers/traits/wallets) with ETag
  - `collection_stats` — global counters (total supply, holders, etc.)
- Transaction semantics
  - Sale: `price > 0` (or `event_type='sale'`)
  - Transfer: `price IS NULL OR price <= 0` and not a mint
  - Mint: `event_type='mint'` or empty `from_addr`
- Indexes
  - `idx_transfers_token_time (token_id, timestamp)`
  - `idx_transfers_token_to_time (token_id, to_addr, timestamp)` for last_acquired lookups
- Caching
  - In‑memory TTL (5m) + ETag; `/api/graph` also backed by `graph_cache`

Jobs & Data Flow
1) `scripts/db.migrate.js` — creates/tunes tables/indexes (idempotent)
2) `jobs/sync-metadata.js` — tokens + attributes + images (optional)
3) `jobs/sync-holders.js` — owners per token (Modularium or metadata fallback)
4) `jobs/sync-activity.js` — transfers (with price/tx/hash/event_type), cursored; supports full backfill
5) `jobs/enrich-wallets.js` — wallet_metadata baseline (holdings, first/last activity, trades)
6) `jobs/ethos.js` — batch Ethos v2 enrichment (scores/users/links)
7) `jobs/compute-edges.js` — precompute bounded-degree edges for graph_cache (holders/transfers/traits)
8) `jobs/sync-listings.js` — marketplace listings (status, price, platform)
9) `jobs/compute-wallet-metrics.js` — wallet TIA volumes, avg buy/sell, realized/unrealized PnL (FIFO + royalties), last buy/sell
10) `jobs/classify-wallets.js` — behavior classification: flipper, diamond_hands, whale_trader, collector, holder, accumulator
11) `jobs/compute-token-metrics.js` — token-level sale/hold metrics (sale_count, last/avg sale, hold_days)

One-shot: `npm run jobs:all` runs them in order. Cron: see `jobs/run-all.js`.

Quick checks
```
# Health & stats
curl -s http://localhost:3000/api/health | jq .
curl -s http://localhost:3000/api/stats  | jq .

# Graph & preset data
curl -s 'http://localhost:3000/api/network-graph?mode=holders&nodes=500&edges=0' | jq '.nodes|length'
curl -s 'http://localhost:3000/api/preset-data?nodes=500' | jq 'keys'

# Transfer edges (aggregated wallet→wallet)
curl -s 'http://localhost:3000/api/transfer-edges?limit=25' | jq '.[0]'

# DB sanity
sqlite3 ./data/mammoths.db ".tables"
sqlite3 -json ./data/mammoths.db "SELECT (SELECT COUNT(*) FROM tokens) AS tokens,
                                       (SELECT COUNT(*) FROM attributes) AS attrs,
                                       (SELECT COUNT(*) FROM transfers) AS xfers,
                                       (SELECT COUNT(*) FROM wallet_metadata) AS wallets;"
```

Render.com
- Persistent disk via `render.yaml`
- Set env: `DATABASE_PATH=/data/mammoths.db`, `CONTRACT_ADDRESS`, `MODULARIUM_API`, `ETHOS_API`, `ETHOS_BASE`, `ETHOS_CLIENT`
- First boot: `npm run db:init` then `npm run jobs:all` in the Render shell
- Weekly cron (included) runs `node jobs/run-all.js`

Performance
- Edge cap ≤ 500; per‑token degree caps; viewport culling; LOD decimation when zoomed out
- Worker ~30Hz → main 60fps; resolution capped ≤ 2; WebGL guard
- Grid is cheap; charts are lightweight Canvas overlay

Design & Tokens
- Colors/typography align with dash.mammoths.tech (monospace, black/green)
- Frozen = #4488ff, Dormant = #666666
- See `docs/TECH_SPEC.md` for the living spec and proposed design tokens
- Renderer uses a centralized palette in `public/main.js` (`BRAND` object)

Modularium + Ethos
- Jobs fill tokens/attributes/holders/transfers (with price) and wallet_metadata (Ethos v2 batch)
- Runtime reads only from SQLite; on‑demand Ethos proxy (`/api/ethos/profile`) caches 24h

**Design Tokens (CSS Variables)**
- Colors: `--bg`, `--fg`, `--fg-dim`, `--green-rgb` (use with `rgba(var(--green-rgb), .2)`), `--blue`, `--gray`, `--text`
- Typography: `--font-mono`, sizes `--fs-10`, `--fs-12`, `--fs-14`, `--fs-18`
- Spacing: `--pad-4`, `--pad-6`, `--pad-8`, `--pad-12`, `--pad-16`, `--pad-24`, `--pad-32`, `--pad-48`
- Layout: `--col-left`, `--col-right`, `--radius`, `--line-rgb`
- Controls: `--ctl-h`, `--ctl-pad-x`, `--ctl-pad-y`
- Surfaces: `--card-bg`, `--text-muted`

Usage examples
```
border: 1px solid rgba(var(--green-rgb), .15);
padding: var(--pad-8) var(--pad-12);
font: var(--fs-12)/1.5 var(--font-mono);
color: var(--fg); background: var(--bg);
height: var(--ctl-h); line-height: var(--ctl-h);
```

**Sanctioned Palette & Usage**
- UI Chrome: only `--bg` (black), `--fg` (brand green), `--text`, with borders using `rgba(var(--green-rgb), .2..3)`.
- Status Colors: `--blue` (frozen), `--gray` (dormant) apply to token nodes and legend, not to UI chrome.
- Negative/Alerts: `--danger` is reserved for semantic negatives (e.g., realized losses, sale edges). Do not use for generic UI.
- Data Encodings (Transfers): Sales = red arrows, Transfers = blue dashed, Mints = white dotted, Multi = gold solid.

**Visual Encoding by View**
- Ownership Network: position by owner clusters (whales centered), size by holdings/hold-days, color by wallet type; ownership edges subtle and curved.
- Trading Activity: X = recency of last sale; Y = turnover (sale count); size by last sale price; heat color for activity.
- Trait Explorer: spiral constellation; size by last sale price; highlight active rares; traits pane open.
- Whale Watch: proximity/size by wallet trading volume; whale types colored; ownership relationships visible.
- Collection Health (Frozen): layers by status/activity; alpha by recent sale; blue=frozen, gray=dormant, green=active.

Visual Encoding Table
```
| View                | Position                        | Size                  | Color                           | Edges                               | Extras                   |
|---------------------|----------------------------------|-----------------------|----------------------------------|--------------------------------------|--------------------------|
| Ownership Network   | Owner clusters; whales centered  | Hold-days / holdings  | Wallet type                      | Subtle green curves (ownership)      | Cluster layout (desktop) |
| Trading Activity    | Recency of last sale (X); count  | Last sale price       | Heat by activity                 | Sales red arrows; dashed transfers   |                          |
| Trait Explorer      | Spiral constellation             | Last sale price       | Rare highlight (active rares)    | Rare trait edges (optional)          | Traits open              |
| Whale Watch         | Distance to high-volume wallets  | Volume (buy+sell)     | Whale types                      | Ownership + volume relations         |                          |
| Collection Health   | Status layering                  | —                     | Blue=frozen, Gray=dormant, Green | Transaction edges, subdued ownership |                          |
```

Notes
- PIXI v7 UMD build is served at `/lib/pixi.min.js`; the app uses `new PIXI.Application({ ... })` and `app.view`
- Images: served at `/images`; thumbnails at `/thumbnails` (nodes never load images)
- If better‑sqlite3 native errors: `npm rebuild better-sqlite3 --build-from-source`

Codex system instructions
- Launch Codex with the repo’s system rules: `codex chat --system-file SYSTEM.md`

Changelog (high level)
- 2025‑09‑10: Added `/api/transfer-edges` and transaction edge styles with toggles; header sticky; grid visibility tuned; centralized JS palette.
