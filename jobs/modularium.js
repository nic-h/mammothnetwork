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

// Wallet freezes for a specific contract (defensive query param names)
export async function fetchWalletFreezes(address) {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const addr = (address || '').toLowerCase();
  const params = [
    `contract=${CONTRACT}`,
    `collection=${CONTRACT}`,
    `contractAddress=${CONTRACT}`,
  ];
  const urls = [
    ...params.map(q => urlJoin(BASE, 'wallet', addr, 'freezes') + '?' + q),
  ];
  const data = await tryJson(urls).catch(()=>([]));
  // Normalize to array of token ids
  const out = [];
  if (Array.isArray(data)) {
    for (const row of data) {
      if (typeof row === 'number' || typeof row === 'string') out.push(Number(row));
      else if (row && typeof row === 'object') {
        const id = row.tokenId ?? row.token_id ?? row.id ?? null;
        const fro = row.frozen ?? row.isFrozen ?? true; // endpoint implies frozen rows
        if (id != null && fro) out.push(Number(id));
      }
    }
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) {
      for (const r of data.items) {
        const id = r.tokenId ?? r.token_id ?? r.id ?? null;
        if (id != null) out.push(Number(id));
      }
    }
  }
  return out.filter(n => Number.isFinite(n) && n > 0);
}

// Fetch frozen tokens for a collection. Tries multiple endpoints and shapes.
export async function fetchFrozenTokens() {
  if (!CONTRACT) throw new Error('CONTRACT_ADDRESS not set');
  const urls = [
    urlJoin(BASE, 'collection', CONTRACT, 'frozen'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'frozen'),
    urlJoin(BASE, 'v1', 'collections', 'forma', CONTRACT, 'frozen'),
    urlJoin(BASE, 'collection', CONTRACT, 'token-status'),
    urlJoin(BASE, 'collection', CONTRACT, 'token-flags'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'token-status'),
    urlJoin(BASE, 'v1', 'collection', CONTRACT, 'tokens'),
  ];
  let data = [];
  try { data = await tryJson(urls); } catch { data = []; }
  const out = new Set();
  const push = (v) => { const n = Number(v); if (Number.isFinite(n) && n>0) out.add(n); };
  const scanObj = (o) => {
    const id = o?.tokenId ?? o?.id ?? o?.token_id ?? null;
    const fro = o?.frozen ?? o?.isFrozen ?? (o?.flag==='frozen') ?? (o?.status==='frozen');
    if (fro && id!=null) push(id);
  };
  if (Array.isArray(data)) {
    for (const it of data) {
      if (typeof it === 'number' || typeof it === 'string') push(it);
      else if (it && typeof it === 'object') scanObj(it);
    }
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) {
      for (const it of data.items) scanObj(it);
    } else {
      for (const [k, v] of Object.entries(data)) if (v===true || (v&&v.frozen)) push(k);
    }
  }
  return Array.from(out.values()).sort((a,b)=>a-b);
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
  return arr.map(ev => {
    // best-effort price extraction (ETH)
    let price = null;
    const cand = [ev.price, ev.salePrice, ev.ethPrice, ev.amount, ev.value];
    for (const c of cand) {
      if (c == null) continue;
      if (typeof c === 'number') { price = c; break; }
      if (typeof c === 'string') {
        const s = c.trim();
        if (/^\d+(\.\d+)?$/.test(s)) { price = Number(s); break; }
        // wei to ETH if big int
        if (/^\d{15,}$/.test(s)) { price = Number(s) / 1e18; break; }
      }
    }
    const tx_hash = ev.txHash || ev.transactionHash || ev.hash || null;
    const event_type = ev.eventType || ev.type || null;
    return {
      token_id: Number(ev.tokenId || ev.token_id || ev.id),
      from: (ev.from || ev.from_address || ev.seller || null)?.toLowerCase?.() || null,
      to: (ev.to || ev.to_address || ev.buyer || null)?.toLowerCase?.() || null,
      timestamp: Number(ev.blockTime || ev.timestamp || ev.time || Date.parse(ev.time || 0)/1000) || null,
      price,
      tx_hash,
      event_type,
    };
  }).filter(x => x.token_id > 0);
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
