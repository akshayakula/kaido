const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => m.type()==='error' && errors.push(m.text()));
  await p.goto('http://localhost:3274/dashboard');
  await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 15000 });
  await p.waitForTimeout(3000);
  await p.screenshot({ path: 'test-results/dashboard-geog.png', fullPage: false });
  console.log('errors:', errors.length ? errors.slice(0,5) : 'none');
  await b.close();
})();
