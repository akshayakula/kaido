import type { DemoSession } from '@/lib/types';

type GridMapProps = {
  session: DemoSession | null;
};

export function GridMap({ session }: GridMapProps) {
  if (!session) {
    return <div className="grid-empty">Create a session to seed a synthetic grid location.</div>;
  }

  const nodes = session.datacenters.map((dc, index) => {
    const angle = (Math.PI * 2 * (index + 1)) / Math.max(session.datacenters.length, 5);
    const radius = 32 + (index % 2) * 10;
    return {
      dc,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
    };
  });

  return (
    <div className="grid-map" data-health={session.grid.health}>
      <div className="map-grid" />
      <svg className="grid-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="backbone" d="M50 12 L50 88" />
        {nodes.map((node) => (
          <path key={node.dc.id} d={`M50 50 L${node.x} ${node.y}`} />
        ))}
      </svg>
      <div className="site-card">
        <span>Session site</span>
        <b>{session.site.name}</b>
        <small>{session.site.region} · {session.site.lat.toFixed(2)}, {session.site.lng.toFixed(2)}</small>
      </div>
      <div className="grid-agent" style={{ left: '50%', top: '50%' }}>
        <span>Grid Agent</span>
        <b>{session.grid.health.toUpperCase()}</b>
      </div>
      {nodes.map((node) => (
        <div className="dc-map-node" key={node.dc.id} style={{ left: `${node.x}%`, top: `${node.y}%` }}>
          <span>{node.dc.name}</span>
          <b>{Math.round(node.dc.actualUtilization * 100)}% GPU</b>
          <small>{node.dc.lat.toFixed(2)}, {node.dc.lng.toFixed(2)}</small>
        </div>
      ))}
      <div className="map-note">2D feeder view now; coordinates are retained for a future globe.gl layer.</div>
    </div>
  );
}
