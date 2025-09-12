# Mammoths Network Visualization – Technical Spec (v2.0)

Status: living specification for the repo. This doc tracks intent (spec) and implementation status to avoid drift while we iterate.

## Summary
Interactive WebGL network visualization for 10,000 Mammoth NFTs showing ownership clusters, trading patterns, and trait relationships. Built with PIXI.js v7 for 60fps rendering, SQLite for cached data, and deterministic layouts (grid by default, preset-specific layouts).

## Alignment Snapshot
- Rendering: PIXI v7 UMD, ParticleContainer for 10k nodes — Implemented
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
- Render port: server defaults to 3000; render.yaml should match. (If you need 3001, we will change the server.)
- Presets beyond the current six (Hubs, Discovery, Activity timeline, etc.) are planned — not implemented yet.

## API Surface
- `/api/graph` (alias `/api/network-graph`) — nodes+edges with ETag
- `/api/preset-data` — compact arrays for views (see “Preset Data Payload”)
- `/api/token/:id` — token details; `ethos` present only for active/signed-up wallets
- `/api/wallet/:address` — token list + ethos if active
- `/api/wallet/:address/meta` — wallet stats + ethos_score (null unless accepted)
- `/api/ethos/profile` — v2 proxy; 24h cache
- `/api/activity`, `/api/heatmap`, `/api/traits`, `/api/stats`, `/api/health`
- `/api/transfer-edges?limit=500&nodes=10000` — aggregated wallet→wallet edges with `{ a, b, type, count, sales, transfers, mints }`; maps wallets to representative token IDs for display.
- `/api/top-traded-tokens?limit=50` — tokens ordered by total transfers (with sales count, last trade ts)
- `/api/longest-held-tokens?limit=50` — currently held tokens ordered by `hold_days`
- `/api/trait-sale-stats?min_sales=3&limit=200` — sale stats per trait value (avg/min/max)

## Data Model (SQLite)
Tables: `tokens`, `attributes`, `transfers`, `graph_cache`, `wallet_metadata`, `collection_stats`, `ethos_profiles`.

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
- v2.0 — Spec aligned to current implementation; added tokens proposal; clarified decisions.

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
- PIXI is served from `/lib` (node_modules). A minimal `public/lib/pixi.min.js` copy is kept only for a simple file presence check; you can instead curl the served route.
