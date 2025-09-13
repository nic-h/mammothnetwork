// Engine switcher: use PIXI by default; Deck.gl when ?engine=deck or localStorage.engine='deck'
(function(){
  function getEngine(){
    try{
      const qs = new URLSearchParams(window.location.search);
      const e = (qs.get('engine')||'').toLowerCase();
      if (e==='deck' || e==='pixi') return e;
      const ls = localStorage.getItem('engine');
      if (ls==='deck' || ls==='pixi') return ls;
    } catch {}
    // Default to deck for performance; PIXI available as fallback
    return 'deck';
  }
  const engine = getEngine();
  // Helper to inject a script synchronously in order
  function inject(src, cb){ const s=document.createElement('script'); s.src=src; s.onload=cb||null; document.currentScript.after(s); return s; }
  if (engine==='deck'){
    inject('/deck.app.js?v=20250912-1');
  } else {
    // Ensure PIXI is present before loading main.js
    inject('/lib/pixi.min.js', ()=> inject('/main.js?v=20250912-1'));
  }
})();
