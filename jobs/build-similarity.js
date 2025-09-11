import 'dotenv/config';
import { openDatabase, runMigrations } from '../server/db.js';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { db } = openDatabase(ROOT);
if (!db) { console.error('DB not found'); process.exit(1); }
runMigrations(db);

function jaccard(a, b){
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x=>B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter/union : 0;
}

async function main(){
  console.log('Building token similarity matrix (traits)...');
  const LIMIT = Number(process.env.SIM_LIMIT || 0);
  const rows = LIMIT > 0
    ? db.prepare('SELECT id FROM tokens WHERE id<=10000 ORDER BY id LIMIT ?').all(LIMIT)
    : db.prepare('SELECT id FROM tokens WHERE id<=10000 ORDER BY id').all();
  const tokenTraits = new Map();
  for (const r of rows){
    const t = db.prepare("SELECT trait_type || ':' || trait_value AS trait FROM attributes WHERE token_id=?").all(r.id).map(x=>x.trait);
    tokenTraits.set(r.id, t);
  }
  const insert = db.prepare("INSERT OR REPLACE INTO token_similarity (token_a, token_b, similarity, similarity_type) VALUES (?, ?, ?, 'trait')");
  let count = 0; const THRESH = 0.3;
  const tx = db.transaction(()=>{
    for (let i=0;i<rows.length;i++){
      for (let j=i+1;j<rows.length;j++){
        const a = tokenTraits.get(rows[i].id)||[];
        const b = tokenTraits.get(rows[j].id)||[];
        const s = jaccard(a,b);
        if (s>THRESH){ insert.run(rows[i].id, rows[j].id, s); insert.run(rows[j].id, rows[i].id, s); count++; }
      }
      if (i % 100 === 0) process.stdout.write(`\rProcessed ${i}/${rows.length} tokens, ${count} pairs`);
    }
  });
  tx();
  console.log(`\nSimilarity matrix built: ${count} similarities`);

  const cluster = db.prepare(`
    SELECT token_a, COUNT(*) AS similar_count, AVG(similarity) AS avg_similarity
    FROM token_similarity WHERE similarity>0.7 GROUP BY token_a HAVING similar_count>5 ORDER BY similar_count DESC LIMIT 20
  `).all();
  console.log(`Found ${cluster.length} high-similarity clusters`);

  try { fs.mkdirSync(path.join(ROOT, 'data', '.checkpoints'), { recursive: true }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'data', '.checkpoints', 'build-similarity.txt'), new Date().toISOString() + ` similarities=${count}\n`);
}

try { await main(); } finally { db.close(); }
