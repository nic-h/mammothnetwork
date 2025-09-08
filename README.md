Mammoths Network Visualization
=============================

WebGL graph viewer for the Mammoths NFT collection.

Key points
- PIXI.js v7 WebGL rendering (no Canvas2D/D3)
- 10,000 NFT nodes as colored dots (no thumbnails)
- Worker-based force simulation for smooth 60fps rendering
- Minimal design (monospace, black/white/green)
- SQLite backend with cached metadata and local images (images are not used in nodes)
- Render.com deployment with persistent disk

Run locally
1. Install deps: `npm install`
2. Start server: `npm run dev` (defaults to http://localhost:3000)
3. Optional: point to a DB: `DB_PATH=/absolute/path/to/mammoths.db npm run dev`

Endpoints
- `/api/network-graph?mode=holders|transfers|traits&nodes=10000&edges=0..500` (alias: `/api/graph`)
- `/api/token/:id`
- `/api/wallet/:address`
- `/api/stats`
- `/api/activity`
- `/api/health`

Render.com
- `render.yaml` provisions a persistent disk mounted at `/data`
- Place your SQLite file at `/data/mammoths.db` (or set `DATABASE_PATH`)
- Add a separate Render Cron Job to run `node jobs/run-all.js` weekly (holders → activity → edges → enrichment)

Performance notes
- Nodes render via `PIXI.ParticleContainer(10000)` using a single generated circle texture (cheap instancing)
- Force simulation runs in a Web Worker using a uniform grid for local repulsion + spring edges
- Positions stream to the main thread at ~30Hz to reduce overhead; rendering remains at 60fps
- Edge pass drawn with `PIXI.Graphics` when edges <= 500, with viewport culling
- Server uses Brotli/gzip compression and a 5-minute memory cache + ETag

Design system
- Colors and typography align with dash.mammoths.tech (monospace, black/white/green)

Modularium
- Use offline jobs to fetch/cache data; runtime reads only from SQLite. See `jobs/` for placeholders.

Environment
- Copy `.env.example` to `.env` and set `DATABASE_PATH` as needed (or export env var in Render)
