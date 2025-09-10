Mammoths Network Visualization
=============================

WebGL network for the Mammoths NFT collection.

Features
- PIXI v7 WebGL (UMD at `/lib/pixi.min.js`), 10k nodes via `PIXI.ParticleContainer`
- Worker physics (uniform‑grid repulsion + springs) and preset forces
- Modes: `holders`, `transfers`, `traits`, `wallets`
- Presets: Ownership, Trading, Trait Clusters, Social, Rarity, Activity, Hubs, Whales, Frozen, Discovery
- Charts: timeline (count+volume), heatmap (7×24)
- Detail sidebar: owner, ENS, Ethos v2 (user+score), holdings, trades, last activity, traits, thumbnail
- Status vis: frozen (blue), dormant (gray alpha)
- Grid background, zoom buttons, fullscreen, settings (grid/LOD), mobile fallback

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

Endpoints
- `/api/network-graph?mode=holders|transfers|traits|wallets&nodes=10000&edges=0..500` (alias `/api/graph`)
- `/api/preset-data?nodes=10000`
- `/api/token/:id`
- `/api/wallet/:address`, `/api/wallet/:address/meta`
- `/api/ethos/profile?address=0x…` (v2 user + score)
- `/api/activity?interval=day|hour`, `/api/heatmap`, `/api/stats`, `/api/health`

Render.com
- Persistent disk via `render.yaml`
- Set env: `DATABASE_PATH=/data/mammoths.db`, `CONTRACT_ADDRESS`, `MODULARIUM_API`, `ETHOS_API`, `ETHOS_BASE`, `ETHOS_CLIENT`
- First boot: `npm run db:init` then `npm run jobs:all` in the Render shell
- Weekly cron (included) runs `node jobs/run-all.js`

Performance
- Edge cap ≤ 500; per‑token degree caps; viewport culling; LOD decimation when zoomed out
- Worker ~30Hz → main 60fps; resolution capped ≤ 2; WebGL guard
- Grid is cheap; charts are lightweight Canvas overlay

Design system
- Colors and typography align with dash.mammoths.tech (monospace, black/white/green)
- See docs/TECH_SPEC.md for the living spec and proposed design tokens

Modularium + Ethos
- Jobs fill tokens/attributes/holders/transfers (with price) and wallet_metadata (Ethos v2 batch)
- Runtime reads only from SQLite; on‑demand Ethos proxy (`/api/ethos/profile`) caches 24h

Notes
- PIXI v7 UMD build is served at `/lib/pixi.min.js`; the app uses `new PIXI.Application({ ... })` and `app.view`
- Images: served at `/images`; thumbnails at `/thumbnails` (nodes never load images)
- If better‑sqlite3 native errors: `npm rebuild better-sqlite3 --build-from-source`

Codex system instructions
- Launch Codex with the repo’s system rules: `codex chat --system-file SYSTEM.md`
