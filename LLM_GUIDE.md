# Mammoths Network — LLM Contributor Guide

This document gives a compact mental model and a reproducible checklist so an LLM (or a new engineer) can help without breaking working behavior.

## TL;DR
- Frontend: PIXI v7 UMD, entry at `public/main.js`, HTML at `public/index.html`, styles in `public/style.css`.
- Backend: Express in `server/index.js` with SQLite (see `server/db.js`).
- Data jobs (Modularium + Ethos): `jobs/*` — run them to (re)populate SQLite.
- Graph API: `/api/graph?mode=holders|transfers|traits|wallets&edges=0..500`.
- Detail API: `/api/token/:id`, wallet APIs at `/api/wallet/:address` and `/api/wallet/:address/meta`.
- Frozen/Dormant: marked in `tokens` table; UI colors under the FROZEN preset (blue/gray/green).

## How to run
1) `npm install`
2) Ensure `.env` has:
```
CONTRACT_ADDRESS=0xbE25A97896b9CE164a314C70520A4df55979a0c6
MODULARIUM_API=https://api.modularium.art
ETHOS_API=https://api.ethos.network
DATABASE_PATH=./data/mammoths.db
```
3) Initialize DB (creates tables): `npm run db:init` (or `node scripts/db.init.js`)
4) Populate (idempotent, safe to re-run):
```
node jobs/sync-holders.js
ACT_PAGES=100 ACT_LIMIT=1000 node jobs/backfill-activity.js
node jobs/mark-dormant.js
node jobs/sync-frozen-from-holders.js
MODE=holders node jobs/compute-edges.js
MODE=wallets node jobs/compute-edges.js
MODE=traits   node jobs/compute-edges.js
MODE=transfers node jobs/compute-edges.js
```
5) Run server: `npm run dev` → http://localhost:3000

## Anatomy
- `public/index.html`
  - Loads PIXI from `/lib/pixi.min.js` (UMD). Fallback loader in `main.js` tries alt paths + CDN and surfaces a red banner on failure.
  - Header: brand, mode selector, preset buttons (with icons), header search, focus toggle, small legend text.
  - Three-panel grid: left (traits), center (canvas), right (details).
- `public/main.js`
  - Cache-busts all fetches (`v=timestamp`, `no-store`) to avoid ETag 304 “blank” states.
  - Starts a PIXI app and draws 10k nodes with `PIXI.ParticleContainer` and a `Graphics` overlay for edges/selection.
  - Layout: static grid (no worker physics) for determinism; hover highlight and subtle grid background.
  - Selection: centers camera, outlines node, loads sidebar (image, ENS/owner, Ethos, holdings, trades, last seen, traits, similar chips), draws neighbor + same-owner links.
  - Presets: apply color/position changes; FROZEN uses DB flags; Social normalizes by Ethos; Whales scales node size by holdings.
  - Focus (checkbox or `f`): dims non-neighbors to ~0.25 alpha.
- `server/index.js`
  - Serves `/lib` from `node_modules/pixi.js/dist`, plus `public/` and API endpoints.
  - Graph endpoints return bounded edges (≤ 500) and include caching headers.
- `jobs/*`
  - `sync-holders.js`: owners from Modularium.
  - `backfill-activity.js`: paged `/collection/{contract}/activity` → inserts into `transfers`.
  - `mark-dormant.js`: sets `tokens.dormant=1` for zero-activity tokens; fills `last_activity`.
  - `sync-frozen-from-holders.js`: marks `tokens.frozen=1` for `frozenBalance === "1"` from `/collection/{contract}/holders`.
  - `ethos.js`: batch-enrich wallet_metadata.

## Debug checklist (when canvas looks empty)
1) Hard refresh (Cmd+Shift+R) — critical; old JS can linger.
2) Network tab:
   - `/lib/pixi.min.js` returns 200 (or fallback loads; otherwise red banner appears).
   - `/api/graph?mode=holders&edges=200` returns JSON with `nodes`.
   - `/api/traits` returns JSON with `traits`.
3) Console: no uncaught errors. If there are, copy the first one.
4) Try changing the mode to `holders` and recheck `/api/graph` response.

## Non-breaking tasks an LLM can tackle
- Add small loading states (header status text) during graph/traits fetch.
- Add error toast/banner when any API call fails.
- Clarify preset legends and keep them in sync.
- Improve Trading layout (clear timeline mapping), keep code in `layoutPreset('trading')`.
- Mobile-friendly adaptations (touch pan/zoom, responsive right panel).
- Improve culling/LOD for big zoomed-out views (without reintroducing worker physics just yet).

## Style + brand rules
- Match dash.mammoths.tech: black background, green #00ff66, IBM Plex Mono (uppercase), flat (no shadows/gradients).
- Keep borders: `1px solid rgba(0,255,102,.2)`; spacing 12–20px; header ≈ 44–48px.

## Rollback safety
- Tag `working-00e6ca4` is the last known working snapshot (nodes visible, default zoom).
- Branch `rollback/working-00e6ca4` points to it.

## Gotchas
- ETag 304 from `/api/graph` can blank the UI if cached — handled by cache-busting.
- Token IDs are 1‑based and selection relies on `idToIndex`; don’t revert to `index+1`.
- Keep edge caps ≤ 500 for perf; draw them only when small.

If you change rendering or data flows, keep changes surgical and reversible. Do not alter server endpoints’ shapes unless coordinated with jobs and frontend.

