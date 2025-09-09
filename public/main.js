// Minimal front-end per spec: PIXI v7 + three-panel shell

const stageEl = document.getElementById('stage');
const modeEl = document.getElementById('mode');
const edgesEl = document.getElementById('edges');
const fpsEl = document.getElementById('fps');
const nodeCountEl = document.getElementById('node-count');
const traitTypeEl = document.getElementById('trait-type');
const traitValueEl = document.getElementById('trait-value');
const traitsBox = document.getElementById('traits');
const searchEl = document.getElementById('search');
const sidebar = document.getElementById('sidebar');
const thumbEl = document.getElementById('thumb');
const detailsEl = document.getElementById('details');

let app, world, nodeContainer, circleTexture;
let sprites = []; // PIXI.Sprite
let nodes = [];   // server nodes
let edgesData = [];
let worker = null;

// Utils
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function lerp(a,b,t){ return a + (b-a)*t; }
function makeCircleTexture(renderer, r=2, color=0x00ff66){
  const g = new PIXI.Graphics();
  g.beginFill(color).drawCircle(r,r,r).endFill();
  const t = renderer.generateTexture(g);
  g.destroy(true);
  return t;
}

async function init() {
  app = new PIXI.Application({ view: stageEl, backgroundColor:0x000000, antialias:false, resolution:Math.min(devicePixelRatio||1,2), width: stageEl.clientWidth, height: stageEl.clientHeight });
  world = new PIXI.Container();
  app.stage.addChild(world);
  nodeContainer = new PIXI.ParticleContainer(10000, { position:true, scale:true, tint:true, alpha:true });
  world.addChild(nodeContainer);
  circleTexture = makeCircleTexture(app.renderer, 2, 0x00ff66);

  // Resize to grid cell
  try { new ResizeObserver(()=>app.renderer.resize(stageEl.clientWidth, stageEl.clientHeight)).observe(stageEl); } catch {}

  // FPS
  app.ticker.add(()=>{ if (fpsEl) fpsEl.textContent = String(Math.round(app.ticker.FPS||0)); });

  // Load data and start
  await load(modeEl.value, Number(edgesEl.value||200));

  // Interactions
  setupPanZoom();
  stageEl.addEventListener('click', onStageClick);
  modeEl.addEventListener('change', ()=> load(modeEl.value, Number(edgesEl.value||200)));
  edgesEl.addEventListener('input', ()=> load(modeEl.value, Number(edgesEl.value||200)));
  searchEl.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const id=Number(searchEl.value.trim()); if(id>0) selectNode(id-1); searchEl.value=''; }});
}

async function load(mode, edges){
  const data = await fetchGraph(mode, edges).catch(()=>({nodes:[],edges:[]}));
  nodes = data.nodes||[]; edgesData = data.edges||[];
  if (nodeCountEl) nodeCountEl.textContent = String(nodes.length);
  buildSprites(nodes.map(n=>n.color||0x00ff66));
  startWorker(nodes.length, edgesData);
  // Traits list
  if (!traitTypeEl.options.length) await loadTraits();
}

async function fetchGraph(mode, edges){
  const q = new URLSearchParams({ mode, edges:String(edges), nodes:'10000' });
  const r = await fetch(`/api/graph?${q}`).catch(()=>null);
  if(!r||!r.ok) throw new Error('graph fetch failed');
  return await r.json();
}

function buildSprites(colors){
  // clear
  sprites.forEach(s=>s.destroy()); sprites=[]; nodeContainer.removeChildren();
  const count = Math.min(colors.length, 10000);
  for(let i=0;i<count;i++){
    const sp = new PIXI.Sprite(circleTexture); sp.anchor.set(0.5); sp.tint = colors[i]||0x00ff66; sp.alpha=0.95; sp.scale.set(1,1); sp.x=0; sp.y=0; sprites.push(sp);
  }
  nodeContainer.addChild(...sprites);
}

