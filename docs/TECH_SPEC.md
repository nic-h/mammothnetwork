# Mammoths Network Visualization – Technical Spec (v2.0)

Status: living specification for the repo. This doc tracks intent (spec) and implementation status to avoid drift while we iterate.

## Summary
Interactive WebGL network visualization for 10,000 Mammoth NFTs showing ownership clusters, trading patterns, and trait relationships. The center canvas now runs on a Three.js + 3d-force-graph renderer with custom gradient sprites, additive blending, and zoom-aware level-of-detail controls. Data is served by a SQLite backend with cached endpoints and compact “preset-data” arrays.

### Simple Views
- DOTS — ownership state defaults; additive sprite glow, whale bubble toggle, optional cluster mode (circle packing via d3-hierarchy).
- FLOW — curved transfer/sale arcs with directional particles, color-coded by trade type, filtered by the time slider.
- TREE — radial lineage layout using d3.tree around the focused token or wallet; forces paused for clarity.
- RHYTHM — time × price projection; recent activity pulses green, dormant holdings fade red, Z-axis lifts by recency.

Data source precedence: `/api/precomputed/{wallets,edges,tokens}` → fallback to live `/api/graph` nodes/edges (ensures canvas never blank).

## Alignment Snapshot
- Rendering: Three.js + 3d-force-graph (custom sprites, animated pulse, link styles) — Implemented
- Nodes: colored circles only (no per-node images) — Implemented
- Modes: holders, transfers, traits, wallets — Implemented
- Presets: ownership, trading, rarity, social, whales, frozen — Implemented (6/10)
- Focus mode — Disabled (by product decision)
- Sidebar details (owner, ENS, Ethos if verified, holdings, trades, last activity, traits) — Implemented
- API: cached SQLite, ETag/TTL, precomputed graph_cache — Implemented
- Ethos: v2 integration with strict ACTIVE/profileId/profile link gating, 24h cache — Implemented
- Layout: default static grid; deterministic preset layouts — Implemented
- Performance caps (≤500 edges) — Implemented
- Deployment target (Render.com + persistent disk) — Supported via render.yaml

## Notes & Decisions
- “Real-time” phrasing clarified to “interactive (cached)”; no websockets/streaming today.
- Render port: server can run on 3000 or 3001; set `PORT` in env. Render config should match.
- Presets beyond the current six (Hubs, Discovery, Activity timeline, etc.) are planned — not implemented yet.

## UI Control Reference
| Control | Intent | Data Source / Implementation Notes |
|---------|--------|-------------------------------------|
| **Link density** slider | Adjusts `state.edgeCap` (0‑500) and rebuilds edges so sparse or dense graphs can be inspected. | Currently ineffective because the bubble view is using owner nodes with no compatible edge layers. |
| **Ambient edges** | Renders faint ownership edges to provide spatial context while no node is selected. | Depends on `state.rawEdges.ambient` (cloned holder edges). Missing while owner nodes are active. |
| **Whale bubbles** | Expands nodes flagged as whales (wallet classification includes “whale”). Highlights treasury/large holders. | Requires token nodes with `isWhale` metadata. |
| **Relationships ▸ Ownership / Rare traits** | Toggles long-term co-ownership and rare-trait similarity edges. | Backed by `/api/graph` holders + traits preset caches. |
| **Transactions ▸ Recent trades / Sales / Transfers / Mints** | Filters directed trade edges built from `/api/transfer-edges` (sales_count, transfers, mints). | Token graph only; owner view shows nothing. |

## Implementation Drift (Reality vs Spec — Oct 2025)
- Bubble view renders **ownerNodes** instead of `tokenNodes`, breaking thumbnails, sales metrics, trait filters, and the whale palette.
- A stopgap **2‑D normalization** flattens the layout, causing overlapping neon discs and hiding the intended grid background.
- The bundle imports **Three.js twice** (engine loader + bundled module), leading to the browser warning “Multiple instances of Three.js,” GPU stalls, and missing hover/click state updates.
- Brand palette drift: frozen nodes are no longer #4488ff, dormant nodes lack the dark green/gray tone, and whales share the active color.
- Grid overlay and hover tooltips were removed during recent styling changes; reinstate the original CSS overlay and sprite material logic.
- Link-density slider, ambient edges, and whale bubble toggles are present in the UI but disconnected from data while owner nodes are in use.

