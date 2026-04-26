'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
const FOREGROUND = '#e4e2c9';
const ACCENT = '#e27b63';

const GRID_REGIONS = [
  { label: 'PJM', lng: -77.04, lat: 38.9 },
  { label: 'ERCOT', lng: -97.74, lat: 30.27 },
  { label: 'CAISO', lng: -121.49, lat: 38.58 },
  { label: 'WECC', lng: -111.89, lat: 40.76 },
  { label: 'MISO', lng: -93.27, lat: 44.98 },
  { label: 'SERC', lng: -84.39, lat: 33.75 },
  { label: 'NYISO', lng: -74.0, lat: 40.71 },
];

const CITY_LIGHTS: [number, number][] = [
  [-74.0, 40.7], [-73.9, 40.8], [-77.0, 38.9], [-87.6, 41.9], [-95.4, 29.7],
  [-118.2, 34.1], [-122.4, 37.8], [-122.3, 47.6], [-79.4, 43.7], [-73.6, 45.5],
  [-0.1, 51.5], [2.4, 48.9], [13.4, 52.5], [4.9, 52.4], [12.5, 41.9],
  [-3.7, 40.4], [-9.1, 38.7], [16.4, 48.2], [18.1, 59.3], [10.8, 59.9],
  [35.2, 31.8], [44.4, 33.3], [51.4, 35.7], [55.3, 25.3], [31.2, 30.0],
  [77.2, 28.6], [72.8, 19.1], [103.8, 1.3], [139.7, 35.7], [121.5, 31.2],
  [151.2, -33.9], [-46.6, -23.5], [-58.4, -34.6], [-70.7, -33.5], [18.4, -33.9],
];

export function HomeMapboxGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
        sources: {
          countries: { type: 'vector', url: 'mapbox://mapbox.country-boundaries-v1' },
          lights: emptyGeoJsonSource(),
          regions: emptyGeoJsonSource(),
          flows: emptyGeoJsonSource(),
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } },
          {
            id: 'country-lines',
            type: 'line',
            source: 'countries',
            'source-layer': 'country_boundaries',
            paint: { 'line-color': FOREGROUND, 'line-width': 0.48, 'line-opacity': 0.56 },
          },
          {
            id: 'lights-glow',
            type: 'circle',
            source: 'lights',
            paint: { 'circle-radius': 5.5, 'circle-color': FOREGROUND, 'circle-opacity': 0.12, 'circle-blur': 1 },
          },
          {
            id: 'lights-core',
            type: 'circle',
            source: 'lights',
            paint: { 'circle-radius': 1.15, 'circle-color': FOREGROUND, 'circle-opacity': 0.54 },
          },
          {
            id: 'home-flows',
            type: 'line',
            source: 'flows',
            paint: {
              'line-color': ACCENT,
              'line-width': 1.2,
              'line-opacity': 0.64,
              'line-dasharray': [1.2, 1.5],
            },
          },
          {
            id: 'region-halo',
            type: 'circle',
            source: 'regions',
            paint: { 'circle-radius': 13, 'circle-color': FOREGROUND, 'circle-opacity': 0.1, 'circle-blur': 0.45 },
          },
          {
            id: 'region-core',
            type: 'circle',
            source: 'regions',
            paint: { 'circle-radius': 3.8, 'circle-color': FOREGROUND, 'circle-opacity': 0.95 },
          },
          {
            id: 'region-labels',
            type: 'symbol',
            source: 'regions',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 12,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
              'text-offset': [0, 1.25],
              'text-anchor': 'top',
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': FOREGROUND,
              'text-halo-color': '#202017',
              'text-halo-width': 1.2,
              'text-opacity': 0.92,
            },
          },
        ],
      },
      center: [-95, 38],
      zoom: 1.36,
      projection: { name: 'globe' },
      interactive: true,
      attributionControl: false,
      renderWorldCopies: false,
      dragRotate: true,
      pitch: 8,
      bearing: -10,
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
      updateHomeSources(map);
    });

    // Rotate ~one revolution every minute (6 °/sec). Pause only on real
    // gestures (drag / rotate / pitch / touch). A hover or stray click
    // shouldn't stop the spin.
    const SPIN_DEG_PER_SEC = 6;
    let frame = 0;
    let last = performance.now();
    let interacting = false;
    let resumeTimer: number | null = null;
    const spin = (time: number) => {
      const dt = (time - last) / 1000;
      last = time;
      if (!interacting) {
        const center = map.getCenter();
        const nextLng = ((center.lng + dt * SPIN_DEG_PER_SEC + 180) % 360) - 180;
        map.jumpTo({ center: [nextLng, center.lat] });
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
      }, 1600);
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
  }, []);

  if (!MAPBOX_TOKEN) {
    return <div className="home-mapbox-empty">Set NEXT_PUBLIC_MAPBOX_TOKEN to render the Mapbox globe.</div>;
  }

  return <div className="home-mapbox-globe" ref={containerRef} aria-label="Mapbox globe with Franklin grid regions" />;
}

function updateHomeSources(map: mapboxgl.Map) {
  setSource(map, 'lights', {
    type: 'FeatureCollection',
    features: CITY_LIGHTS.map(([lng, lat]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {},
    })),
  });
  setSource(map, 'regions', {
    type: 'FeatureCollection',
    features: GRID_REGIONS.map((region) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [region.lng, region.lat] },
      properties: { label: region.label },
    })),
  });
  setSource(map, 'flows', {
    type: 'FeatureCollection',
    features: GRID_REGIONS.filter((region) => region.label !== 'PJM').map((region) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: arcCoordinates([-77.04, 38.9], [region.lng, region.lat]),
      },
      properties: {},
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

function arcCoordinates(from: [number, number], to: [number, number]) {
  const coords: [number, number][] = [];
  for (let i = 0; i <= 32; i += 1) {
    const t = i / 32;
    const lift = Math.sin(Math.PI * t) * 1.2;
    coords.push([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t + lift,
    ]);
  }
  return coords;
}