function startWorker(count, edges){
  if (worker) worker.terminate();
  let ticked=false;
  try { worker = new Worker('/sim.worker.js', {type:'module'}); } catch { worker = new Worker('/sim.worker.js'); }
  worker.onmessage = (e)=>{
    const {type, positions} = e.data||{}; if(type!=='tick'||!positions) return; ticked=true; applyPositions(positions.x, positions.y);
  };
  worker.postMessage({ type:'init', payload:{ nodes: count, edges } });
  // fallback first frame
  setTimeout(()=>{ if(!ticked){ const x=new Float32Array(count), y=new Float32Array(count); for(let i=0;i<count;i++){ const a=i*0.01, r=50+(i%200)*2; x[i]=Math.cos(a)*r; y[i]=Math.sin(a)*r;} applyPositions(x,y); } }, 600);
}

function applyPositions(px, py){
  const n = Math.min(sprites.length, px.length, py.length);
  for(let i=0;i<n;i++){ const sp=sprites[i]; sp.x = px[i]; sp.y = py[i]; }
}

// Pan/zoom
function setupPanZoom(){
  let isDragging=false, start={x:0,y:0}, startPos={x:0,y:0};
  stageEl.addEventListener('mousedown', e=>{ isDragging=true; start={x:e.clientX,y:e.clientY}; startPos={x:world.position.x,y:world.position.y}; });
  window.addEventListener('mouseup', ()=> isDragging=false);
  window.addEventListener('mousemove', e=>{ if(!isDragging) return; const dx=e.clientX-start.x, dy=e.clientY-start.y; world.position.set(startPos.x+dx, startPos.y+dy); });
  stageEl.addEventListener('wheel', e=>{ e.preventDefault(); const f=Math.exp(-e.deltaY*0.001); const old=world.scale.x; const nx=clamp(old*f, 0.1, 5); const pt = world.toLocal({x:e.clientX,y:e.clientY}); world.scale.set(nx); const pt2=world.toLocal({x:e.clientX,y:e.clientY}); world.position.x += (pt2.x-pt.x)*nx; world.position.y += (pt2.y-pt.y)*nx; }, {passive:false});
}

// Selection
function onStageClick(e){
  const pt = world.toLocal({x:e.clientX,y:e.clientY});
  let best=-1, bestD2=100;
  for(let i=0;i<sprites.length;i++){ const s=sprites[i]; const dx=s.x-pt.x, dy=s.y-pt.y; const d2=dx*dx+dy*dy; if(d2<bestD2){bestD2=d2; best=i;} }
  if(best>=0) selectNode(best);
}

async function selectNode(index){
  const id = index+1; // server ids 1-based
  sidebar.style.display='block';
  try {
    const t = await fetch(`/api/token/${id}`).then(r=>r.json());
    if (t && (t.thumbnail_local||t.image_local)) thumbEl.src = `/${t.thumbnail_local||t.image_local}`;
    detailsEl.innerHTML = `
      <div><b>#${id.toString().padStart(4,'0')}</b></div>
      <div>OWNER</div><div>${t.owner||'--'}</div>
      <div style="margin-top:8px">TRAITS</div>
      ${(t.traits||[]).slice(0,24).map(a=>`<div>${a.trait_type}: ${a.trait_value}</div>`).join('')}`;
  } catch { detailsEl.innerHTML = '<div>NO DATA</div>'; }
}

// Traits
async function loadTraits(){
  const r = await fetch('/api/traits').catch(()=>null); if(!r||!r.ok) return;
  const j = await r.json(); const traits=j.traits||[];
  traitTypeEl.innerHTML = '<option value="">(select)</option>'+ traits.map(x=>`<option value="${x.type}">${x.type}</option>`).join('');
  traitTypeEl.addEventListener('change', ()=>{
    const t = traitTypeEl.value; const entry = traits.find(x=>x.type===t);
    traitValueEl.innerHTML = '<option value="">(value)</option>' + (entry?entry.values.map(v=>`<option value="${v.value}">${v.value} (${v.count})</option>`).join(''):'');
  });
  traitValueEl.addEventListener('change', async ()=>{
    const type=traitTypeEl.value, value=traitValueEl.value; if(!type||!value) return;
    const rr = await fetch(`/api/trait-tokens?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`).then(x=>x.json()).catch(()=>({tokens:[]}));
    const ids = new Set((rr.tokens||[]).map(Number));
    for(let i=0;i<sprites.length;i++){ const id=i+1; const show = ids.has(id); sprites[i].alpha = show?0.95:0.1; }
  });
}

// Toast (console-based minimal)
function showToast(msg){ console.log('[toast]', msg); }

// Boot
window.addEventListener('load', init);