## API Surface
- `/api/graph` (alias `/api/network-graph`) — nodes+edges with ETag
- `/api/preset-data` — compact arrays for views (see “Preset Data Payload”)
- `/api/token/:id` — token details; `ethos` present only for active/signed-up wallets
- `/api/wallet/:address` — token list + ethos if active
- `/api/wallet/:address/meta` — wallet stats + ethos_score (null unless accepted)
- `/api/ethos/profile` — v2 proxy; 24h cache
- `/api/activity`, `/api/heatmap`, `/api/traits`, `/api/stats`, `/api/health`
- `/api/precomputed/wallets`, `/api/precomputed/edges?window=7d|30d|90d`, `/api/precomputed/tokens`
- `/api/transfer-edges?limit=500&nodes=10000` — aggregated wallet→wallet edges with `{ a, b, type, count, sales, transfers, mints }`; maps wallets to representative token IDs for display.
- `/api/token/:id/story` — unified token lifecycle snapshot (view `token_story`)
- `/api/suspicious-trades` — tokens with suspected wash trading (view `suspicious_trades`)
- `/api/wallet-relationships?min_trades=3` — frequent trading pairs
- `/api/top-traded-tokens?limit=50` — tokens ordered by total transfers (with sales count, last trade ts)
- `/api/longest-held-tokens?limit=50` — currently held tokens ordered by `hold_days`
- `/api/trait-sale-stats?min_sales=3&limit=200` — sale stats per trait value (avg/min/max)

## Data Model (SQLite)
Tables: `tokens`, `attributes`, `transfers`, `graph_cache`, `wallet_metadata`, `collection_stats`, `ethos_profiles`.
New in v2: `mint_events`, `token_events`, `wallet_relationships`, `collection_snapshots`.

### Table definitions (current)

```
-- tokens: Main NFT data with status flags
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  owner TEXT,
  token_uri TEXT,
  name TEXT,
  description TEXT,
  image_url TEXT,
  image_local TEXT,
  thumbnail_local TEXT,
  metadata TEXT,
  attributes TEXT,
  frozen INTEGER DEFAULT 0,
  dormant INTEGER DEFAULT 0,
  last_activity INTEGER,
  updated_at DATETIME
);

-- attributes: normalized trait type/value pairs
CREATE TABLE attributes (
  token_id INTEGER,
  trait_type TEXT,
  trait_value TEXT,
  PRIMARY KEY (token_id, trait_type, trait_value)
);
CREATE INDEX idx_attr_type ON attributes (trait_type);
CREATE INDEX idx_attr_type_value ON attributes (trait_type, trait_value);

-- transfers: transfer history; price>0 indicates sale; price NULL indicates transfer
CREATE TABLE transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,
  from_addr TEXT,
  to_addr TEXT,
  timestamp INTEGER,
  price REAL,
  price_tia REAL,
  price_usd REAL,
  price_eth REAL,
  tx_hash TEXT,
  event_type TEXT
);
CREATE INDEX idx_transfers_token_time ON transfers (token_id, timestamp);
CREATE INDEX idx_transfers_token_to_time ON transfers (token_id, to_addr, timestamp);

-- wallet_metadata: enriched wallet data and rollups
CREATE TABLE wallet_metadata (
  address TEXT PRIMARY KEY,
  ens_name TEXT,
  ethos_score REAL,
  ethos_credibility REAL,
  social_verified INTEGER,
  links_profile TEXT,
  links_x TEXT,
  links_fc TEXT,
  total_holdings INTEGER,
  first_acquired INTEGER,
  last_activity INTEGER,
  trade_count INTEGER,
  updated_at DATETIME
);

-- graph_cache: precomputed graphs (holders/transfers/traits/wallets)
CREATE TABLE graph_cache (
  key TEXT PRIMARY KEY,
  etag TEXT,
  payload TEXT,
  updated_at DATETIME
);

-- ethos_profiles: lean Ethos cache for strict gating (ACTIVE/profileId/link)
CREATE TABLE ethos_profiles (
  wallet TEXT PRIMARY KEY,
  has_ethos INTEGER NOT NULL DEFAULT 0,
  profile_json TEXT,
  updated_at INTEGER
);

-- collection_stats: global counters
CREATE TABLE collection_stats (
  id INTEGER PRIMARY KEY,
  total_supply INTEGER,
  floor_price REAL,
  holders INTEGER,
  updated_at DATETIME
);
```

Semantics
- A “sale” is a transfer row with `price > 0` (or `event_type='sale'`).
- A “transfer” is a row with `price IS NULL OR price <= 0` and not a mint.
- A “mint” is a row with `event_type='mint'` or `from_addr` empty.
- `/api/transfer-edges` aggregates by `LOWER(from_addr), LOWER(to_addr)` and maps each wallet to a representative token ID they currently hold, for drawing directed edges between token nodes.

Indexes & perf
- Heavy queries use indexes shown above; additional ad‑hoc indexes can be added as needed (e.g., `LOWER(owner)` scans are common).

Caching
- In‑memory TTL cache (5m) + ETag; DB‑level `graph_cache` backs `/api/graph` to keep cold starts fast.

