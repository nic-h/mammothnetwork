import { spawnSync } from 'node:child_process';

function run(cmd, env = {}) {
  const [c, ...args] = cmd.split(' ');
  console.log('>', cmd);
  const r = spawnSync(c, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status || 1);
}

run('node scripts/db.migrate.js');
// Fill metadata/images first (optional images if DOWNLOAD_IMAGES=1)
run('node jobs/sync-metadata.js', { DOWNLOAD_IMAGES: process.env.DOWNLOAD_IMAGES || '0', METADATA_CONC: process.env.METADATA_CONC || '8', START_ID: process.env.START_ID || '', END_ID: process.env.END_ID || '' });
run('node jobs/sync-holders.js');
run('node jobs/sync-activity.js');
run('node jobs/enrich-wallets.js');
run('node jobs/ethos.js');
// Precompute edges for all modes (holders, transfers, traits)
run('node jobs/compute-edges.js', { MODE: 'holders', EDGES: process.env.EDGES || '500' });
run('node jobs/compute-edges.js', { MODE: 'transfers', EDGES: process.env.EDGES || '500' });
run('node jobs/compute-edges.js', { MODE: 'traits', EDGES: process.env.EDGES || '500' });
// Listings + classifications + similarity
run('node jobs/sync-listings.js', { LISTINGS_PAGES: process.env.LISTINGS_PAGES || '50' });
run('node jobs/classify-wallets.js');
run('node jobs/build-similarity.js');
