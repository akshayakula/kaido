// ACE — NASA FIRMS over Strait of Hormuz on MapLibre GL JS (dark minimal)
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { PORTS } from './ports.js';

const FIRMS_KEY = import.meta.env.VITE_NASA_FIRMS_MAP_KEY;
const BBOX = { w: 54, s: 24, e: 58, n: 28 };

const state = {
  days: 30,
  sources: new Set(['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']),
  showPorts: true,
  showLane: true,
  showFires: true,
  data: [],
};

const setStatus = (t) => (document.getElementById('status-text').textContent = t);

// --- clock ---
function tick() {
  document.getElementById('clock').textContent =
    new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
setInterval(tick, 1000); tick();

// --- minimal dark style (no labels, no POIs) ---
const STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#05090b' } },
    {
      id: 'base',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-opacity': 0.55,
        'raster-contrast': 0.05,
        'raster-saturation': -0.5,
      },
    },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [56.25, 26.5],
  zoom: 7.4,
  pitch: 45,
  bearing: 0,
  attributionControl: false,
  hash: false,
});

// --- FIRMS fetch (throttled) ---
async function fetchFirmsChunk(source, dayRange, dateStr) {
  const url = `/firms/api/area/csv/${FIRMS_KEY}/${source}/${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}/${dayRange}/${dateStr}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${source} ${dateStr} ${r.status}`);
  return parseCsv(await r.text()).map((row) => ({ ...row, _source: source }));
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

const isoDate = (d) => d.toISOString().slice(0, 10);

async function fetchFirms() {
  setStatus('FETCHING DETECTIONS…');
  const sources = [...state.sources];
  if (!sources.length) { setStatus('NO SENSORS SELECTED'); return []; }

  const chunks = [];
  let remaining = state.days;
  let cursor = new Date();
  while (remaining > 0) {
    const w = Math.min(5, remaining);
    chunks.push({ days: w, date: isoDate(cursor) });
    cursor.setUTCDate(cursor.getUTCDate() - w);
    remaining -= w;
  }

  const queue = [];
  for (const src of sources) for (const c of chunks) queue.push({ src, c });

  const all = [];
  let failed = 0;
  let i = 0;
  const CONC = 3;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (i < queue.length) {
        const idx = i++;
        const { src, c } = queue[idx];
        try {
          const rows = await fetchFirmsChunk(src, c.days, c.date);
          all.push(...rows);
        } catch { failed++; }
        await new Promise((r) => setTimeout(r, 70));
      }
    })
  );

  // dedupe
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

// --- GeoJSON builders ---
function firesToGeoJSON(rows) {
  return {
    type: 'FeatureCollection',
    features: rows
      .map((d) => {
        const lat = +d.latitude, lon = +d.longitude;
        if (!isFinite(lat) || !isFinite(lon)) return null;
        const frp = parseFloat(d.frp) || 0;
        const conf = (d.confidence || '').toString().toLowerCase();
        let confTier = 0;
        if (conf === 'h' || conf === 'high' || Number(conf) >= 80) confTier = 2;
        else if (conf === 'n' || conf === 'nominal' || Number(conf) >= 50) confTier = 1;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            frp,
            confTier,
            acq_date: d.acq_date,
            acq_time: d.acq_time,
            source: d._source,
            height: Math.min(80 + frp * 12, 4000),
          },
        };
      })
      .filter(Boolean),
  };
}

function portsToGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: PORTS.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { name: p.name, country: p.country, tier: p.tier },
    })),
  };
}

// Strait shipping lane (TSS) approximated through Hormuz
function laneGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'inbound' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [54.2, 25.6],
            [55.0, 26.05],
            [55.7, 26.35],
            [56.25, 26.55],
            [56.65, 26.45],
            [57.4, 25.85],
            [58.0, 25.2],
          ],
        },
      },
    ],
  };
}