Ethos
- Strict acceptance: only ACTIVE / profileId>0 / profile link users are surfaced (else `ethos` is null in responses). `/api/ethos/profile` caches 24h.

## Rendering Details
- Engine: `client/three/app.js` boots ForceGraph3D and bundles to `public/three.app.js` via `npm run build:client`.
- Nodes: gradient `THREE.SpriteMaterial` (additive blending). Base size scales with `log10(sale_count)`; whales get extra scale when the “Whale Bubbles” toggle is active.
- Pulse loop: `requestAnimationFrame` adjusts sprite opacity with activity recency; hover/selection/highlight tweak tint/alpha before the pulse step.
- Edges: zoom buckets (near=500, mid=300, far=100) clamp the slider. Styles follow spec (sales red, transfers blue dashed, mints white dotted, mixed gold, ownership/ambient green, traits violet).
- FLOW view: arcs bend at 0.2, buys render green with double particles, sells render red with single particles/solid strokes, and the time slider filters edges to the selected window.
- TREE view: lineage nodes are cloned, recolored, and pinned into a radial layout (d3.tree polar coordinates) around the focused token/wallet; simulation decay set to 1 while active.
- DOTS cluster mode: optional circle-packing (d3.pack) by owner/segment with faint group rings; nodes pin until the toggle is cleared, then snap back to preset positions.
- RHYTHM view: tokens are remapped into a time×price volume space (Z by recency, radius by turnover). Recent activity pulses green, dormant holdings fade red, and the time slider clips visible bands.
- Interactions: node click recenters the camera and sidebar; ENS/0x search resolves to wallet highlight; background click clears selection.
- Sidebar order: Ethos (score/tags/blurb) → Story → Traits → Description; sections auto-hide when empty. Traits render in a two-column grid with single-line values and ellipsis.
- Automation guard: the stage writes `window.__mammothDrawnFrame = true` after the first layout so Playwright captures wait on a filled canvas.

## Performance Targets
- Initial load < 500ms (with cache)
- 10k nodes @ 60fps on modern laptop GPUs
- Mode transitions < 800ms

## Open Items
- Styling parity with dash.mammoths.tech: finalize tokens (colors, font sizes, spacings). See “Design Tokens”.
- Preset list: freeze current six; spec the remaining four before implementation.
- Port alignment in Render.

---

# Design Tokens (proposed)
A minimal set of CSS variables to keep aesthetics consistent with mammoths.tech/dash.mammoths.tech.

```
:root {
  /* Colors */
  --bg: #000000;
  --fg: #00ff66;
  --fg-muted: #7bf0a8;
  --blue: #4488ff;   /* frozen */
  --gray: #666666;   /* dormant */
  --line-rgb: 0,255,102; /* for rgba() borders */

  /* Typography */
  --font-mono: 'IBM Plex Mono', ui-monospace, Menlo, "Fira Code", SFMono-Regular, monospace;
  --fs-10: 10px; --fs-11: 11px; --fs-12: 12px; --fs-14: 14px; --fs-18: 18px;
  --fw-regular: 400; --fw-bold: 700;
  --tt: uppercase;

  /* Spacing & layout */
  --pad-4: 4px; --pad-6: 6px; --pad-8: 8px; --pad-12: 12px; --pad-16: 16px;
  --radius: 0; /* square look */
  --col-left: 280px; --col-right: 420px;
}
```

Usage: prefer variables in new styles; existing rules can be updated opportunistically. Border examples: `border-color: rgba(var(--line-rgb), .2)`.

---

## Preset Data Payload
`GET /api/preset-data?nodes=10000` returns dense arrays aligned by token index or owner index to keep the UI fast:

- Token-aligned arrays:
  - `tokenLastActivity` — last transfer per token (unix sec)
  - `tokenPrice` — last known price per token (nullable)
  - `tokenSaleCount` — sale count per token
  - `tokenLastSaleTs` — last sale timestamp per token (nullable)
  - `tokenLastSalePrice` — last sale price per token (nullable)
  - `tokenLastBuyPrice` — last buy price per token (nullable)
  - `tokenHoldDays` — days since last acquisition (nullable)
  - `tokenTraitKey` — index of rarest trait (or -1)
  - `rarity` — 0..1 rarity score
- Owner-aligned arrays:
  - `owners` — distinct lowercased addresses
  - `ownerIndex` — per-token owner index
  - `ownerEthos` — ethos score aligned to owners
  - `ownerWalletType` — classification (flipper, diamond_hands, whale_trader, collector, holder, accumulator)
  - `ownerPnl` — realized PnL (TIA)
  - `ownerBuyVol`, `ownerSellVol` — buy/sell volumes (TIA)
  - `ownerAvgHoldDays`, `ownerFlipRatio` — behavior metrics

