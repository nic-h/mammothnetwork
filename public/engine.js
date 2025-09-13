// Deck.gl bootstrap (no PIXI)
(function(){
  // Deck.gl only. No PIXI fallback.
  function inject(src, cb){ const s=document.createElement('script'); s.src=src; s.onload=cb||null; document.currentScript.after(s); return s; }
  inject('/deck.app.js?v=20250912-1');
})();
