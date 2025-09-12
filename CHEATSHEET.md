# Mammoths Network – Cheat Sheet

## Install & Run
- Install deps: `npm install`
- Init DB: `npm run db:init`
- Populate data: `npm run jobs:all`
- Dev server: `npm run dev` → http://localhost:3000

## Environment (min)
- `CONTRACT_ADDRESS=<0x...>`
- `MODULARIUM_API=https://api.modularium.art`
- `ETHOS_API=https://api.ethos.network`
- Optional: `DATABASE_PATH`, `DOWNLOAD_IMAGES=1`, `ROYALTY_BPS=250`

## Common Jobs
- All jobs (ordered): `npm run jobs:all`
- Holders only: `node jobs/sync-holders.js`
- Activity only: `node jobs/sync-activity.js` (use `FULL=1` to backfill)
- Wallet metrics: `node jobs/compute-wallet-metrics.js`
- Token metrics: `node jobs/compute-token-metrics.js`

## Quick API
- Graph: `/api/graph?mode=holders|transfers|traits|wallets&nodes=10000&edges=0..500`
- Preset data: `/api/preset-data?nodes=10000`
- Token: `/api/token/:id`
- Wallet: `/api/wallet/:address`, `/api/wallet/:address/meta`
- Transfer edges: `/api/transfer-edges?limit=500&nodes=10000`
- Listings: `/api/token/:id/listings`
- Similar by traits: `/api/token/:id/similar-advanced`
- Stats/health: `/api/stats`, `/api/health`

## Curl Snippets
```
# Graph node count
curl -s 'http://localhost:3000/api/graph?mode=holders&nodes=500&edges=0' | jq '.nodes|length'

# Preset payload keys
curl -s 'http://localhost:3000/api/preset-data?nodes=10000' | jq 'keys'

# One transfer edge sample
curl -s 'http://localhost:3000/api/transfer-edges?limit=25' | jq '.[0]'

# Wallet meta
curl -s 'http://localhost:3000/api/wallet/0xDEADCAFEBEEF/meta' | jq .
```

## SQLite Sanity
```
sqlite3 ./data/mammoths.db ".tables"
sqlite3 -json ./data/mammoths.db "SELECT (SELECT COUNT(*) FROM tokens) AS tokens,
                                       (SELECT COUNT(*) FROM attributes) AS attrs,
                                       (SELECT COUNT(*) FROM transfers) AS xfers,
                                       (SELECT COUNT(*) FROM wallet_metadata) AS wallets;"
```
