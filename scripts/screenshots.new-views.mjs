import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const URL = process.env.BASE_URL || 'http://localhost:3000/?force=1';
const OUT = path.resolve(process.cwd(), 'artifacts', 'ui');
fs.mkdirSync(OUT, { recursive: true });

const VIEW_STATES = [
  { name: 'dots', view: 'dots', expectedLayer: 'nodes', token: 5000 },
  { name: 'flow', view: 'flow', expectedLayer: 'flows-market', token: 3333 },
  { name: 'tree', view: 'tree', expectedLayer: 'tree-nodes', token: 724 },
  { name: 'rhythm', view: 'rhythm', expectedLayer: 'rhythm-dots', token: 1472 }
];

async function focusToken(page, tokenId) {
  await page.evaluate((id) => {
    const search = document.getElementById('search');
    if (search) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, tokenId);
  await page.fill('#search', String(tokenId));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const details = document.getElementById('details');
    if (!details) return false;
    const txt = details.textContent || '';
    return txt.trim().length > 0 && !/Select a node/i.test(txt);
  }, { timeout: 5000 }).catch(() => {});
}

async function waitForLayer(page, expected) {
  await page.waitForFunction((layerId) => {
    const deck = window.deckInst;
    if (!deck || !Array.isArray(deck.props?.layers)) return false;
    return deck.props.layers.some(layer => layer && layer.id === layerId);
  }, { timeout: 10000 }, expected).catch(() => {});
  await page.waitForTimeout(600);
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
    await page.selectOption('#view', state.view);
    await page.waitForTimeout(1200);
    await waitForLayer(page, state.expectedLayer);
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
