Mammoths Network Visualization
=============================

WebGL network for the Mammoths NFT collection.

New here? Start with Onboarding:
- docs/ONBOARDING.md — quick start, engine, DB, commands
- docs/TECH_SPEC.md — deeper spec for views/data/engine
- docs/DEV_TRIAGE.md — quick triage to verify data, endpoints, and canvas

> ⚠️ **Non‑negotiable rule: every renderer view must visualize real Mammoths data.**
>
> - Use the hydrated SQLite database (`tokens`, `transfers`, `attributes`, etc.) and the precomputed layout endpoints (`/api/precomputed/tokens`, `/api/precomputed/wallets`, `/api/precomputed/edges`).
> - Synthetic or “pretty” fallback layouts (spirals, donuts, random grids) are forbidden in the UI. If data is missing, surface an explicit error state rather than fabricating geometry.
> - Frozen/dormant/whale state, sale metrics, and owner clustering come from the DB; do not hard‑code colors or sizes. The renderer must honor those flags.
> - The only acceptable fallback is the legacy demo graph returned by `generateFallbackGraph()` **for automated smoke tests when the DB is empty**. It must never render in production or during normal local work.

Keep this in mind whenever you touch `client/three/app.js`, jobs, or docs—if the visualization is not telling the story of the live dataset, it’s a regression.

At‑a‑Glance System Overview
- Frontend: Three.js + 3d-force-graph (custom gradient sprites, additive blending, LOD-aware edge throttling).
- Renderer source: `client/three/app.js` bundles to `public/three.app.js` via `npm run build:client`.
- Backend: Express + SQLite (better-sqlite3). `/api/graph` delivers nodes/edges; `/api/preset-data` provides compact arrays for fast view encoding; ETag + TTL cache.
- Data sources: Modularium API (holders, activity/transfers, listings), Ethos API (scores/users). Jobs fetch and cache into SQLite; UI reads only from DB.
- Storage: images/thumbnails on disk (optional); no per-node images in the graph, only in the sidebar.
- Deployment: Render.com with persistent disk; weekly cron refreshes data (see `jobs/run-all.js`).

