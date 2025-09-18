# Mammoths Network — LLM Contributor Guide (Deck.gl)

This document gives a compact mental model and a reproducible checklist so an LLM (or a new engineer) can help without breaking working behavior.

## TL;DR
- Frontend: Deck.gl UMD, loader at `public/engine.js`, app at `public/deck.app.js`, HTML at `public/index.html`, styles in `public/style.css`.
- Backend: Express in `server/index.js` with SQLite (see `server/db.js`).
- Data jobs (Modularium + Ethos): `jobs/*` — run them to (re)populate SQLite; scripts read `.env` automatically via `node --env-file=.env`.
- Graph API: `/api/graph?mode=holders|transfers|traits|wallets&edges=0..500`.
- Presets arrays: `/api/preset-data?nodes=10000`.
- Detail API: `/api/token/:id`, wallet APIs at `/api/wallet/:address` and `/api/wallet/:address/meta`.

## How to run (fast)
1) `npm ci`
2) Load env and migrate:
```
set -a; source .env; set +a
npm run db:migrate
```
3) Populate (full pipeline, safe to re‑run):
```
npm run jobs:all
```
4) Start server: `PORT=3001 npm run dev` → http://localhost:3001

## Anatomy
- `public/index.html`
  - Loads Deck.gl UMD from `/lib/deck.gl/dist.min.js` and geo-layers from `/lib/@deck.gl/geo-layers/dist.min.js`.
  - Loads `engine.js` which ensures the UMDs are ready, then injects `deck.app.js` with cache‑busting from `<meta name="app-build">`.
  - Three‑panel grid: left (controls), center (Deck canvas), right (details).
- `public/engine.js`
  - Robust loader: tries local UMDs first, then CDN; boots `deck.app.js` only after `window.deck` is present.
- `public/deck.app.js`
  - Creates a Deck instance with `useDevicePixels: true` (crisp DPR). No manual DPR clamps.
  - Layers: ScreenGrid density (optional) → Line edges (additive) → Arc flows (additive, brushing) → Scatterplot dots (pixel‑capped, outline, additive, brushing) → overlays.
  - Simple views (DOTS/FLOW/WEB/PULSE/CROWN) exist but rich stack is default.
- `server/index.js`
  - Serves `/lib` from `node_modules`, `public/`, and the API routes.
  - Graph and preset endpoints with ETag/TTL; `/api/precomputed/*` as fast path.
- `jobs/*`
  - Pulls holders/activity/listings from Modularium and Ethos; computes metrics; saves to SQLite.

## Debug checklist (when canvas looks empty)
1) Hard refresh (Cmd+Shift+R) — invalidates sticky assets.
2) Network tab:
   - `/lib/deck.gl/dist.min.js` returns 200.
   - `/engine.js?v=…` → `/deck.app.js?v=…` injected.
   - `/api/graph?mode=holders&edges=200` returns JSON with `nodes`.
3) DOM/Console:
   - DOM contains `.center-panel #deck-canvas`.
   - Console shows: `deck.app: boot` and `engine: deck.app injected`.
4) Data sanity: `/api/preset-data?nodes=10000` returns keys; `/api/health` shows `haveDb: true`.

## Non‑breaking tasks an LLM can tackle
- Add UI toggles for density overlay and brushing radius.
- Add lightweight text labels on zoom (TextLayer) for whales/rare tokens.
- Add small error toast/banner when any API call fails.
- Improve culling/LOD for zoomed‑out views.

## Style + brand rules
- Black background, neon green `#00ff66` (variables in tokens.css), mono fonts (Fira Code/IBM Plex Mono), subtle glow.
- Keep borders: `1px solid rgba(0,255,102,.2)`; spacing via tokens.

## Gotchas
- Do not reintroduce manual DPR clamps or canvas sizing — Deck manages DPR.
- Keep edges ≤ 500 for perf; use pixel units (widthMinPixels).
- Simple views must still fall back to live `/api/graph` data to avoid blank states.

If you change rendering or data flows, keep changes surgical and reversible. Do not alter server endpoint shapes unless coordinated with jobs and frontend.
