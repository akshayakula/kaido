const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3274/dashboard');
  await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 15000 });
  await p.waitForTimeout(1500);
  const data = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('select').forEach(s => {
      const r = s.getBoundingClientRect();
      const parent = s.parentElement;
      out.push({
        parent: parent?.className || parent?.tagName,
        scrollW: s.scrollWidth, clientW: s.clientWidth,
        rect: { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) },
        text: s.options[s.selectedIndex]?.text?.slice(0, 40),
      });
    });
    return out;
  });
  console.log(JSON.stringify(data, null, 2));
  await b.close();
})();
