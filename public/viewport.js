// Lightweight pan/zoom helper for PIXI using global PIXI
// Provides installViewport({ app, world, minScale, maxScale, onZoom })
(function(){
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  window.installViewport = function installViewport(opts){
    const app = opts.app, world = opts.world;
    const minScale = opts.minScale ?? 0.2, maxScale = opts.maxScale ?? 5;
    const onZoom = typeof opts.onZoom === 'function' ? opts.onZoom : function(){};

    app.stage.sortableChildren = true;
    world.sortableChildren = true;
    // start centered with slight zoom-in
    const w = app.renderer.width, h = app.renderer.height;
    world.position.set((1-1.2)*w*0.5, (1-1.2)*h*0.5);
    world.scale.set(1.2);

    let dragging=false; let startX=0, startY=0, startPX=0, startPY=0;
    const view = app.view;

    function pointerDown(e){ dragging=true; startX=e.clientX; startY=e.clientY; startPX=world.position.x; startPY=world.position.y; view.setPointerCapture?.(e.pointerId||0); }
    function pointerMove(e){ if(!dragging) return; const dx=e.clientX-startX, dy=e.clientY-startY; world.position.set(startPX+dx, startPY+dy); }
    function pointerUp(){ dragging=false; }
    function wheel(e){
      e.preventDefault();
      const rect = view.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const old = world.scale.x || 1;
      const f = Math.exp(-(e.deltaY) * (e.ctrlKey?0.0012:0.0007));
      const nx = clamp(old * f, minScale, maxScale);
      const wx = (sx - world.position.x) / old;
      const wy = (sy - world.position.y) / old;
      world.scale.set(nx);
      world.position.x = sx - wx * nx;
      world.position.y = sy - wy * nx;
      onZoom(nx);
    }

    view.addEventListener('pointerdown', pointerDown);
    view.addEventListener('pointermove', pointerMove);
    view.addEventListener('pointerup', pointerUp);
    view.addEventListener('pointerleave', pointerUp);
    view.addEventListener('wheel', wheel, { passive:false });

    function centerOn(x, y, targetScale){
      if (targetScale) world.scale.set(clamp(targetScale, minScale, maxScale));
      const s = world.scale.x || 1;
      const cx = app.renderer.width/2, cy = app.renderer.height/2;
      world.position.x = cx - x*s;
      world.position.y = cy - y*s;
    }

    function resetView(){
      const s = 1.2; world.scale.set(s);
      const cx = app.renderer.width/2, cy = app.renderer.height/2;
      world.position.set((1-s)*cx, (1-s)*cy);
      onZoom(s);
    }

    return { centerOn, resetView, destroy(){
      view.removeEventListener('pointerdown', pointerDown);
      view.removeEventListener('pointermove', pointerMove);
      view.removeEventListener('pointerup', pointerUp);
      view.removeEventListener('pointerleave', pointerUp);
      view.removeEventListener('wheel', wheel);
    }};
  };
})();