Current Status
- Three.js force-directed renderer (3d-force-graph + custom sprites/pulse loop)
- TREE view renders a radial lineage layout around the focused token/wallet (forces paused for clarity).
- DOTS view offers an optional Cluster mode bubble-map that circle-packs tokens by owner segment.
- FLOW view highlights buys vs sells (green vs red) with curved arcs, directional arrows, and particle speed/volume scaling.
- RHYTHM view maps tokens into time×price space (recent activity lifts in Z, buys glow green, dormant tokens fade red) for quick market cadence scans.
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
- Styling: black + brand green (#00ff66), frozen blue (#4488ff), dormant gray (#666666), whale bubble toggle enlarges whales
- Header is sticky (40px row); grid background alpha ≈ 0.12
- Hovering a node now dims its neighbors and enlarges the target; clicks focus the right sidebar and keep the camera centered.
- Panels and header sit above the canvas (orbit/pan pauses whenever the cursor is over UI); the time slider only appears in FLOW/RHYTHM, and “Link density” reflects the active view.

### Known Regressions (Oct 2025)
> These are active issues in the current branch. Treat them as high-priority fixes before shipping.

- Bubble view is rendering **owner nodes** (≈9.1k wallets) instead of token nodes (10k NFTs). Consequences: sidebar lacks artwork/sale data, dormant/frozen coloring is wrong, and the layout collapses into dense rings.
- A temporary **2‑D normalization** squeezes the owner layout into a flat disc, removing the depth spacing that avoided overlap. Combined with a single neon-green palette the clusters appear as a solid blob.
- **Double Three.js import** (bundle + engine) triggers the browser warning “Multiple instances of Three.js”, causes GPU stalls, and breaks hover/click feedback. The build must return to a single three module.
- Brand palette drift: frozen nodes are no longer blue (#4488ff) and dormant nodes are not the dark green/gray from the design tokens. Whale state uses the same green as active.
- UI toggles (“Ambient edges”, “Whale bubbles”, “Relationships”, “Transactions”) still exist but their behaviors were partially removed when the view switched to owners; link density slider currently adjusts nothing.
- Sidebar regressions: thumbnails, Ethos score, sale metrics, and trait rollups are missing because the node selection is not tied to `tokenNodes`.
- First paint is noticeably slower (spins for several seconds) because the engine rebuilds sprites twice and merges owner edges on the fly. The older build relied on precomputed token presets and a single renderer init.

Local setup
1. `npm ci`
2. `npm run db:migrate`
3. Populate (reads `.env` automatically):
   - `set -a; source .env; set +a`
   - `npm run jobs:all` *(takes ~8 minutes; fills tokens, transfers, similarity, listings)*
4. `PORT=3001 npm run dev` (or use 3000)
5. Open: `http://localhost:3001?force=1`
   - `force=1` bypasses cached graphs so the first load matches fresh DB contents.
6. First-frame guard: the UI sets `window.__mammothDrawnFrame=true` after the Three.js force graph paints its first frame.
   - If the canvas stays empty, check DevTools console and ensure the DB jobs completed.

Environment
- Required: `CONTRACT_ADDRESS`, `MODULARIUM_API`, `ETHOS_API`
- DB path override: `DATABASE_PATH=/path/to.db`
- Optional: `DATABASE_PATH` (default `./data/mammoths.db`), `DOWNLOAD_IMAGES=1`, `ROYALTY_BPS` (default `250`), and job tuning vars (see Jobs & Data Flow)

Endpoints (selected)
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

Image version: `public/assets/visual-encoding-table.svg`

Notes
- Three.js 3d-force-graph center canvas with left/right panels preserved.
- Images: served at `/images`; thumbnails at `/thumbnails` (nodes never load images)
- If better‑sqlite3 native errors: `npm rebuild better-sqlite3 --build-from-source`

Preview & Dev
- Start: `npm run dev` (default `PORT=3000`; set `PORT=3001` if needed)
- Open: `http://localhost:3000` or `http://localhost:3001`
- Optional: preselect a token with `?token=5000`

Screenshots
- Prep once per run: `npm run db:migrate && npm run jobs:all && npm run dev`
- Generate 1440px desktop previews for each view: `npm run test:ui`
  - The script now opens `${BASE}?force=1`, waits for `window.__mammothDrawnFrame === true`, and samples the WebGL buffer before saving. Blank canvases will fail the wait.
- Configure variants: `PREVIEW_IDS=5000,3333,2500 PREVIEW_VARIANTS=3 npm run test:ui`
- Images are saved to `artifacts/ui/`

Simple Views (2025‑09)
----------------------

Fast, GPU‑friendly views backed by binary attributes and zoom gates. These render from `/api/precomputed/*` when available and fall back to the live `/api/graph` nodes/edges so the canvas never appears blank.

- DOTS: wallet scatter. Size = log10(holdings+buys+sells). Color = Active/Whale/Frozen/Dormant. Cluster mode (checkbox) bubble-packs by owner/segment; otherwise reverts to preset positions. Click opens token detail (from wallet → first token, or from graph fallback).
- FLOW: market flows (ArcLayer). Red = sales; Blue = transfers. Visible at zoom ≥ 1.4. Top ~400 arcs.
- WEB: straight connections (PathLayer). Red/Blue like FLOW. Visible at zoom ≥ 1.2. Top ~400 lines.
- PULSE: recent activity dots. Alpha = 1−days/90; soft “breathe” if <24h.
- CROWN: token rarity dots; gold labels for top‑K rare at zoom ≥ 2.

Precomputed Endpoints
- `/api/precomputed/wallets` — `{ wallets:[{ addr, xy:[x,y], holdings, buys, sells, lastTxAt, volume30dTia, degree, isFrozen, … }] }`
- `/api/precomputed/edges?window=7d|30d|90d` — `{ edges:[{ a,b,type,valueTia,ts,weight,path:[[ax,ay],[bx,by]] }] }`
- `/api/precomputed/tokens` — `{ tokens:[{ id, xy:[x,y], rarityRank, ownerAddr, lastSaleAt, saleCount, volumeAllTia }] }`

Populate + Verify (quick)
1) `npm ci && npm run db:migrate`
2) Export env: `CONTRACT_ADDRESS`, `MODULARIUM_API`, `ETHOS_API`
3) Minimum data fill:
   - `node jobs/sync-metadata.js`
   - `node jobs/sync-holders.js`
   - `node jobs/sync-activity.js`
   - `node jobs/compute-token-metrics.js`
   - `node jobs/enrich-wallets.js`
   - `node jobs/precompute-layouts.js`
