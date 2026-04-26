'use client';

import { useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import type { DemoSession } from '@/lib/types';

type GridMapProps = {
  session: DemoSession | null;
};

type DrawClass = 'low' | 'medium' | 'high';
type GridView = {
  center: { lat: number; lng: number };
  nodes: {
    dc: DemoSession['datacenters'][number];
    draw: number;
    relativeDraw: number;
    drawClass: DrawClass;
    drawLabel: string;
    color: string;
    queuePressure: number;
    queueLabel: string;
    speaking: boolean;
    path: [number, number][];
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
  const pulseRefs = useRef(new Map<string, HTMLElement>());
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const viewRef = useRef<GridView | null>(null);

  const view = useMemo(() => {
    if (!session) return null;
    const center = { lat: session.site.lat, lng: session.site.lng };
    const recentTalkingActors = new Set(
      session.events
        .slice(0, 20)
        .filter((event) => event.type !== 'POWER_FLOW_RESULT')
        .flatMap((event) => [event.from, event.to])
    );
    const drawValues = session.datacenters.map((dc) => {
      const gpuDraw = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
      return Math.max(dc.actualUtilization, gpuDraw / Math.max(1, dc.gpuCount));
    });
    const maxDraw = Math.max(0.01, ...drawValues);
    const nodes = session.datacenters.map((dc, index) => {
      const draw = drawValues[index] ?? 0;
      const relativeDraw = draw / maxDraw;
      const drawClass: DrawClass = relativeDraw > 0.72 ? 'high' : relativeDraw > 0.38 ? 'medium' : 'low';
      const queuePressure = Math.min(1, (dc.queueDepth + (dc.slurm?.pendingJobs ?? 0) * 45 + (dc.slurm?.heldJobs ?? 0) * 70) / 1800);
      const lat = center.lat + (dc.lat - center.lat) * 18;
      const lng = center.lng + (dc.lng - center.lng) * 18;
      return {
        dc,
        draw,
        relativeDraw,
        drawClass,
        drawLabel: drawClass === 'high' ? 'heavy draw' : drawClass === 'medium' ? 'rising draw' : 'light draw',
        color: COLORS[drawClass],
        queuePressure,
        queueLabel: queuePressure > 0.68 ? 'deep queue' : queuePressure > 0.34 ? 'active queue' : 'short queue',
        speaking: recentTalkingActors.has(dc.name),
        index,
        lat,
        lng,
        path: arcCoordinates([center.lng, center.lat], [lng, lat]),
      };
    });
    return { center, nodes };
  }, [session]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

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
          lights: emptyGeoJsonSource(),
          flows: emptyGeoJsonSource(),
          cylinders: emptyGeoJsonSource(),
          labels: emptyGeoJsonSource(),
          site: emptyGeoJsonSource(),
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } },
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
            },
          },
          {
            id: 'dc-cylinder-rings',
            type: 'line',
            source: 'cylinders',
            paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.8 },
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
      center: [view.center.lng, view.center.lat],
      zoom: 1.65,
      projection: { name: 'globe' },
      interactive: true,
      attributionControl: false,
      renderWorldCopies: false,
      dragRotate: true,
      pitch: 18,
      bearing: -18,
    });

    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
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

    let frame = 0;
    let last = performance.now();
    let interacting = false;
    let resumeTimer: number | null = null;
    const spin = (time: number) => {
      const dt = (time - last) / 1000;
      last = time;
      if (!interacting) {
        const centerNow = map.getCenter();
        map.jumpTo({ center: [centerNow.lng + dt * 0.35, centerNow.lat] });
      }
      updatePowerPulses(map, viewRef.current, pulseRefs.current, time);
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
    map.on('mousedown', pause);
    map.on('dragend', resume);
    map.on('rotateend', resume);
    map.on('pitchend', resume);
    map.on('touchend', resume);
    map.on('mouseup', resume);

    mapRef.current = map;
    return () => {
      if (resumeTimer != null) window.clearTimeout(resumeTimer);
      window.cancelAnimationFrame(frame);
      pulseRefs.current.clear();
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
      <div className="flow-pulse-layer" aria-hidden="true">
        {view.nodes.map((node) => (
          <i
            className={`flow-pulse ${node.drawClass}`}
            data-speaking={node.speaking ? 'true' : 'false'}
            key={node.dc.id}
            ref={(element) => {
              if (element) pulseRefs.current.set(node.dc.id, element);
              else pulseRefs.current.delete(node.dc.id);
            }}
          />
        ))}
      </div>
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
            <small>{node.speaking ? 'talking · ' : ''}{node.queueLabel} · {node.dc.queueDepth} queued · {node.dc.slurm?.pendingJobs ?? 0} pending · {Math.round(node.draw * 100)}% draw</small>
          </div>
        ))}
      </div>
      <div className="map-legend">
        <span><i className="legend-dot low" /> light draw</span>
        <span><i className="legend-dot medium" /> rising draw</span>
        <span><i className="legend-dot high" /> heavy draw</span>
        <span><i className="legend-dot talking" /> talking</span>
      </div>
      <div className="map-note">Moving pulses show live load reallocation; ◉ marks recently talking agents.</div>
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
  setSource(map, 'flows', {
    type: 'FeatureCollection',
    features: view.nodes.map((node) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: node.path,
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
        coordinates: [circlePolygon(node.lng, node.lat, 0.28 + node.queuePressure * 0.32)],
      },
      properties: {
        color: node.color,
        height: 70000 + node.queuePressure * 620000,
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

function updatePowerPulses(map: mapboxgl.Map, view: GridView | null, elements: Map<string, HTMLElement>, time: number) {
  if (!view?.nodes.length) return;
  view.nodes.forEach((node) => {
    const element = elements.get(node.dc.id);
    if (!element) return;
    const speed = 0.18 + node.relativeDraw * 0.42;
    const phase = (time / 1000 * speed + node.index * 0.19) % 1;
    const point = samplePath(node.path, phase);
    const projected = map.project(point);
    element.style.setProperty('--flow-scale', String(0.82 + node.relativeDraw * 0.72));
    element.style.transform = `translate3d(${projected.x}px, ${projected.y}px, 0) translate(-50%, -50%) scale(var(--flow-scale))`;
  });
}

function samplePath(path: [number, number][], phase: number) {
  if (path.length < 2) return path[0] ?? [0, 0];
  const exact = phase * (path.length - 1);
  const index = Math.min(path.length - 2, Math.floor(exact));
  const local = exact - index;
  const from = path[index];
  const to = path[index + 1];
  return [
    from[0] + (to[0] - from[0]) * local,
    from[1] + (to[1] - from[1]) * local,
  ] as [number, number];
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
    const lift = Math.sin(Math.PI * t) * 0.8;
    coords.push([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t + lift,
    ]);
  }
  return coords;
}
