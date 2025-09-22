// Three.js engine loader with cache-busted dynamic import
(async function () {
  function ver() {
    return (
      document.querySelector('meta[name="app-build"]')?.content ||
      String(Date.now())
    );
  }

  async function boot() {
    try {
      await import(`/three.app.js?v=${ver()}`);
      console.info('engine: three.app module loaded');
    } catch (err) {
      console.error('engine: three boot failed', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
