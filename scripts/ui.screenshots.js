// Headless UI checks and screenshots using Playwright
import fs from 'fs';
import path from 'path';

const { chromium } = await import('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(process.cwd(), 'artifacts', 'ui');
const ENGINE_CANVAS_QUERY = '#three-stage canvas, .center-panel canvas';

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

async function waitForIdle(page){
  try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
  await page.waitForTimeout(300); // small settle
}

async function waitForEngineCanvas(page, timeout = 8000){
  await page.waitForSelector(ENGINE_CANVAS_QUERY, { timeout });
}

async function screenshot(page, name){
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', file);
}

async function testKeyboardFlows(page){
  // Collapsible: Traits
  const traitsHeader = await page.$('.traits-header');
  if (traitsHeader){
    await traitsHeader.focus();
    const before = await traitsHeader.getAttribute('aria-expanded');
    await page.keyboard.press('Enter');
    const after = await traitsHeader.getAttribute('aria-expanded');
    console.log('traits aria-expanded', before, '->', after);
    await page.keyboard.press(' '); // Space to toggle back
  }
  // Collapsible: first edge group
  const edgeHeader = await page.$('.edge-group .edge-group-header');
  if (edgeHeader){
    await edgeHeader.focus();
    const e1 = await edgeHeader.getAttribute('aria-expanded');
    await page.keyboard.press('Enter');
    const e2 = await edgeHeader.getAttribute('aria-expanded');
    console.log('edge-group aria-expanded', e1, '->', e2);
  }
  // More menu keyboard nav
  const moreBtn = await page.$('#more-btn');
  if (moreBtn){
    await moreBtn.focus();
    await page.keyboard.press('ArrowDown'); // open + focus first
    // Navigate items
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await page.keyboard.press('Escape'); // close
    // Verify focus restoration to more button
    const activeId = await page.evaluate(()=> document.activeElement?.id || '');
    console.log('after ESC, focus on:', activeId);
  }
}

async function main(){
  ensureDir(OUT);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', msg => { try { console.log('[page]', msg.text()); } catch {} });
  page.on('pageerror', err => { try { console.log('[pageerror]', err.message); } catch {} });
  const targetUrl = BASE.includes('?') ? `${BASE}&force=1` : `${BASE}?force=1`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
  // Wait for render surface (Three or Deck)
  await waitForEngineCanvas(page);
  await page.waitForFunction(() => {
    try {
      if (window.__mammothDrawnFrame === true) return true;
      const c = document.querySelector('#three-stage canvas, .center-panel canvas');
      const gl = c?.getContext?.('webgl2') || c?.getContext?.('webgl');
      if (!gl || !c?.width || !c?.height) return false;
      const px = new Uint8Array(4);
      gl.readPixels((c.width/2)|0, (c.height/2)|0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (px[0] + px[1] + px[2]) > 10;
    } catch {
      return false;
    }
  }, { timeout: 12000 });
  // Wait until Deck has initialized and canvas backing store is non-zero
  await page.waitForFunction(() => {
    const c = document.querySelector('#three-stage canvas, .center-panel canvas');
    if (!c || !(c.width > 0 && c.height > 0)) return false;
    if (window.mammoths) return true;
    return false;
  }, { timeout: 12000 }).catch(()=>{});
  // Log canvas size and a center pixel sample from WebGL (debug)
  try {
    const probe = await page.evaluate(() => {
      const c = document.querySelector('#three-stage canvas, .center-panel canvas');
      const ctr = document.querySelector('.center-panel');
      const w = c?.width||0, h=c?.height||0;
      const bb = c?.getBoundingClientRect?.() || {width:0,height:0};
      const cw = ctr?.clientWidth||0, ch=ctr?.clientHeight||0;
      let px=[-1,-1,-1,-1];
      try{
        const gl = c?.getContext?.('webgl2') || c?.getContext?.('webgl');
        if (gl && w>4 && h>4){ const arr=new Uint8Array(4); gl.readPixels(Math.floor(w/2), Math.floor(h/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, arr); px=[arr[0],arr[1],arr[2],arr[3]]; }
      } catch {}
      const canvases = Array.from(document.querySelectorAll('canvas')).map((el,i)=>{
        const r=el.getBoundingClientRect();
        return { i, id: el.id||null, cls: el.className||'', w: el.width||0, h: el.height||0, bw: Math.round(r.width), bh: Math.round(r.height) };
      });
      return { w, h, bbW: Math.round(bb.width), bbH: Math.round(bb.height), cw, ch, px, canvases };
    });
    console.log('canvas:', probe);
  } catch {}
  try {
    await page.waitForLoadState('load', { timeout: 10000 });
    const info = await page.evaluate(() => ({
      modules: Array.from(document.querySelectorAll('script[type="module"]')).length,
      mammoths: typeof window.mammoths,
      forceGraph: typeof window.ForceGraph3D
    }));
    console.log('engine ns:', info);
  } catch {}

  // Views to exercise
  const mode = (process.env.UI_MODE || '').toLowerCase();
  const quick = mode !== 'full' && String(process.env.QUICK||'1') !== '0';
  const views = quick ? ['ownership', 'trading'] : ['ownership', 'trading', 'traits', 'whales', 'health'];
  const simple = ['dots', 'flow', 'tree', 'rhythm'];
  const previewIds = (process.env.PREVIEW_IDS || '5000,3333,2500,2000,1000,100,2').split(',').map(s=>parseInt(s,10)).filter(n=>!isNaN(n));
  const defaultVariants = quick ? 1 : parseInt(process.env.PREVIEW_VARIANTS || '1', 10);
  const perViewVariants = Math.max(1, defaultVariants);

  for (const view of views){
    // Select legacy view (ensures nodes array is present for focusSelect)
    await page.selectOption('#view', view).catch(()=>{});
    await waitForIdle(page);
    // Zoom out to show entire scene/UI
    try { await page.keyboard.press('r'); await page.waitForTimeout(200); } catch {}
    // Expand traits panel on the left for context
    try { await page.evaluate(()=>{ const ts=document.querySelector('.traits-section'); ts?.classList.add('open'); }); } catch {}
    // Generate a few variants by selecting curated token IDs
    const baseIndex = views.indexOf(view);
    for (let vi=0; vi<perViewVariants; vi++){
      try {
        const id = previewIds[(baseIndex + vi) % previewIds.length];
        // Try direct focus via exposed API for reliability
        await page.evaluate((tok)=>{ window.mammoths?.focusToken?.(tok); }, id).catch(()=>{});
        // Also drive the search box in case the API isn't available yet
        try { await page.fill('#search', String(id)); await page.keyboard.press('Enter'); } catch {}
        await page.waitForTimeout(300);
        await page.waitForFunction(() => {
          const d = document.querySelector('#details');
          const img = document.querySelector('#thumb');
          const hasImg = img && img.getAttribute('src');
          const hasContent = d && d.textContent && !/Select a node/i.test(d.textContent);
          return !!(hasImg || hasContent);
        }, { timeout: 5000 }).catch(()=>{});
      } catch (e) { console.warn('search selection failed', view, e?.message||e); }

      // Exercise keyboard flows once per view (only first variant)
      if (vi===0) await testKeyboardFlows(page);

      // Desktop only per request
      await page.setViewportSize({ width: 1440, height: 900 });
      await waitForIdle(page);
      try { await page.keyboard.press('r'); await page.waitForTimeout(200); } catch {}
      await waitForEngineCanvas(page, 6000).catch(()=>{});
      await screenshot(page, `desktop-preset-${view}-v${vi+1}-1440`);
    }
  }

  // Simple view screenshots too (use exposed API)
  for (const key of simple){
    await page.evaluate((k)=> window.mammoths?.setSimpleView?.(k), key).catch(()=>{});
    await waitForIdle(page);
    const id = (previewIds[0]||5000);
    await page.evaluate((tok)=>{ window.mammoths?.focusToken?.(tok); }, id).catch(()=>{});
    await page.waitForFunction(() => {
      const d = document.querySelector('#details');
      const img = document.querySelector('#thumb');
      const hasImg = img && img.getAttribute('src');
      const hasContent = d && d.textContent && !/Select a node/i.test(d.textContent);
      return !!(hasImg || hasContent);
    }, { timeout: 5000 }).catch(()=>{});
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForIdle(page);
    try { await page.keyboard.press('r'); await page.waitForTimeout(200); } catch {}
    await waitForEngineCanvas(page, 6000).catch(()=>{});
    await screenshot(page, `desktop-simple-${key}-1440`);
  }

  await browser.close();
}

main().catch(err=>{ console.error(err); process.exit(1); });
