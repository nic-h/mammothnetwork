export class TTLCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttl = ttlMs;
    this.map = new Map(); // key -> { value, etag, expiry }
  }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    if (v.expiry < Date.now()) { this.map.delete(key); return null; }
    return v;
  }
  set(key, value, etag) {
    this.map.set(key, { value, etag, expiry: Date.now() + this.ttl });
  }
  purge() {
    const now = Date.now();
    for (const [k, v] of this.map.entries()) if (v.expiry < now) this.map.delete(k);
  }
}

