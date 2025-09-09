import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';
import { fetchWalletFreezes } from './modularium.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

const CONC = Math.max(1, Math.min(8, Number(process.env.FREEZE_CONC || 5)));

async function main() {
  const owners = db.prepare("SELECT DISTINCT LOWER(owner) AS a FROM tokens WHERE owner IS NOT NULL AND owner<>''").all().map(r=>r.a);
  const frozenSet = new Set();

  let idx = 0, active = 0, done = 0;
  await new Promise(resolve => {
    const next = () => {
      if (done >= owners.length && active === 0) return resolve();
      while (active < CONC && idx < owners.length) {
        const addr = owners[idx++];
        active++;
        (async () => {
          try {
            const ids = await fetchWalletFreezes(addr);
            for (const n of ids) frozenSet.add(n);
          } catch {}
          done++; active--; next();
        })();
      }
    };
    next();
  });

  const tx = db.transaction(() => {
    db.exec('UPDATE tokens SET frozen=0');
    const up = db.prepare('UPDATE tokens SET frozen=1 WHERE id=?');
    for (const n of frozenSet) up.run(n);
  });
  tx();

  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'sync-freezes-wallets.txt'), new Date().toISOString() + ` frozen=${frozenSet.size}\n`);
  console.log('sync-freezes-wallets complete; frozen tokens:', frozenSet.size);
}

try { await main(); } finally { db.close(); }

