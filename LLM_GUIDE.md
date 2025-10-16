# Mammoths Network — LLM Contributor Guide (Three.js)

This guide gives Codex (and any new engineer) the minimum context needed to make safe, surgical changes without regressing the live Three.js renderer.

## TL;DR
- Frontend: `client/three/app.js` bundles via esbuild to `public/three.app.js`; loaded by `public/engine.js` inside `public/index.html` with shared styles in `public/style.css`.
- Backend: Express server in `server/index.js` with SQLite helpers in `server/db.js` and cached graph endpoints.
- Data jobs: scripts in `jobs/` hydrate SQLite from Modularium + Ethos; run them with `node --env-file=.env jobs/<name>.js` or `npm run jobs:all`.
- Graph data: `/api/graph?mode=holders|transfers|traits|wallets&edges=0..500`, `/api/preset-data?nodes=10000`, `/api/transfer-edges`.
- Details: `/api/token/:id`, `/api/wallet/:address`, `/api/wallet/:address/meta`, `/api/ethos/profile`.
- **Hard rule:** never ship synthetic layouts. Every view must use the real Mammoths dataset from SQLite or `/api/precomputed/*`. If the DB is empty, show an error/blank state—do **not** fall back to spirals, donuts, or randomized grids, and do not drop dormant/frozen/whale styling cues.

## Renderer TODOs (Do these before anything else)
1. **Stop fabricating geometry** – strip the radial/linear projections from `buildTokenNodes`; read the canonical `token_layout` coordinates and only apply minimal collision smoothing.
2. **Restore color semantics** – ensure dormant (#666), frozen (#4488ff), whale (danger red), active green survive all cloning/transforms.
3. **Re-enable view-specific logic** – FLOW should render transfer arcs, TREE the lineage layout, RHYTHM the time × price projection. If all views look identical, you’re ignoring the data.
4. **Regenerate screenshots** – after the fixes, run `npm run test:ui` and commit the updated captures to `artifacts/ui/` as proof.

Treat the list above as blocking work. Do not add new features until these regressions are fixed and demonstrated with screenshots.

## How to Run (fast path)
1. `npm ci`
2. Load env + migrate:
   ```
   set -a; source .env; set +a
   npm run db:migrate
   ```
3. Populate cache (idempotent):
   ```
   npm run jobs:all
   ```
4. Start the dev server: `PORT=3001 npm run dev`
5. Open http://localhost:3001?force=1 (bypasses cached graphs on first load).

## Anatomy
- `public/index.html`
  - Inline UI scaffolding for the three-panel layout.
  - Loads `engine.js`, which dynamically imports `/three.app.js?v=<meta app-build>`.
- `public/engine.js`
  - Waits for DOM ready, then `import()`s `three.app.js`. Logs success/failure to the console.
- `client/three/app.js`
  - Builds the ForceGraph3D scene (nodes, edges, presets, sidebar sync) using Three.js + custom sprite materials.
  - Exposes `window.mammoths.focusToken(id)` and `window.mammoths.setSimpleView(name)` for automation/scripts.
- `server/index.js`
  - Serves static assets, runs migrations, and exposes the API (`/api/graph`, `/api/preset-data`, `/api/token/:id`, etc.) with ETag + TTL caching.
- `jobs/*.js`
  - Modularium/Ethos ingestion, wallet enrichment, edge precomputation, similarity builds. Safe to re-run.

## Debug Checklist (blank canvas triage)
1. Hard refresh (Cmd+Shift+R).
2. Network tab:
   - `/three.app.js?v=…` returns 200 (no 404/500).
   - `/api/graph?mode=holders&edges=200&force=1` returns nodes.
3. DOM & console:
   - `.center-panel #three-stage` exists.
   - `window.__mammothDrawnFrame === true` after first render.
   - Console contains `engine: three.app module loaded` (no import errors).
4. Data sanity: `/api/preset-data?nodes=10000` has owners array; `/api/health` → `{ ok: true, haveDb: true }`.

## Low-Risk Tasks for Codex
- UI polish (tokens-only CSS tweaks, new toggles, copy updates).
- Sidebar enhancements that don't change API shapes.
- Sprite/edge styling adjustments that stay within ForceGraph3D APIs.
- Additional Playwright waits/assertions using `window.__mammothDrawnFrame` or `window.mammoths.*` helpers.

## Brand & UX Rules
- Palette: black background, neon green `#00ff66`, frozen blue `#4488ff`, dormant gray `#666666` (tokens defined in `public/client/styles/tokens.css`).
- Typography: monospace stack (Fira Code/IBM Plex Mono). Respect existing spacing tokens and border radii.
- Edge cap: keep UI + API limited to ≤500 edges by default (force=1 path only for debugging).

## Gotchas
- Do **not** reintroduce legacy WebGL engines or PIXI assets; Three.js is the single source of truth.
- Avoid manipulating canvas size manually; ForceGraph3D already responds to ResizeObserver.
- Keep file writes idempotent—migrations and jobs must never drop data.
- Scripts rely on `node --env-file=.env`; ensure new jobs follow the same pattern.

When in doubt, search the repo for existing patterns (e.g., `viewNodes`, `renderTreeView`, TTL cache usage) and mirror them. Keep changes small, explain rationale in docs/PR descriptions, and run `npm run db:migrate && npm run dev` locally to validate before sharing.
