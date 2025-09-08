import { spawnSync } from 'node:child_process';

function run(cmd, env = {}) {
  const [c, ...args] = cmd.split(' ');
  console.log('>', cmd);
  const r = spawnSync(c, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status || 1);
}

run('node scripts/db.migrate.js');
run('node jobs/sync-holders.js');
run('node jobs/sync-activity.js');
run('node jobs/enrich-wallets.js');
// Precompute edges for all modes (holders, transfers, traits)
run('node jobs/compute-edges.js', { MODE: 'holders', EDGES: process.env.EDGES || '500' });
run('node jobs/compute-edges.js', { MODE: 'transfers', EDGES: process.env.EDGES || '500' });
run('node jobs/compute-edges.js', { MODE: 'traits', EDGES: process.env.EDGES || '500' });
