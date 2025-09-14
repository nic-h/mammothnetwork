# Dev Triage – Mammoths Network

Use this checklist to verify a working local/dev deployment and to diagnose “blank canvas”, “no data”, or “no images”. All commands assume repo root.

## 0) Quick Checklist
- Server responds: `/api/health` → `{ ok:true }`
- DB has rows: tokens > 0, transfers > 0
- Graph responds: `/api/graph` has nodes
- Preset arrays respond: `/api/preset-data` has owners
- Canvas exists: an element `#deck-canvas` added to `.center-panel`
- Selecting a token opens sidebar with text + image

## 1) Server up
```
curl -s http://localhost:3000/api/health
```
Expected: `{ ok: true, haveDb: true }`. If not, run `npm run dev` and check `server.log`.

## 2) DB counts (sanity)
```
node -e "import { openDatabase } from './server/db.js'; const { db }=openDatabase(process.cwd()); const q=a=>db.prepare(a).get(); console.log({ tokens:q('SELECT COUNT(1) c FROM tokens').c, transfers:q('SELECT COUNT(1) c FROM transfers').c, holders:q('SELECT COUNT(DISTINCT LOWER(owner)) c FROM tokens WHERE owner IS NOT NULL AND owner<>""').c }); db.close();"
```
If any count is 0, run the jobs (see step 7).

## 3) Core endpoints
```
curl -s http://localhost:3000/api/graph | jq '.nodes|length'
curl -s http://localhost:3000/api/preset-data | jq '.owners|length'
```
Expected: both > 0. If graph nodes is 0, DB likely empty or server not restarted.

## 4) Precomputed endpoints (optional fast path)
```
curl -s http://localhost:3000/api/precomputed/wallets | jq '.wallets|length'
curl -s http://localhost:3000/api/precomputed/edges?window=30d | jq '.edges|length'
curl -s http://localhost:3000/api/precomputed/tokens | jq '.tokens|length'
```
Notes:
- If these return HTML, restart the server (old process didn’t load the new routes).
- Simple views (DOTS/FLOW/WEB/PULSE/CROWN) fall back to live `/api/graph` nodes/edges when these are empty, so the canvas should still render.

## 5) Images
- Files: `data/thumbnails/:id.jpg` (or `data/images/:id.jpg`).
- API fallback: `GET /api/token/:id` returns `thumbnail_local`/`image_local` if DB columns exist; server also falls back to disk paths automatically.

## 6) Frontend ready
Open the app and check DevTools Console:
- No “Deck.gl UMD not found” error
- DOM contains `.center-panel #deck-canvas`
- Panels are clickable (search and left/right UI should not be blocked by canvas)

## 7) Populate data (minimal path)
```
export CONTRACT_ADDRESS=0xbE25A97896b9CE164a314C70520A4df55979a0c6
export MODULARIUM_API=https://api.modularium.art
export ETHOS_API=https://api.ethos.network
node jobs/sync-metadata.js
node jobs/sync-holders.js
node jobs/sync-activity.js
node jobs/compute-token-metrics.js
node jobs/enrich-wallets.js
node jobs/precompute-layouts.js
```
Full pipeline: `npm run jobs:all` (adds listings, edges similarity, etc.).

## 8) Force render
- Use the top‑right search: type a token id (e.g. `724`) and press Enter.
- Or DevTools console:
```
window.mammoths?.focusToken?.(724)
```
You should see a selection ring and the right panel populated.

## 9) Screenshots (prove it)
```
npm ci && npx playwright install
PREVIEW_IDS=1000,724,1472 PREVIEW_VARIANTS=1 node scripts/ui.screenshots.js
```
The script forces a selection and waits until the sidebar and image are present before capture.

## 10) Common fixes
- Restart server after code changes: `npm run dev`.
- `force=1` bypasses caches: `GET /api/graph?mode=holders&nodes=10000&edges=200&force=1`.
- If `/api/precomputed/*` respond with HTML, your old server process is still running.
- If images don’t show, confirm files in `data/thumbnails/` and check the `image_local/thumbnail_local` columns in `tokens`.

## 11) When filing a bug
Please include:
- Output of steps 1–4
- Browser console errors (if any)
- `server.log` tail and OS/browser versions

