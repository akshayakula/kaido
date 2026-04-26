const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3274/dashboard');
  await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 15000 });
  await p.waitForTimeout(1500);
  const data = await p.evaluate(() => {
    const tp = document.querySelector('.terminal-panel');
    const dc = document.querySelector('.dss-commands');
    const cs = dc ? window.getComputedStyle(dc) : null;
    return {
      panel: tp ? { ...tp.getBoundingClientRect().toJSON?.() ?? {}, top: Math.round(tp.getBoundingClientRect().top), bottom: Math.round(tp.getBoundingClientRect().bottom) } : null,
      pre: dc ? { top: Math.round(dc.getBoundingClientRect().top), bottom: Math.round(dc.getBoundingClientRect().bottom), maxH: cs.maxHeight, overflowY: cs.overflowY } : null,
      vh: window.innerHeight,
    };
  });
  console.log(JSON.stringify(data, null, 2));
  await b.close();
})();
