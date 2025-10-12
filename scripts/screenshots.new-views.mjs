import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const URL = process.env.BASE_URL || 'http://localhost:3000/?force=1';
const OUT = path.resolve(process.cwd(), 'artifacts', 'ui');
fs.mkdirSync(OUT, { recursive: true });

const VIEW_STATES = [
  { name: 'dots', view: 'dots', token: 5000 },
  { name: 'flow', view: 'flow', token: 3333 },
  { name: 'tree', view: 'tree', token: 724 },
  { name: 'rhythm', view: 'rhythm', token: 1472 }
];

async function focusToken(page, tokenId) {
  await page.evaluate((id) => {
    if (window.mammoths?.focusToken) {
      window.mammoths.focusToken(id);
      return;
    }
    const search = document.getElementById('search');
    if (!search) return;
    search.value = String(id);
    search.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    search.dispatchEvent(new Event('change', { bubbles: true }));
  }, tokenId);
  await page.waitForFunction(() => {
    const body = document.getElementById('sidebar-body');
    if (!body || body.classList.contains('hidden')) return false;
    const label = document.getElementById('sb-id');
    return !!(label && label.textContent && label.textContent.trim().length);
  }, { timeout: 5000 }).catch(() => {});
}

async function setView(page, name) {
  await page.evaluate((viewName) => {
    if (window.mammoths?.setSimpleView) {
      window.mammoths.setSimpleView(viewName);
      return;
    }
    const select = document.getElementById('view');
    if (select) {
      select.value = viewName;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, name);
  await page.waitForFunction((viewName) => {
    const activeBtn = document.querySelector(`[data-view-btn].active[data-view-btn="${viewName}"]`);
    return !!activeBtn;
  }, {}, name).catch(() => {});
  await page.waitForTimeout(500);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // ensure initial draw complete
  await page.waitForFunction(() => window.__mammothDrawnFrame === true, { timeout: 15000 }).catch(() => {});

  for (const state of VIEW_STATES) {
    await setView(page, state.view);
    await page.waitForTimeout(800);
    try { await page.keyboard.press('r'); } catch {}
    await page.waitForTimeout(400);
    await focusToken(page, state.token);
    await page.waitForTimeout(600);
    const filename = path.join(OUT, `view-${state.name}-1440.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log('saved', filename);
  }

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
