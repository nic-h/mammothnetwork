// Robust Deck loader with offline→CDN fallback, then boot app
(function () {
  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;   // preserve order
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error('load failed: ' + src));
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function ready() { return !!(window.deck && window.deck.Deck); }

  async function ensureDeck() {
    if (ready()) return;

    // Try local UMDs first
    const deckCandidates = [
      '/lib/deck.gl/dist.min.js',
      '/lib/deck.gl/umd/deck.gl.min.js',
      'https://unpkg.com/deck.gl@8.9.24/dist.min.js'
    ];
    for (const src of deckCandidates) {
      try { await load(src); } catch {}
      if (ready()) break;
    }
    if (!ready()) throw new Error('Deck UMD not found after load');

    // Optional extras (don’t block if missing)
    const geoCandidates = [
      '/lib/@deck.gl/geo-layers/dist.min.js',
      '/lib/@deck.gl/geo-layers/umd/geo-layers.min.js',
      'https://unpkg.com/@deck.gl/geo-layers@8.9.24/dist.min.js'
    ];
    for (const src of geoCandidates) { try { await load(src); } catch {} }
  }

  function ver() {
    return (
      document.querySelector('meta[name="app-build"]')?.content ||
      String(Date.now())
    );
  }

  async function boot() {
    try { await ensureDeck(); }
    catch (e) { console.error(e.message); return; }
    await load('/deck.app.js?v=' + ver());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