These arrays are computed server-side from SQLite and cached in‑memory per request. The UI uses them to color/size/position tokens without additional API calls.


# Changelog
- v2.2.1 — TREE view now renders a fixed radial lineage layout, DOTS adds bubble-pack Cluster mode, FLOW uses green-buy/red-sell encodings with curved arcs and particles, and Link density/time controls adjust per view.
- v2.2 — Center engine uses Three.js 3d-force-graph with custom sprites/LOD; legacy renderers removed.
- v2.1 — Center engine overhaul, new views (holders hulls, trading waterfalls/flows, traits constellations); DB migrations (mint/token events, relationships, snapshots); endpoints (`/api/token/:id/story`, `/api/suspicious-trades`).
- v2.0 — Spec aligned to current implementation; added tokens proposal; clarified decisions.

---

# Engine & Rendering (Three.js ForceGraph)

## Engine selection
- `public/engine.js` lazy-loads `public/three.app.js` (esbuild bundle from `client/three/app.js`).
- Left and right panels (HTML/CSS) stay intact; the center `.center-panel` is replaced with `#three-stage` at runtime.

## ForceGraph configuration
- `ForceGraph3D` with a custom `nodeThreeObject` sprite (gradient disc, additive blending) sized from log10(sale_count) and whale flags.
- Zoom bucket caps: near=500, mid=300, far=100 edges; the slider cannot exceed the active bucket.
- Whale bubble toggle multiplies whale sprite scale (+35%) and adds opacity bias inside the pulse loop.
- Link styling: sales red solid, transfers blue dashed, mints white dotted, mixed gold solid, traits violet faint, ownership/ambient green translucent.
- Pulse loop keeps nodes breathing (~12% amplitude) and boosts recently active (<24h) tokens.

## Interactions & shortcuts
- Click → focuses camera (600 ms ease) and loads sidebar via `/api/token/:id`.
- Hover → pointer cursor, non-hover nodes dim, and the active sprite scales up (no drag).
- Search `Enter` → ENS/0x resolves to wallet highlight; numeric IDs focus the token.
- Keyboard: `Esc` clears selection; toggles + sliders remain HTML-driven; view buttons call `window.mammoths.setSimpleView`.
- Orbit controls pause when the pointer is over the header or side panels (prevents inadvertent drags while using the UI) and resume on stage re-entry.


---

# Operational Notes

## Smoke checks

```
# Graph should return nodes
curl -s 'http://localhost:3000/api/network-graph?mode=holders&nodes=500&edges=0' | jq '.nodes | length'

# Preset payload present
curl -s 'http://localhost:3000/api/preset-data?nodes=500' | jq 'keys'
-- token-level trading/hold metrics (added via conditional migrations)
ALTER TABLE tokens ADD COLUMN sale_count INTEGER DEFAULT 0;          -- if missing
ALTER TABLE tokens ADD COLUMN avg_sale_price REAL;                   -- if missing
ALTER TABLE tokens ADD COLUMN last_sale_price REAL;                  -- if missing
ALTER TABLE tokens ADD COLUMN first_sale_ts INTEGER;                 -- if missing
ALTER TABLE tokens ADD COLUMN last_sale_ts INTEGER;                  -- if missing
ALTER TABLE tokens ADD COLUMN last_acquired_ts INTEGER;              -- if missing
ALTER TABLE tokens ADD COLUMN last_buy_price REAL;                   -- if missing
ALTER TABLE tokens ADD COLUMN hold_days REAL;                        -- if missing

# Token + Wallet
curl -s 'http://localhost:3000/api/token/1' | jq '{id:.id, owner:.owner, ethos:.ethos}'
curl -s 'http://localhost:3000/api/wallet/0xDEADCAFEBEEF' | jq '{addr:.address, count:(.tokens|length), ethos:(.ethos!=null)}'

# Transfers edges (aggregated)
curl -s 'http://localhost:3000/api/transfer-edges?limit=50' | jq '.[0]'

# Stats/health
curl -s 'http://localhost:3000/api/stats'  | jq .
curl -s 'http://localhost:3000/api/health' | jq .
```

## DB sanity (quick SQL)

```
sqlite3 ./data/mammoths.db ".tables"
sqlite3 -json ./data/mammoths.db "SELECT (SELECT COUNT(*) FROM tokens) AS tokens,
                                       (SELECT COUNT(*) FROM attributes) AS attrs,
                                       (SELECT COUNT(*) FROM transfers) AS xfers,
                                       (SELECT COUNT(*) FROM wallet_metadata) AS wallets;"
```

## Assets
- No PIXI assets are shipped.
