'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import type { DemoSession } from '@/lib/types';
import type { DeviceListItem } from '@/lib/sensor-store';

type GridMapProps = {
  session: DemoSession | null;
};

type DrawClass = 'low' | 'medium' | 'high';
type SensorHealthClass = 'good' | 'warn' | 'bad' | 'unknown';
type GridView = {
  center: { lat: number; lng: number };
  sensor: {
    health: number | null;
    healthClass: SensorHealthClass;
    color: string;
    label: string;
    state: string;
    tempF: number | null;
    live: boolean;
  } | null;
  nodes: {
    dc: DemoSession['datacenters'][number];
    draw: number;
    relativeDraw: number;
    drawClass: DrawClass;
    drawLabel: string;
    color: string;
    kw: number;
    deferredKw: number;
    loadSignal: number;
    queuePressure: number;
    queueLabel: string;
    speaking: boolean;
    index: number;
    lat: number;
    lng: number;
  }[];
};

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const FOREGROUND = '#e4e2c9';
const COLORS: Record<DrawClass, string> = {
  low: '#e4e2c9',
  medium: '#f2d36b',
  high: '#e27b63',
};
const SENSOR_COLORS: Record<SensorHealthClass, string> = {
  good: '#5fd38a',
  warn: '#f2d36b',
  bad: '#e27b63',
  unknown: '#7f8478',
};
const SENSOR_DEVICE_ID = 'sensor1';
const SENSOR_LIVE_WINDOW_S = 1800;
const SENSOR_REFRESH_MS = 2000;

function sensorHealthScore(
  tempC: number | undefined,
  hum: number | undefined,
  deltaC: number | undefined,
): number | null {
  if (tempC === undefined && hum === undefined && deltaC === undefined) return null;
  const tempF = tempC === undefined ? null : tempC * 9 / 5 + 32;
  const deltaF = deltaC === undefined ? null : deltaC * 9 / 5;
  const driftScore = deltaF === null ? 1 : Math.max(0, 1 - Math.pow(Math.abs(deltaF) / 6, 2));
  const bandScore  = tempF === null ? 1 : tempF >= 70 && tempF <= 80 ? 1 : Math.max(0, 1 - Math.abs(tempF - 75) / 12);
  const humScore   = hum === undefined ? 1 : hum >= 30 && hum <= 65 ? 1 : Math.max(0, 1 - Math.abs(hum - 47.5) / 25);
  return Math.max(0, Math.min(1, driftScore * 0.7 + bandScore * 0.2 + humScore * 0.1));
}

const POPULATED_LIGHTS: [number, number][] = [
  [-74.0, 40.7], [-73.9, 40.8], [-77.0, 38.9], [-87.6, 41.9], [-95.4, 29.7],
  [-118.2, 34.1], [-122.4, 37.8], [-122.3, 47.6], [-79.4, 43.7], [-73.6, 45.5],
  [-0.1, 51.5], [2.4, 48.9], [13.4, 52.5], [4.9, 52.4], [12.5, 41.9],
  [-3.7, 40.4], [-9.1, 38.7], [16.4, 48.2], [18.1, 59.3], [10.8, 59.9],
  [35.2, 31.8], [44.4, 33.3], [51.4, 35.7], [55.3, 25.3], [31.2, 30.0],
  [77.2, 28.6], [72.8, 19.1], [103.8, 1.3], [139.7, 35.7], [121.5, 31.2],
  [151.2, -33.9], [-46.6, -23.5], [-58.4, -34.6], [-70.7, -33.5], [18.4, -33.9],
];

