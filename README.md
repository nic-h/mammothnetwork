Mammoths Network — Local Cache + Neon Viewer

Quick Start

- Install: `npm install`
- Init DB + folders: `npm run init-db`
- Migrate for status columns: `npm run migrate-db`
- Fetch all metadata + images (10k): `npm run fetch-all`
- Owners and frozen (via Modularium): `npm run owners-mod`
- Dormant flags (activity scan): `npm run update-dormant`
- Run server: `npm start` → open `http://localhost:3001`

What It Does

- Local cache in `data/mammoths.db` (SQLite)
- Optimizes art: full JPG (~800px) + thumbnail JPG (512px) via `sharp`
- Static serving with cache headers at `/images` and `/thumbnails`
- Progressive client load: nodes render immediately; owners/traits/status fill in batches

UI/UX (index.html)

- Tokens view: 10k crisp neon dots on black; zoom/pan; hover tooltip; click → detail panel
- Owners view (toggle in left pane): wallet bubbles ↔ mammoth nodes; search wallet or token
- Status filters: All / Active / Frozen / Dormant (server-backed counts at `/api/status-counts`)
- Trait filters: click a trait value to instantly show only matching tokens (server-backed `/api/ids-by-trait`)
- Edges: link nodes in the active trait cluster (cap adjustable)
- Selection: bright ring around the clicked token; detail shows owner, image source (LOCAL/REMOTE), and all attributes

Data Fill Paths

- Metadata + Images: `npm run fetch-all` (resumable, safe to rerun)
- Owners + Frozen: `npm run owners-mod` (Modularium holders/minters + frozenBalance)
- Dormant: `npm run update-dormant` (scans collection activity; window configurable via `DORMANT_DAYS`)
- Optional on-chain ownerOf: `RPC_URL=... npm run fetch-owners` (strict chain truth)

API Endpoints (served by `server.js`)

- `GET /api/stats` — collection stats
- `GET /api/token-ids` — all token IDs
- `GET /api/token/:id` — one token (owner, status, metadata, image paths)
- `GET /api/tokens-batch?ids=...` — batch of tokens (for progressive loading)
- `GET /api/traits` — trait counts
- `GET /api/ids-by-trait?type=X&value=Y` — token IDs for a specific trait value
- `GET /api/status-counts` — `{ frozen, dormant, active, total }`
- `GET /api/owners-graph` — wallet↔mammoth bipartite graph for owners view

Config

- `DATA_DIR`: where DB and images live (default `./data`)
- `CONTRACT_ADDRESS`: default Mammoths contract
- `MOD_API`: default `https://api.modularium.art`
- `DORMANT_DAYS`: window for dormant classification (default 45)

Notes

- While `fetch-all` is running, images render via an HTTP IPFS gateway; once thumbnails exist, the UI automatically switches to LOCAL paths.
- All scripts are idempotent and safe to re-run.
