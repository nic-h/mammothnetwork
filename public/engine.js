// Deck.gl bootstrap (no PIXI)
(function(){
  function inject(src, cb){ const s=document.createElement('script'); s.src=src; if(cb) s.onload=cb; (document.head||document.body||document.documentElement).appendChild(s); return s; }
  function ready(){ return !!(window && window.deck && window.deck.Deck); }
  function boot(){ inject('/deck.app.js?v=20250912-1'); }
  if (ready()) { boot(); }
  else {
    let tries = 0; const t = setInterval(()=>{ if (ready()){ clearInterval(t); boot(); } else if (++tries>200){ /* keep waiting a bit longer but don’t boot prematurely */ } }, 50);
  }
})();
