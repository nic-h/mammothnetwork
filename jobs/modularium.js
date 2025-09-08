// Lightweight Modularium client with fallback endpoints. ESM, Node >=20.
const BASE = process.env.MODULARIUM_API || 'https://api.modularium.art';
const CONTRACT = (process.env.CONTRACT_ADDRESS || '').toLowerCase();

function urlJoin(...parts) {
  return parts.map((p, i) => (i === 0 ? p.replace(/\/$/, '') : p.replace(/^\//, '').replace(/\/$/, ''))).join('/')
}

async function tryJson(urls, init) {
  for (const u of urls) {
    try {
      const r = await fetch(u, init);
      if (r.ok) return await r.json();
    } catch {}
  }
  throw new Error('All endpoints failed: ' + urls.join(' | '));
}

export async function fetchCollectionStats() {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, 'stats'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'stats'),
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, 'stats'),
  ];
  return await tryJson(urls);
}

export async function fetchTokenIds() {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, 'token-ids'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'token-ids'),
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, 'token-ids'),
  ];
  const data = await tryJson(urls);
  return Array.isArray(data) ? data : (data.ids || []);
}

// Try a direct holders endpoint to avoid N calls
export async function fetchHolders() {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, 'holders'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'holders'),
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, 'holders'),
    urlJoin(BASE, 'collection', CONTRACT, 'owners'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'owners'),
  ];
  const data = await tryJson(urls);
  if (Array.isArray(data)) return data; // [{tokenId, owner}] or [{id, owner}]
  if (data && Array.isArray(data.items)) return data.items;
  // Map form { tokenId: owner }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([k, v]) => ({ tokenId: Number(k), owner: String(v) }));
  }
  return [];
}

export async function fetchTokenMeta(id) {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, String(id)),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, String(id)),
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, String(id)),
  ];
  return await tryJson(urls);
}

// Returns array of transfers: { token_id, from, to, timestamp }
export async function fetchTransfers({ since, limit = 5000 } = {}) {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const qs = new URLSearchParams();
  if (since) qs.set('since', String(since));
  if (limit) qs.set('limit', String(limit));
  const suffix = qs.toString() ? ('?' + qs.toString()) : '';
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, 'transfers') + suffix,
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'transfers') + suffix,
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, 'transfers') + suffix,
    urlJoin(BASE, 'collection', CONTRACT, 'activity') + suffix,
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'activity') + suffix,
  ];
  const data = await tryJson(urls);
  const arr = Array.isArray(data) ? data : (data.items || data.events || []);
  return arr.map(ev => ({
    token_id: Number(ev.tokenId || ev.token_id || ev.id),
    from: (ev.from || ev.from_address || ev.seller || null)?.toLowerCase?.() || null,
    to: (ev.to || ev.to_address || ev.buyer || null)?.toLowerCase?.() || null,
    timestamp: Number(ev.blockTime || ev.timestamp || ev.time || Date.parse(ev.time || 0)/1000) || null,
  })).filter(x => x.token_id > 0);
}

// Attempt holders map via metadata fallback if no direct endpoint
export async function fetchHoldersViaMetadata(ids, { concurrency = 10 } = {}) {
  const out = new Map();
  let idx = 0; let active = 0; let err = 0;
  return await new Promise(resolve => {
    const next = async () => {
      if (idx >= ids.length && active === 0) return resolve(out);
      while (active < concurrency && idx < ids.length) {
        const id = ids[idx++];
        active++;
        (async () => {
          try {
            const meta = await fetchTokenMeta(id);
            const owner = (meta.owner || meta.currentOwner || meta.holder || null);
            if (owner) out.set(id, owner.toLowerCase());
          } catch { err++; }
          active--; next();
        })();
      }
    };
    next();
  });
}

export function envEnabled() {
  return !!(process.env.MODULARIUM_API && process.env.CONTRACT_ADDRESS);
}
