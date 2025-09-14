import { openDatabase } from './server/db.js';
import path from 'path';
const ROOT = process.cwd();
const { db } = openDatabase(ROOT);
const tokens = db.prepare('SELECT COUNT(1) c FROM tokens').get().c;
const transfers = db.prepare('SELECT COUNT(1) c FROM transfers').get().c;
const holders = db.prepare("SELECT COUNT(DISTINCT LOWER(owner)) c FROM tokens WHERE owner IS NOT NULL AND owner<>''").get().c;
console.log(JSON.stringify({ tokens, transfers, holders }));
db.close();
