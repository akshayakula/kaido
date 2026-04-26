const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3274/dashboard');
  await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 15000 });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: 'test-results/dashboard-v2.png', fullPage: false });
  await b.close();
})();