4) Start server: `npm run dev`
5) Verify:
```
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/graph | jq '.nodes|length'
node -e "import { openDatabase } from './server/db.js'; const { db }=openDatabase(process.cwd()); const n=a=>db.prepare(a).get().c; console.log({ tokens:n('SELECT COUNT(1) c FROM tokens'), transfers:n('SELECT COUNT(1) c FROM transfers') }); db.close();"
```

Troubleshooting
- Canvas blank: restart the server so new routes are active; if `/api/precomputed/*` returns HTML (index), the process hasn’t reloaded. Simple views now fall back to live `/api/graph`, so if still blank inspect `/api/graph` in Network.
- Sidebar image missing: ensure `data/thumbnails/:id.jpg` or `tokens.thumbnail_local/image_local` exists; server falls back to disk automatically.
- Search alignment: header and main share the same 3‑column grid; search is in column 3. The placeholder tooltip is “Search wallet (0x…), ENS, or token ID”.

Headless Screenshots
1) `npm ci && npx playwright install`
2) `PREVIEW_IDS=1000,724,1472 PREVIEW_VARIANTS=1 node scripts/ui.screenshots.js`
   The script forces a selection via `window.mammoths.focusToken(id)` and waits for sidebar + image before capture.

- Engine
- The center rendering engine is 3d-force-graph/Three.js (`public/three.app.js`, built from `client/three/app.js`).
- Left and right panels remain unchanged (brand CSS tokens at `public/client/styles/tokens.css`).
- Orbit controls pause while hovering the left/right panels or header; pointer reactivates pan/zoom when it returns to the stage.
- `LINK DENSITY` replaces the old “Edges” slider label, and the time slider is only visible in FLOW/RHYTHM (filtered by buy/sell window).

UI tweaks
- Tip toolbar removed (cleaner top bar)
- View tabs moved to the top of the left panel (full width, brand tokens)
- Header search width equals right panel (256px)

Changelog (high level)
- 2025‑09‑12: Removed tip bar; tightened header spacing; stricter Ethos gating; added N/A ETHOS when no verified profile; added URL `?token=` preselection; improved Trading/Whales/Traits layouts; multiple screenshot variants.
- 2025‑09‑19: TREE view uses radial lineage layout; DOTS gained Cluster mode; FLOW edges use green buys / red sells with directional particles and curved arcs; controls expose Link density + time slider only where relevant.
- 2025‑09‑10: Added `/api/transfer-edges` and transaction edge styles with toggles; header sticky; grid visibility tuned; centralized JS palette.
Data migrations (v2)
- Run DB migrations: `npm run db:migrate`
- Backfill/normalize data: `node scripts/db.backfill.js`

Adds:
- Tables: `mint_events`, `token_events`, `wallet_relationships`, `collection_snapshots`
- Columns: `transfers.price_tia/price_usd/price_eth`, `listings.failure_reason/days_listed/relist_count`, `tokens.velocity`
- Views: `token_story`, `suspicious_trades`

Endpoints:
- `GET /api/token/:id/story` — unified lifecycle snapshot
- `GET /api/mint/:id` — mint info if recorded
- `GET /api/wallet-relationships?min_trades=3` — frequent trading pairs
- `GET /api/suspicious-trades` — tokens with suspected wash trading
