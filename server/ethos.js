// Ethos lightweight proxy with in-memory TTL cache (ESM)
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

async function ethosSearchByQuery(q) {
  const key = `ethos:search:${q.toLowerCase()}`;
  const hit = get(key); if (hit) return hit;
  const json = await ethosFetchJson(`/api/v1/search?query=${encodeURIComponent(q)}&limit=1`);
  put(key, json, 24*60*60*1000);
  return json;
}

async function ethosUserStats(userkey) {
  const key = `ethos:stats:${userkey}`;
  const hit = get(key); if (hit) return hit;
  const json = await ethosFetchJson(`/api/v1/users/${encodeURIComponent(userkey)}/stats`);
  put(key, json, 24*60*60*1000);
  return json;
}

export async function getEthosForAddress(address) {
  const search = await ethosSearchByQuery(address);
  const first = search?.data?.values?.[0];
  if (!first) return { ok: true, found: false };
  const userkey = first.userkey || (first.profileId ? `profileId:${first.profileId}` : null);
  let stats = null;
  if (userkey) {
    try { stats = await ethosUserStats(userkey); } catch { /* optional */ }
  }
  return {
    ok: true,
    found: true,
    userkey,
    profileId: first.profileId || null,
    primaryAddress: first.primaryAddress || null,
    name: first.name || null,
    username: first.username || null,
    avatar: first.avatar || null,
    score: first.score ?? null,
    links: first.profileId ? {
      profile: `https://app.ethos.network/profile/${first.profileId}`,
      scoreBreakdown: `https://app.ethos.network/profile/${first.profileId}#score`
    } : null,
    stats: stats?.data || null,
  };
}

