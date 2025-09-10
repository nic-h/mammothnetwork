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
- `/api/preset-data` — compact arrays for presets (owners, ownerIndex, ownerEthos, tokenLastActivity, tokenPrice, traitKeys, tokenTraitKey, rarity)
- `/api/token/:id` — token details; `ethos` present only for active/signed-up wallets
- `/api/wallet/:address` — token list + ethos if active
- `/api/wallet/:address/meta` — wallet stats + ethos_score (null unless accepted)
- `/api/ethos/profile` — v2 proxy; 24h cache
- `/api/activity`, `/api/heatmap`, `/api/traits`, `/api/stats`, `/api/health`

## Data Model (SQLite)
Tables: `tokens`, `attributes`, `transfers`, `graph_cache`, `wallet_metadata`, `collection_stats`, `ethos_profiles`.

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

# Changelog
- v2.0 — Spec aligned to current implementation; added tokens proposal; clarified decisions.
