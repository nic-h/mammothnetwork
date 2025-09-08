// Ethos v2 lightweight proxy with in-memory TTL cache (ESM)
const ETHOS_BASE = process.env.ETHOS_BASE || 'https://api.ethos.network';
const ETHOS_CLIENT = process.env.ETHOS_CLIENT || 'mammothnetwork/dev';

const cache = new Map(); // key -> { t, ttl, data }
function put(key, data, ttlMs) { cache.set(key, { t: Date.now(), ttl: ttlMs, data }); }
function get(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > v.ttl) { cache.delete(key); return null; }
  return v.data;
}

async function ethosFetchJson(path) {
  const url = `${ETHOS_BASE}${path}`;
  const res = await fetch(url, { headers: { 'X-Ethos-Client': ETHOS_CLIENT, 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`Ethos ${path} ${res.status}`);
  return await res.json();
}

export async function getEthosForAddress(address) {
  // v2 user + score by address
  try {
    const key = `ethos:v2:user:${address.toLowerCase()}`;
    const hit = get(key);
    let user;
    if (hit) {
      user = hit;
    } else {
      user = await ethosFetchJson(`/api/v2/user/by/address/${address}`);
      put(key, user, 24*60*60*1000);
    }
    const score = await ethosFetchJson(`/api/v2/score/address?address=${address}`).catch(()=>null);
    if (!user) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      id: user.id ?? null,
      displayName: user.displayName || null,
      username: user.username || null,
      avatarUrl: user.avatarUrl || null,
      score: (score && typeof score.score === 'number') ? score.score : (typeof user.score === 'number' ? user.score : null),
      level: score?.level || null,
      links: user.links || null,
    };
  } catch (e) {
    return { ok: false, error: 'ethos-v2-failed' };
  }
}