export function GridMap({ session }: GridMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [sensor, setSensor] = useState<DeviceListItem | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const list: DeviceListItem[] = await fetch('/api/devices').then((r) => r.json());
        if (!alive) return;
        setSensor(list.find((x) => x.device === SENSOR_DEVICE_ID) ?? null);
      } catch {
        /* ignore */
      }
    };
    refresh();
    const pollId = window.setInterval(refresh, SENSOR_REFRESH_MS);
    const tickId = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => { alive = false; window.clearInterval(pollId); window.clearInterval(tickId); };
  }, []);

  const view = useMemo(() => {
    if (!session) return null;
    const center = { lat: session.site.lat, lng: session.site.lng };
    const sensorView: GridView['sensor'] = (() => {
      if (!sensor) return null;
      const tele = (sensor.latest_telemetry ?? {}) as Record<string, number | undefined>;
      const teleTs = tele.ts;
      const live = teleTs !== undefined && nowMs / 1000 - teleTs < SENSOR_LIVE_WINDOW_S;
      const score = sensorHealthScore(tele.temp_c, tele.humidity, tele.delta_c);
      const healthClass: SensorHealthClass =
        !live || score === null ? 'unknown' : score > 0.85 ? 'good' : score > 0.55 ? 'warn' : 'bad';
      const tempF = tele.temp_c === undefined ? null : tele.temp_c * 9 / 5 + 32;
      return {
        health: score,
        healthClass,
        color: SENSOR_COLORS[healthClass],
        label: 'Franklin sensor 1',
        state: sensor.state,
        tempF,
        live,
      };
    })();
    const recentTalkingActors = new Set(
      session.events
        .slice(0, 20)
        .filter((event) => event.type !== 'POWER_FLOW_RESULT')
        .flatMap((event) => [event.from, event.to])
    );
    const drawValues = session.datacenters.map((dc) => {
      const gpuDraw = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
      return Math.min(dc.gridAllocation?.allocatedUtilization ?? 1, Math.max(dc.actualUtilization, gpuDraw / Math.max(1, dc.gpuCount)));
    });
    const maxDraw = Math.max(0.01, ...drawValues);
    const nodes = session.datacenters.map((dc, index) => {
      const draw = drawValues[index] ?? 0;
      const relativeDraw = draw / maxDraw;
      const drawClass: DrawClass = relativeDraw > 0.72 ? 'high' : relativeDraw > 0.38 ? 'medium' : 'low';
      const queuePressure = Math.min(1, (dc.queueDepth + (dc.slurm?.pendingJobs ?? 0) * 45 + (dc.slurm?.heldJobs ?? 0) * 70) / 1800);
      const kw = dc.gridAllocation?.allocatedKw ?? Math.max(0, dc.baseKw + dc.gpuCount * dc.gpuKw * draw - dc.batterySupportKw);
      const deferredKw = dc.gridAllocation?.deferredKw ?? 0;
      const maxKw = Math.max(1, dc.baseKw + dc.gpuCount * dc.gpuKw * 0.95);
      const powerPressure = Math.min(1, kw / maxKw);
      const liveDemand = dc.queueDepth > 0 ? Math.sin((session.tick + index * 4) / 3.2) * 0.08 : 0;
      const loadSignal = Math.max(0.08, Math.min(1, powerPressure * 0.62 + queuePressure * 0.18 + Math.min(0.2, deferredKw / 1200) + liveDemand));
      // Use real coordinates — the simulation now seeds DCs at actual Ashburn-
      // area campus locations, so we don't need to amplify around the center.
      const lat = dc.lat;
      const lng = dc.lng;
      return {
        dc,
        draw,
        relativeDraw,
        drawClass,
        drawLabel: drawClass === 'high' ? 'heavy draw' : drawClass === 'medium' ? 'rising draw' : 'light draw',
        color: COLORS[drawClass],
        kw,
        deferredKw,
        loadSignal,
        queuePressure,
        queueLabel: queuePressure > 0.68 ? 'deep queue' : queuePressure > 0.34 ? 'active queue' : 'short queue',
        speaking: recentTalkingActors.has(dc.name),
        index,
        lat,
        lng,
      };
    });
    return { center, sensor: sensorView, nodes };
  }, [session, sensor, nowMs]);

  useEffect(() => {
    if (!containerRef.current || !session || !view || mapRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
        sources: {
          countries: { type: 'vector', url: 'mapbox://mapbox.country-boundaries-v1' },
          streets:   { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' },
          lights: emptyGeoJsonSource(),
          flows: emptyGeoJsonSource(),
          cylinders: emptyGeoJsonSource(),
          labels: emptyGeoJsonSource(),
          site: emptyGeoJsonSource(),
          sensor: emptyGeoJsonSource(),
          'sensor-cylinder': emptyGeoJsonSource(),
        },
        layers: [
          // Base land tone — slightly warmer than the page bg.
          { id: 'bg', type: 'background', paint: { 'background-color': '#1c1c14' } },
          // Park / forest patches — quietly differentiate green spaces.
          {
            id: 'landuse-park',
            type: 'fill',
            source: 'streets',
            'source-layer': 'landuse',
            filter: ['in', ['get', 'class'], ['literal', ['park', 'wood', 'pitch', 'cemetery', 'national_park']]],
            paint: { 'fill-color': 'rgba(168, 174, 130, 0.10)' },
          },
          // Built-up / industrial — subtle warmer tint where there's density.
          {
            id: 'landuse-urban',
            type: 'fill',
            source: 'streets',
            'source-layer': 'landuse',
            filter: ['in', ['get', 'class'], ['literal', ['residential', 'industrial', 'commercial']]],
            paint: { 'fill-color': 'rgba(228, 226, 201, 0.045)' },
          },
          // Water (Potomac, Chesapeake, lakes) — distinctly darker so the
          // shoreline reads even without labels.
          {
            id: 'water',
            type: 'fill',
            source: 'streets',
            'source-layer': 'water',
            paint: { 'fill-color': '#0e1418', 'fill-opacity': 0.85 },
          },
          // Small streams / rivers as thin lines.
          {
            id: 'waterway',
            type: 'line',
            source: 'streets',
            'source-layer': 'waterway',
            minzoom: 7,
            paint: { 'line-color': 'rgba(120, 140, 158, 0.5)', 'line-width': 0.6 },
          },
          // State lines pulled from the streets admin layer (level 1) — gives
          // VA/MD/DC borders without any text.
          {
            id: 'state-lines',
            type: 'line',
            source: 'streets',
            'source-layer': 'admin',
            filter: ['==', ['get', 'admin_level'], 1],
            paint: { 'line-color': FOREGROUND, 'line-width': 0.45, 'line-opacity': 0.35, 'line-dasharray': [2, 2] },
          },
          {
            id: 'country-lines',
            type: 'line',
            source: 'countries',
            'source-layer': 'country_boundaries',
            paint: { 'line-color': FOREGROUND, 'line-width': 0.55, 'line-opacity': 0.5 },
          },
          {
            id: 'lights-glow',
            type: 'circle',
            source: 'lights',
            paint: { 'circle-radius': 5.5, 'circle-color': FOREGROUND, 'circle-opacity': 0.13, 'circle-blur': 1 },
          },
          {
            id: 'lights-core',
            type: 'circle',
            source: 'lights',
            paint: { 'circle-radius': 1.2, 'circle-color': FOREGROUND, 'circle-opacity': 0.5 },
          },
          {
            id: 'flows',
            type: 'line',
            source: 'flows',
            paint: {
              'line-color': ['get', 'color'],
              'line-width': ['interpolate', ['linear'], ['get', 'draw'], 0, 0.8, 1, 2.9],
              'line-opacity': ['interpolate', ['linear'], ['get', 'draw'], 0, 0.22, 1, 0.75],
              'line-dasharray': [1.2, 1.6],
            },
          },
          {
            id: 'site-halo',
            type: 'circle',
            source: 'site',
            paint: { 'circle-radius': 13, 'circle-color': FOREGROUND, 'circle-opacity': 0.1, 'circle-blur': 0.5 },
          },
          {
            id: 'site-core',
            type: 'circle',
            source: 'site',
            paint: { 'circle-radius': 4, 'circle-color': FOREGROUND, 'circle-opacity': 1 },
          },
          {
            id: 'dc-cylinders',
            type: 'fill-extrusion',
            source: 'cylinders',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-base': 0,
              'fill-extrusion-opacity': 0.86,
              'fill-extrusion-vertical-gradient': true,
              'fill-extrusion-height-transition': { duration: 850, delay: 0 },
            },
          },
          {
            id: 'dc-cylinder-rings',
            type: 'line',
            source: 'cylinders',
            paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.8 },
          },
          {
            id: 'sensor-cylinder-extrusion',
            type: 'fill-extrusion',
            source: 'sensor-cylinder',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-base': 0,
              'fill-extrusion-opacity': 0.92,
              'fill-extrusion-vertical-gradient': true,
              'fill-extrusion-height-transition': { duration: 800, delay: 0 },
            },
          },
          {
            id: 'sensor-cylinder-rings',
            type: 'line',
            source: 'sensor-cylinder',
            paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.95 },
          },
          {
            id: 'sensor-pulse',
            type: 'circle',
            source: 'sensor',
            paint: {
              'circle-radius': 22,
              'circle-color': ['get', 'color'],
              'circle-opacity': 0.18,
              'circle-blur': 0.7,
            },
          },
          {
            id: 'sensor-halo',
            type: 'circle',
            source: 'sensor',
            paint: {
              'circle-radius': 12,
              'circle-color': ['get', 'color'],
              'circle-opacity': 0.35,
              'circle-blur': 0.3,
            },
          },
          {
            id: 'sensor-core',
            type: 'circle',
            source: 'sensor',
            paint: {
              'circle-radius': 6,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#1c1c14',
              'circle-stroke-width': 1.5,
              'circle-opacity': 1,
            },
          },
          {
            id: 'sensor-label',
            type: 'symbol',
            source: 'sensor',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 11,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
              'text-offset': [0, 1.6],
              'text-anchor': 'top',
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': ['get', 'color'],
              'text-halo-color': '#202017',
              'text-halo-width': 1.4,
            },
          },
          {
            id: 'dc-labels',
            type: 'symbol',
            source: 'labels',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 12,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
              'text-offset': [0, -1.8],
              'text-anchor': 'bottom',
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': ['get', 'color'],
              'text-halo-color': '#202017',
              'text-halo-width': 1.4,
              'text-opacity': 0.95,
            },
          },
        ],
      },
      // Centered on Ashburn / Data Center Alley. Mercator (not globe) since
      // we're zoomed in too far for a globe projection to look right.
      center: [-77.49, 39.01],
      zoom: 9.4,
      projection: { name: 'mercator' },
      interactive: true,
      attributionControl: false,
      renderWorldCopies: false,
      dragRotate: true,
      pitch: 38,
      bearing: -14,
    });

    // Allow normal zoom: scroll wheel, pinch, double-click, box-select.
    // Earlier we disabled these for the static globe view; at metro scale
    // the user wants to zoom in/out.
    map.scrollZoom.enable();
    map.boxZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoomRotate.enableRotation();

    map.on('style.load', () => {
      map.setFog({
        color: 'rgba(0,0,0,0)',
        'high-color': 'rgba(0,0,0,0)',
        'horizon-blend': 0,
        'space-color': 'rgba(0,0,0,0)',
        'star-intensity': 0,
      });
      updateMapSources(map, view);
    });

    // Slow bearing drift instead of full longitude spin (we're zoomed into
    // a single metro area now). Pause only on real gestures.
    const BEARING_DEG_PER_SEC = 0.6;
    let frame = 0;
    let last = performance.now();
    let interacting = false;
    let resumeTimer: number | null = null;
    const spin = (time: number) => {
      const dt = (time - last) / 1000;
      last = time;
      if (!interacting) {
        const bearing = map.getBearing();
        map.jumpTo({ bearing: bearing + dt * BEARING_DEG_PER_SEC });
      }
      frame = window.requestAnimationFrame(spin);
    };
    frame = window.requestAnimationFrame(spin);

    const pause = () => {
      interacting = true;
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      resumeTimer = null;
    };
    const resume = () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        interacting = false;
        last = performance.now();
      }, 1800);
    };
    map.on('dragstart', pause);
    map.on('rotatestart', pause);
    map.on('pitchstart', pause);
    map.on('touchstart', pause);
    map.on('dragend', resume);
    map.on('rotateend', resume);
    map.on('pitchend', resume);
    map.on('touchend', resume);

    mapRef.current = map;
    return () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      window.cancelAnimationFrame(frame);
      map.remove();
      mapRef.current = null;
    };
  }, [session?.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !view) return;
    if (map.isStyleLoaded()) updateMapSources(map, view);
  }, [view]);

  if (!session || !view) {
    return <div className="grid-empty">Loading the shared default grid location.</div>;
  }

  if (!MAPBOX_TOKEN) {
    return <div className="grid-empty">Set NEXT_PUBLIC_MAPBOX_TOKEN to render the Franklin globe.</div>;
  }

  const systemTone = session.grid.health === 'emergency' ? 'critical' : session.grid.health === 'stressed' ? 'strained' : 'stable';

  return (
    <div className="franklin-globe-grid mapbox-globe-grid" data-health={session.grid.health}>
      <div className="mapbox-globe-canvas" ref={containerRef} aria-label="Mapbox globe with data-center cylinders" />
      <div className="site-card franklin-site-card">
        <span>Grid agent</span>
        <b>{systemTone}</b>
        <small>{session.site.name} · {session.site.region}</small>
      </div>
      <div className="cylinder-readout">
        <div className="readout-title">Cylinder live read</div>
        {view.nodes.map((node) => (
          <div className={`readout-row ${node.drawClass}`} key={node.dc.id}>
            <b>DC {node.index + 1}{node.speaking ? ' ◉' : ''}</b>
            <span>{node.dc.name}</span>
            <small>{node.speaking ? 'talking · ' : ''}{Math.round(node.kw)} kW allocated · {Math.round(node.deferredKw)} kW deferred · {node.queueLabel}</small>
          </div>
        ))}
      </div>
      <div className="map-legend">
        <span><i className="legend-dot low" /> light draw</span>
        <span><i className="legend-dot medium" /> rising draw</span>
        <span><i className="legend-dot high" /> heavy draw</span>
        <span><i className="legend-dot talking" /> talking</span>
      </div>
      <div className="map-note">Cylinder height follows queue depth and GPU draw; ◉ marks recently talking agents.</div>
    </div>
  );
}

