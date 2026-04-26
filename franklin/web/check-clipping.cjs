// Find elements whose content is being clipped (scrollWidth > clientWidth, etc.)
// or whose bounding box extends past the viewport.
const { chromium } = require('playwright');

const sizes = [
  { w: 1920, h: 1080 },
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 820, h: 1180 },
  { w: 600, h: 800 },
  { w: 390, h: 844 },
];

const PAGES = ['/dashboard', '/grid-sensor'];

(async () => {
  const b = await chromium.launch();
  for (const route of PAGES) {
    console.log(`\n=== ${route} ===`);
    for (const v of sizes) {
      const ctx = await b.newContext({ viewport: { width: v.w, height: v.h } });
      const p = await ctx.newPage();
      try {
        await p.goto('http://localhost:3274' + route);
        if (route === '/dashboard') await p.waitForSelector('canvas.mapboxgl-canvas', { timeout: 12000 });
        else await p.waitForSelector('.sensor-card, .sensor-empty', { timeout: 8000 });
        await p.waitForTimeout(1200);
        await p.screenshot({ path: `test-results/${route.replace(/\W/g, '_')}-${v.w}x${v.h}.png` });

        const issues = await p.evaluate(() => {
          const out = [];
          const seen = new WeakSet();
          // Treat content inside an ancestor that has its own scroll
          // (overflow: auto/scroll) as "intentional scroll" — not a clip.
          const inScrollAncestor = (el) => {
            for (let n = el.parentElement; n; n = n.parentElement) {
              const cs = window.getComputedStyle(n);
              if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
              if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return true;
            }
            return false;
          };
          // If the page itself scrolls (body taller than viewport), then
          // bottom-cutoffs on normal-flow content are expected — skip them.
          const pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 4;
          const all = document.querySelectorAll(
            '.dashboard-screen *, .sensor-screen *, .home-header *, .franklin-home *',
          );
          for (const el of all) {
            if (seen.has(el)) continue;
            seen.add(el);
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;

            // 1) horizontal text overflow without scrollbars / ellipsis
            if (el.scrollWidth - el.clientWidth > 4 && cs.overflowX === 'visible') {
              out.push({
                kind: 'h-overflow',
                tag: el.tagName.toLowerCase(),
                cls: el.className.toString().slice(0, 60),
                excess: el.scrollWidth - el.clientWidth,
              });
            }
            // 2) vertical overflow without scrollbars / ellipsis (uncommon)
            if (el.scrollHeight - el.clientHeight > 4 && cs.overflowY === 'visible' && el.children.length === 0) {
              out.push({
                kind: 'v-overflow',
                tag: el.tagName.toLowerCase(),
                cls: el.className.toString().slice(0, 60),
                excess: el.scrollHeight - el.clientHeight,
              });
            }
            // 3) bounding box extending past viewport — only count if NOT
            //    inside a scrolling ancestor (which is intentional).
            if (r.right > window.innerWidth + 1 && !inScrollAncestor(el)) {
              out.push({
                kind: 'r-cutoff',
                tag: el.tagName.toLowerCase(),
                cls: el.className.toString().slice(0, 60),
                excess: Math.round(r.right - window.innerWidth),
              });
            }
            if (
              r.bottom > window.innerHeight + 1 &&
              !inScrollAncestor(el) &&
              !pageScrolls
            ) {
              out.push({
                kind: 'b-cutoff',
                tag: el.tagName.toLowerCase(),
                cls: el.className.toString().slice(0, 60),
                excess: Math.round(r.bottom - window.innerHeight),
              });
            }
          }
          // dedupe by (kind, cls)
          const seenKeys = new Set();
          return out.filter((x) => {
            const k = x.kind + ':' + x.cls;
            if (seenKeys.has(k)) return false;
            seenKeys.add(k);
            return true;
          }).slice(0, 30);
        });

        if (issues.length) {
          console.log(`  ${v.w}x${v.h}: ${issues.length} issue(s)`);
          for (const i of issues) console.log('   ', JSON.stringify(i));
        } else {
          console.log(`  ${v.w}x${v.h}: clean`);
        }
      } catch (e) {
        console.log(`  ${v.w}x${v.h}: error: ${e.message}`);
      }
      await ctx.close();
    }
  }
  await b.close();
})();