// --- Map setup ---
map.on('load', async () => {
  setStatus('STYLE LOADED · FETCHING…');

  // sources
  map.addSource('fires', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('ports', { type: 'geojson', data: portsToGeoJSON() });
  map.addSource('lane', { type: 'geojson', data: laneGeoJSON() });

  // shipping lane
  map.addLayer({
    id: 'lane-line',
    type: 'line',
    source: 'lane',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#5cffb8',
      'line-width': 1.4,
      'line-opacity': 0.55,
      'line-dasharray': [3, 3],
    },
  });

  // fire glow
  map.addLayer({
    id: 'fires-glow',
    type: 'circle',
    source: 'fires',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'frp'],
        0, 6,
        20, 14,
        80, 26,
        200, 40,
      ],
      'circle-color': [
        'match', ['get', 'confTier'],
        2, '#ff4757',
        1, '#ffb84a',
        '#94c4b8',
      ],
      'circle-blur': 0.85,
      'circle-opacity': 0.55,
    },
  });

  // fire core
  map.addLayer({
    id: 'fires-core',
    type: 'circle',
    source: 'fires',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'frp'],
        0, 1.6,
        20, 2.5,
        80, 4,
        200, 6,
      ],
      'circle-color': [
        'match', ['get', 'confTier'],
        2, '#ffeaea',
        1, '#fff3d6',
        '#dff5ec',
      ],
      'circle-stroke-color': [
        'match', ['get', 'confTier'],
        2, '#ff4757',
        1, '#ffb84a',
        '#94c4b8',
      ],
      'circle-stroke-width': 1,
      'circle-opacity': 0.95,
    },
  });

  // port outer ring
  map.addLayer({
    id: 'ports-ring',
    type: 'circle',
    source: 'ports',
    paint: {
      'circle-radius': ['+', ['*', ['-', 4, ['get', 'tier']], 6], 6],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#5cffb8',
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.9,
    },
  });

  // port crosshair (smaller filled inner)
  map.addLayer({
    id: 'ports-dot',
    type: 'circle',
    source: 'ports',
    paint: {
      'circle-radius': ['+', ['-', 4, ['get', 'tier']], 1],
      'circle-color': '#5cffb8',
      'circle-stroke-color': '#06090a',
      'circle-stroke-width': 1,
    },
  });

  // port labels
  map.addLayer({
    id: 'ports-label',
    type: 'symbol',
    source: 'ports',
    layout: {
      'text-field': ['concat', '◢ ', ['get', 'name'], '  ', ['get', 'country']],
      'text-size': 10,
      'text-offset': [0, 1.4],
      'text-letter-spacing': 0.18,
      'text-font': ['Noto Sans Regular'],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#bfffe0',
      'text-halo-color': '#05090b',
      'text-halo-width': 2,
      'text-halo-blur': 0.5,
    },
  });

  // popup on hover
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'ace-popup' });
  map.on('mouseenter', 'fires-core', (e) => {
    map.getCanvas().style.cursor = 'crosshair';
    const f = e.features[0];
    const [lon, lat] = f.geometry.coordinates;
    popup
      .setLngLat([lon, lat])
      .setHTML(
        `<div class="pop">
          <div class="pop-h">▣ DETECTION · ${f.properties.source}</div>
          <div>LAT ${lat.toFixed(4)} · LON ${lon.toFixed(4)}</div>
          <div>UTC ${f.properties.acq_date} ${f.properties.acq_time || ''}</div>
          <div>FRP ${f.properties.frp} MW</div>
        </div>`
      )
      .addTo(map);
  });
  map.on('mouseleave', 'fires-core', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  map.on('mouseenter', 'ports-dot', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    const [lon, lat] = f.geometry.coordinates;
    popup
      .setLngLat([lon, lat])
      .setHTML(
        `<div class="pop">
          <div class="pop-h">⚓ ${f.properties.name} · ${f.properties.country}</div>
          <div>LAT ${lat.toFixed(4)} · LON ${lon.toFixed(4)}</div>
          <div>TIER ${f.properties.tier}</div>
        </div>`
      )
      .addTo(map);
  });
  map.on('mouseleave', 'ports-dot', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  bindUI();
  await reload();

  // gentle bearing drift (very subtle)
  let bearing = 0;
  setInterval(() => {
    bearing = (bearing + 0.04) % 360;
    map.setBearing(bearing);
  }, 80);
});

function applyVisibility() {
  const set = (id, on) =>
    map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  set('fires-glow', state.showFires);
  set('fires-core', state.showFires);
  set('ports-ring', state.showPorts);
  set('ports-dot', state.showPorts);
  set('ports-label', state.showPorts);
  set('lane-line', state.showLane);
}

async function reload() {
  const btn = document.getElementById('reload');
  btn.disabled = true;
  try {
    state.data = await fetchFirms();
    const gj = firesToGeoJSON(state.data);
    map.getSource('fires').setData(gj);

    // metrics
    let hi = 0, maxFrp = 0, latest = '';
    for (const f of gj.features) {
      if (f.properties.confTier === 2) hi++;
      if (f.properties.frp > maxFrp) maxFrp = f.properties.frp;
      const stamp = `${f.properties.acq_date} ${f.properties.acq_time || ''}`;
      if (stamp > latest) latest = stamp;
    }
    document.getElementById('m-count').textContent = gj.features.length.toLocaleString();
    document.getElementById('m-high').textContent = hi.toLocaleString();
    document.getElementById('m-frp').textContent = maxFrp ? `${maxFrp.toFixed(1)} MW` : '—';
    document.getElementById('m-last').textContent = latest || '—';
    document.getElementById('m-ports').textContent = PORTS.length.toString();
  } catch (e) {
    setStatus('ERR · ' + e.message);
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

function bindUI() {
  document.querySelectorAll('#range-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#range-seg button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.days = parseInt(b.dataset.days, 10);
      reload();
    });
  });
  document.querySelectorAll('.chk input[data-src]').forEach((c) => {
    c.addEventListener('change', () => {
      if (c.checked) state.sources.add(c.dataset.src);
      else state.sources.delete(c.dataset.src);
      reload();
    });
  });
  document.getElementById('toggle-ports').addEventListener('change', (e) => {
    state.showPorts = e.target.checked; applyVisibility();
  });
  document.getElementById('toggle-lane').addEventListener('change', (e) => {
    state.showLane = e.target.checked; applyVisibility();
  });
  document.getElementById('toggle-fires').addEventListener('change', (e) => {
    state.showFires = e.target.checked; applyVisibility();
  });
  document.querySelectorAll('#view-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#view-seg button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      map.easeTo({ pitch: parseInt(b.dataset.pitch, 10), duration: 800 });
    });
  });
  document.getElementById('reload').addEventListener('click', reload);
}

map.on('error', (e) => console.warn('[map error]', e.error?.message || e));
