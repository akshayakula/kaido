import type { DemoSession } from '@/lib/types';

type GridMapProps = {
  session: DemoSession | null;
};

export function GridMap({ session }: GridMapProps) {
  if (!session) {
    return <div className="grid-empty">Loading the shared default grid location.</div>;
  }

  const drawValues = session.datacenters.map((dc) => {
    const gpuDraw = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
    const schedulerDraw = gpuDraw / Math.max(1, dc.gpuCount);
    return Math.max(schedulerDraw, dc.actualUtilization);
  });
  const maxDraw = Math.max(0.01, ...drawValues);
  const systemTone = session.grid.health === 'emergency' ? 'critical' : session.grid.health === 'stressed' ? 'strained' : 'stable';

  const nodes = session.datacenters.map((dc, index) => {
    const angle = (Math.PI * 2 * (index + 1)) / Math.max(session.datacenters.length, 5);
    const radius = 32 + (index % 2) * 10;
    const draw = drawValues[index] ?? 0;
    const relativeDraw = draw / maxDraw;
    const drawClass = relativeDraw > 0.72 ? 'high' : relativeDraw > 0.38 ? 'medium' : 'low';
    return {
      dc,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      drawClass,
      drawLabel: drawClass === 'high' ? 'high draw' : drawClass === 'medium' ? 'medium draw' : 'low draw',
    };
  });

  return (
    <div className="grid-map" data-health={session.grid.health}>
      <div className="map-grid" />
      <svg className="grid-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="backbone" d="M50 12 L50 88" />
        {nodes.map((node) => (
          <path className={`feeder-flow ${node.drawClass}`} key={node.dc.id} d={`M50 50 L${node.x} ${node.y}`} />
        ))}
      </svg>
      <div className="site-card">
        <span>Session site</span>
        <b>{session.site.name}</b>
        <small>{session.site.region} · {session.site.lat.toFixed(2)}, {session.site.lng.toFixed(2)}</small>
      </div>
      <div className="grid-agent" style={{ left: '50%', top: '50%' }}>
        <span>Grid Agent</span>
        <b>{systemTone}</b>
      </div>
      {nodes.map((node) => (
        <div className={`dc-map-node ${node.drawClass}`} key={node.dc.id} style={{ left: `${node.x}%`, top: `${node.y}%` }}>
          <span>{node.dc.name}</span>
          <b>{node.drawLabel}</b>
          <small>{node.dc.slurm?.state ?? 'scheduler active'}</small>
        </div>
      ))}
      <div className="map-legend">
        <span><i className="legend-dot low" /> low draw</span>
        <span><i className="legend-dot medium" /> medium draw</span>
        <span><i className="legend-dot high" /> high draw</span>
      </div>
      <div className="map-note">Line brightness and thickness show relative draw; grid color shows rough system health.</div>
    </div>
  );
}
