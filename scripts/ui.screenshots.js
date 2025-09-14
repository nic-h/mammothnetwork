// Headless UI checks and screenshots using Playwright
import fs from 'fs';
import path from 'path';

const { chromium } = await import('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(process.cwd(), 'artifacts', 'ui');

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

async function waitForIdle(page){
  try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
  await page.waitForTimeout(300); // small settle
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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
  try {
    await page.waitForLoadState('load', { timeout: 10000 });
    const info = await page.evaluate(() => ({ t: typeof window.deck, scripts: Array.from(document.querySelectorAll('script')).map(s=>s.src).filter(s=>/deck\.gl|geo-layers/.test(s)).length }));
    console.log('deck ns:', info.t, 'scripts:', info.scripts);
  } catch {}

  // Views to exercise
  const views = ['ownership', 'trading', 'traits', 'whales', 'health'];
  const previewIds = (process.env.PREVIEW_IDS || '5000,3333,2500,2000,1000,100,2').split(',').map(s=>parseInt(s,10)).filter(n=>!isNaN(n));
  const perViewVariants = parseInt(process.env.PREVIEW_VARIANTS || '3', 10);

  for (const view of views){
    // Select view
    await page.selectOption('#view', view).catch(()=>{});
    await waitForIdle(page);
    // Expand traits panel on the left for context
    try { await page.evaluate(()=>{ const ts=document.querySelector('.traits-section'); ts?.classList.add('open'); }); } catch {}
    // Generate a few variants by selecting curated token IDs
    const baseIndex = views.indexOf(view);
    for (let vi=0; vi<perViewVariants; vi++){
      try {
        const id = previewIds[(baseIndex + vi) % previewIds.length];
        await page.fill('#search', String(id));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.waitForFunction(() => {
          const d = document.querySelector('#details');
          const img = document.querySelector('#thumb');
          const hasImg = img && img.getAttribute('src');
          const hasContent = d && d.textContent && !/Select a node/i.test(d.textContent);
          return !!(hasImg || hasContent);
        }, { timeout: 1500 }).catch(()=>{});
      } catch (e) { console.warn('search selection failed', view, e?.message||e); }

      // Exercise keyboard flows once per view (only first variant)
      if (vi===0) await testKeyboardFlows(page);

      // Desktop only per request
      await page.setViewportSize({ width: 1440, height: 900 });
      await waitForIdle(page);
      await screenshot(page, `desktop-preset-${view}-v${vi+1}-1440`);
    }
  }

  await browser.close();
}

main().catch(err=>{ console.error(err); process.exit(1); });