function updateMapSources(map: mapboxgl.Map, view: GridView) {
  setSource(map, 'lights', {
    type: 'FeatureCollection',
    features: POPULATED_LIGHTS.map(([lng, lat]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {},
    })),
  });
  setSource(map, 'site', {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [view.center.lng, view.center.lat] },
      properties: {},
    }],
  });
  setSource(map, 'sensor', {
    type: 'FeatureCollection',
    features: view.sensor ? [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [view.center.lng, view.center.lat] },
      properties: {
        color: view.sensor.color,
        label: view.sensor.live
          ? `${view.sensor.label} · ${view.sensor.state}`
          : `${view.sensor.label} · offline`,
      },
    }] : [],
  });
  // Sensor cylinder — explicitly taller than any data-center cylinder so it
  // reads as the primary node on the map.
  const maxDcHeight = view.nodes.reduce((m, n) => Math.max(m, 600 + n.loadSignal * 9000), 600);
  const sensorHeight = Math.max(15000, maxDcHeight * 1.6);
  setSource(map, 'sensor-cylinder', {
    type: 'FeatureCollection',
    features: view.sensor ? [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(view.center.lng, view.center.lat, 0.0028)],
      },
      properties: {
        color: view.sensor.color,
        height: sensorHeight,
      },
    }] : [],
  });
  setSource(map, 'flows', {
    type: 'FeatureCollection',
    features: view.nodes.map((node) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: arcCoordinates([view.center.lng, view.center.lat], [node.lng, node.lat]),
      },
      properties: { color: node.color, draw: node.relativeDraw },
    })),
  });
  setSource(map, 'cylinders', {
    type: 'FeatureCollection',
    features: view.nodes.map((node) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        // Radius capped at ~0.0095° (~1.05 km) so adjacent campuses don't
        // overlap visually at zoom 9-10.
        coordinates: [circlePolygon(node.lng, node.lat, 0.0035 + node.loadSignal * 0.006)],
      },
      properties: {
        color: node.color,
        // Heights tuned for metro-scale view (a few hundred meters,
        // visually scaled by the camera at zoom ≈ 9-10).
        height: 600 + node.loadSignal * 9000,
      },
    })),
  });
  setSource(map, 'labels', {
    type: 'FeatureCollection',
    features: view.nodes.map((node) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [node.lng, node.lat],
      },
      properties: {
        color: node.color,
        label: `${node.speaking ? '◉ ' : ''}DC ${node.index + 1}`,
      },
    })),
  });
}

function setSource(map: mapboxgl.Map, id: string, data: FeatureCollection<Geometry, GeoJsonProperties>) {
  const source = map.getSource(id);
  if (source && 'setData' in source) source.setData(data);
}

function emptyGeoJsonSource(): mapboxgl.GeoJSONSourceSpecification {
  return { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
}

function circlePolygon(lng: number, lat: number, radiusDegrees: number) {
  const points: [number, number][] = [];
  for (let i = 0; i <= 32; i += 1) {
    const angle = (Math.PI * 2 * i) / 32;
    points.push([lng + Math.cos(angle) * radiusDegrees, lat + Math.sin(angle) * radiusDegrees]);
  }
  return points;
}

function arcCoordinates(from: [number, number], to: [number, number]) {
  const coords: [number, number][] = [];
  for (let i = 0; i <= 32; i += 1) {
    const t = i / 32;
    // Smaller arc lift for metro-scale (no globe projection).
    const lift = Math.sin(Math.PI * t) * 0.02;
    coords.push([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t + lift,
    ]);
  }
  return coords;
}
