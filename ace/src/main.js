// ACE — NASA FIRMS over Strait of Hormuz on Google Photorealistic 3D Maps

const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const FIRMS_KEY = import.meta.env.VITE_NASA_FIRMS_MAP_KEY;

// Strait of Hormuz AOI (west,south,east,north)
const BBOX = { w: 54, s: 24, e: 58, n: 28 };

const state = {
  days: 30,
  sources: new Set(['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']),
  markers: [],
  data: [],
};

const statusEl = document.getElementById('status-text');
const setStatus = (t) => (statusEl.textContent = t);

// Clock
function tick() {
  const d = new Date();
  document.getElementById('clock').textContent =
    d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
setInterval(tick, 1000); tick();

// Load Google Maps JS with maps3d alpha
function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve(window.google.maps);
    if (!GOOGLE_KEY) return reject(new Error('Missing VITE_GOOGLE_MAPS_API_KEY'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&v=alpha&libraries=maps3d,marker`;
    s.async = true;
    s.onload = () => resolve(window.google.maps);
    s.onerror = () => reject(new Error('Failed to load Google Maps JS'));
    document.head.appendChild(s);
  });
}

// Fetch FIRMS detections via Vite proxy. Max 10-day window per call, so chunk.
async function fetchFirmsChunk(source, dayRange, dateStr) {
  const url = `/firms/api/area/csv/${FIRMS_KEY}/${source}/${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}/${dayRange}/${dateStr}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FIRMS ${source} ${dateStr} → ${r.status}`);
  const text = await r.text();
  return parseCsv(text).map((row) => ({ ...row, _source: source }));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((ln) => {
    const cells = ln.split(',');
    const o = {};
    headers.forEach((h, i) => (o[h.trim()] = cells[i]));
    return o;
  });
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function fetchFirms() {
  setStatus('FETCHING DETECTIONS…');
  const sources = [...state.sources];
  if (sources.length === 0) { setStatus('NO SENSORS SELECTED'); return []; }

  const chunks = [];
  // walk back from today in 10-day windows
  const today = new Date();
  let remaining = state.days;
  let cursor = new Date(today);
  while (remaining > 0) {
    const window = Math.min(5, remaining);
    chunks.push({ days: window, date: isoDate(cursor) });
    cursor.setUTCDate(cursor.getUTCDate() - window);
    remaining -= window;
  }

  const tasks = [];
  for (const src of sources) {
    for (const c of chunks) tasks.push(fetchFirmsChunk(src, c.days, c.date));
  }
  const results = await Promise.allSettled(tasks);
  const all = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else failed++;
  }

  // dedupe by lat,lon,date,time,source
  const seen = new Set();
  const dedup = [];
  for (const d of all) {
    const k = `${d._source}|${d.latitude}|${d.longitude}|${d.acq_date}|${d.acq_time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(d);
  }
  setStatus(`FEED OK · ${dedup.length} DETECTIONS${failed ? ` · ${failed} CHUNK FAIL` : ''}`);
  return dedup;
}

// Confidence → color (military hot palette)
function colorFor(d) {
  const c = (d.confidence || '').toString().toLowerCase();
  const num = Number(c);
  if (!Number.isNaN(num)) {
    if (num >= 80) return [255, 71, 87, 1];
    if (num >= 50) return [255, 184, 74, 1];
    return [148, 196, 184, 0.9];
  }
  if (c === 'h' || c === 'high') return [255, 71, 87, 1];
  if (c === 'n' || c === 'nominal') return [255, 184, 74, 1];
  return [148, 196, 184, 0.9];
}

function clearMarkers() {
  for (const m of state.markers) m.remove?.();
  state.markers = [];
}

async function renderMarkers(map3d) {
  clearMarkers();
  const { Marker3DInteractiveElement } = await google.maps.importLibrary('maps3d');

  let hi = 0, maxFrp = 0, latest = '';
  for (const d of state.data) {
    const lat = parseFloat(d.latitude), lon = parseFloat(d.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const frp = parseFloat(d.frp) || 0;
    if (frp > maxFrp) maxFrp = frp;
    const conf = (d.confidence || '').toString().toLowerCase();
    if (conf === 'h' || conf === 'high' || Number(conf) >= 80) hi++;
    const stamp = `${d.acq_date} ${d.acq_time || ''}`;
    if (stamp > latest) latest = stamp;

    const altitude = Math.min(80 + frp * 4, 1200);
    const [r, g, b, a] = colorFor(d);

    const m = new Marker3DInteractiveElement({
      position: { lat, lng: lon, altitude },
      altitudeMode: 'RELATIVE_TO_GROUND',
      extruded: true,
      label: '',
    });
    // Style via inline attribute since 3D markers are limited; use a colored pin svg
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
      `<circle cx="11" cy="11" r="4" fill="rgba(${r},${g},${b},${a})" stroke="#fff" stroke-width="1"/>` +
      `<circle cx="11" cy="11" r="9" fill="none" stroke="rgba(${r},${g},${b},0.45)" stroke-width="1"/>` +
      `</svg>`;
    const img = document.createElement('img');
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    m.append(img);

    m.addEventListener('gmp-click', () => showPopup(d));
    map3d.append(m);
    state.markers.push(m);
  }

  document.getElementById('m-count').textContent = state.data.length.toLocaleString();
  document.getElementById('m-high').textContent = hi.toLocaleString();
  document.getElementById('m-frp').textContent = maxFrp ? `${maxFrp.toFixed(1)} MW` : '—';
  document.getElementById('m-last').textContent = latest || '—';
}

function showPopup(d) {
  const wrap = document.getElementById('map-wrap');
  const old = document.getElementById('popup');
  if (old) old.remove();
  const p = document.createElement('div');
  p.id = 'popup';
  p.className = 'popup';
  p.style.left = '50%';
  p.style.top = '50%';
  p.innerHTML = `
    <div style="color: var(--accent); margin-bottom:4px;">▣ DETECTION · ${d._source}</div>
    <div>LAT ${(+d.latitude).toFixed(4)} · LON ${(+d.longitude).toFixed(4)}</div>
    <div>UTC ${d.acq_date} ${d.acq_time}</div>
    <div>FRP ${d.frp} MW · CONF ${d.confidence} · BRIGHT ${d.bright_ti4 || d.brightness || '—'}</div>
  `;
  wrap.appendChild(p);
  setTimeout(() => p.remove(), 4500);
}

async function reload(map3d) {
  const btn = document.getElementById('reload');
  btn.disabled = true;
  try {
    state.data = await fetchFirms();
    await renderMarkers(map3d);
  } catch (e) {
    setStatus('ERR · ' + e.message);
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

// wire up controls
function bindUI(map3d) {
  document.querySelectorAll('#range-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#range-seg button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.days = parseInt(b.dataset.days, 10);
      reload(map3d);
    });
  });
  document.querySelectorAll('.chk input').forEach((c) => {
    c.addEventListener('change', () => {
      if (c.checked) state.sources.add(c.dataset.src);
      else state.sources.delete(c.dataset.src);
      reload(map3d);
    });
  });
  document.getElementById('reload').addEventListener('click', () => reload(map3d));
}

async function main() {
  if (!GOOGLE_KEY) { setStatus('NO GOOGLE KEY · check /kaido/.env'); return; }
  if (!FIRMS_KEY) { setStatus('NO FIRMS KEY · check /kaido/.env'); return; }

  setStatus('LOADING 3D RENDERER…');
  await loadGoogleMaps();
  await google.maps.importLibrary('maps3d');
  const map3d = document.getElementById('map3d');

  // gentle orbit
  let heading = 0;
  setInterval(() => {
    heading = (heading + 0.05) % 360;
    map3d.heading = heading;
  }, 80);

  bindUI(map3d);
  await reload(map3d);
}

main();
