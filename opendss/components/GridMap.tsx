import type { DemoSession } from '@/lib/types';

type GridMapProps = {
  session: DemoSession | null;
};

const POPULATED_LIGHTS = [
  [-74.0, 40.7], [-118.2, 34.1], [-122.4, 37.8], [-95.4, 29.7], [-77.0, 38.9],
  [-0.1, 51.5], [2.4, 48.9], [13.4, 52.5], [-6.3, 53.3], [8.7, 50.1],
  [77.2, 28.6], [72.8, 19.1], [103.8, 1.3], [139.7, 35.7], [121.5, 31.2],
  [151.2, -33.9], [-46.6, -23.5], [55.3, 25.3], [31.2, 30.0], [18.4, -33.9],
] as const;

export function GridMap({ session }: GridMapProps) {
  if (!session) {
    return <div className="grid-empty">Loading the shared default grid location.</div>;
  }

  const center = { lat: session.site.lat, lng: session.site.lng };
  const site = project(center.lat, center.lng, center.lat, center.lng);
  const drawValues = session.datacenters.map((dc) => {
    const gpuDraw = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
    return Math.max(dc.actualUtilization, gpuDraw / Math.max(1, dc.gpuCount));
  });
  const maxDraw = Math.max(0.01, ...drawValues);
  const systemTone = session.grid.health === 'emergency' ? 'critical' : session.grid.health === 'stressed' ? 'strained' : 'stable';

  const nodes = session.datacenters.map((dc, index) => {
    const visualLat = center.lat + (dc.lat - center.lat) * 18;
    const visualLng = center.lng + (dc.lng - center.lng) * 18;
    const projected = project(visualLat, visualLng, center.lat, center.lng);
    const labelAngle = (Math.PI * 2 * index) / Math.max(session.datacenters.length, 1) - Math.PI / 2;
    const labelRadius = 31 + (index % 2) * 7;
    const draw = drawValues[index] ?? 0;
    const relativeDraw = draw / maxDraw;
    const drawClass = relativeDraw > 0.72 ? 'high' : relativeDraw > 0.38 ? 'medium' : 'low';
    return {
      dc,
      ...projected,
      labelX: 50 + Math.cos(labelAngle) * labelRadius,
      labelY: 50 + Math.sin(labelAngle) * labelRadius,
      drawClass,
      drawLabel: drawClass === 'high' ? 'heavy draw' : drawClass === 'medium' ? 'rising draw' : 'light draw',
    };
  });

  const lights = POPULATED_LIGHTS.map(([lng, lat]) => project(lat, lng, center.lat, center.lng)).filter((point) => point.visible);

  return (
    <div className="franklin-globe-grid" data-health={session.grid.health}>
      <div className="globe-orbit" aria-hidden="true" />
      <svg className="globe-svg" viewBox="0 0 100 100" aria-label="Data centers on globe">
        <defs>
          <clipPath id="globe-clip">
            <circle cx="50" cy="50" r="45" />
          </clipPath>
        </defs>
        <circle className="globe-disc" cx="50" cy="50" r="45" />
        <g className="globe-gridlines" clipPath="url(#globe-clip)">
          {[20, 35, 50, 65, 80].map((x) => <path key={`lon-${x}`} d={`M${x} 6 C${50 + (x - 50) * 0.45} 24 ${50 + (x - 50) * 0.45} 76 ${x} 94`} />)}
          {[18, 32, 50, 68, 82].map((y) => <ellipse key={`lat-${y}`} cx="50" cy={y} rx={44 - Math.abs(y - 50) * 0.42} ry="4.8" />)}
        </g>
        <g clipPath="url(#globe-clip)">
          {lights.map((light, index) => <circle className="city-light" key={index} cx={light.x} cy={light.y} r="0.55" />)}
          {nodes.map((node) => (
            <path
              className={`globe-flow ${node.drawClass}`}
              key={`flow-${node.dc.id}`}
              d={`M${site.x} ${site.y} Q${(site.x + node.x) / 2} ${(site.y + node.y) / 2 - 8} ${node.x} ${node.y}`}
            />
          ))}
        </g>
        <circle className="site-pulse" cx={site.x} cy={site.y} r="6.5" />
        <circle className="site-core" cx={site.x} cy={site.y} r="2.3" />
        {nodes.map((node) => (
          <g className={`globe-dc ${node.drawClass}`} key={node.dc.id} transform={`translate(${node.x} ${node.y})`}>
            <circle r="3.1" />
            <circle r="6.3" />
          </g>
        ))}
      </svg>
      <div className="site-card franklin-site-card">
        <span>Grid agent</span>
        <b>{systemTone}</b>
        <small>{session.site.name} · {session.site.region}</small>
      </div>
      {nodes.map((node) => (
        <div className={`dc-map-node ${node.drawClass}`} key={node.dc.id} style={{ left: `${node.labelX}%`, top: `${node.labelY}%` }}>
          <span>{node.dc.name}</span>
          <b>{node.drawLabel}</b>
          <small>{node.dc.slurm?.state ?? 'scheduler active'}</small>
        </div>
      ))}
      <div className="map-legend">
        <span><i className="legend-dot low" /> light draw</span>
        <span><i className="legend-dot medium" /> rising draw</span>
        <span><i className="legend-dot high" /> heavy draw</span>
      </div>
      <div className="map-note">Data-center agents are plotted from their session coordinates; arc weight shows relative power draw.</div>
    </div>
  );
}

function project(lat: number, lng: number, centerLat: number, centerLng: number) {
  const phi = toRad(lat);
  const lambda = toRad(lng - centerLng);
  const phi0 = toRad(centerLat);
  const cosPhi = Math.cos(phi);
  const x = cosPhi * Math.sin(lambda);
  const y = Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * cosPhi * Math.cos(lambda);
  const z = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * cosPhi * Math.cos(lambda);
  return {
    x: 50 + x * 42,
    y: 50 - y * 42,
    visible: z >= -0.12,
  };
}

function toRad(value: number) {
  return (value * Math.PI) / 180;
}
