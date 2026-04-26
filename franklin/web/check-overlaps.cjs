const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const cases = [{w:1440,h:900},{w:1280,h:800},{w:1920,h:1080}];
  for (const v of cases) {
    const ctx = await b.newContext({ viewport: { width: v.w, height: v.h } });
    const p = await ctx.newPage();
    await p.goto('http://localhost:3274/dashboard');
    await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 15000 });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `test-results/dashboard-${v.w}x${v.h}.png` });
    const overlaps = await p.evaluate(() => {
      const sel = '.operator-topbar, .globe-panel > .panel-head, .site-card, .cylinder-readout, .map-legend, .diagnostics-stack, .diagnostics-bottom';
      const els = Array.from(document.querySelectorAll(sel));
      const rects = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className.split(' ')[0], r };
      });
      const out = [];
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r, c = rects[j].r;
          // ignore the operator-topbar wrapper (it's intentionally full-width)
          if (rects[i].cls === 'hero' || rects[j].cls === 'hero') continue;
          const xo = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left));
          const yo = Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
          if (xo * yo > 100) out.push({ a: rects[i].cls, b: rects[j].cls, xo: Math.round(xo), yo: Math.round(yo) });
        }
      }
      return out;
    });
    console.log(`${v.w}x${v.h}:`, overlaps.length ? JSON.stringify(overlaps) : 'no overlaps');
    await ctx.close();
  }
  await b.close();
})();
