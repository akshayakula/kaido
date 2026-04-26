'use client';

import type { DemoSession } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

export function CylindersPanel({ session }: { session: DemoSession | null }) {
  if (!session) {
    return <div className="cyl2__empty">Waiting for the default session.</div>;
  }
  const recentTalkers = new Set(
    session.events
      .slice(0, 20)
      .filter((event) => event.type !== 'POWER_FLOW_RESULT')
      .flatMap((event) => [event.from, event.to]),
  );
  const dcs = session.datacenters;
  if (!dcs.length) return <div className="cyl2__empty">No data centers joined yet.</div>;

  const drawValues = dcs.map((dc) => {
    const gpuDraw = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
    return Math.min(
      dc.gridAllocation?.allocatedUtilization ?? 1,
      Math.max(dc.actualUtilization, gpuDraw / Math.max(1, dc.gpuCount)),
    );
  });
  const maxDraw = Math.max(0.01, ...drawValues);

  return (
    <ul className="cyl2">
      {dcs.map((dc, i) => {
        const draw = drawValues[i];
        const relative = draw / maxDraw;
        const drawClass = relative > 0.72 ? 'high' : relative > 0.38 ? 'mid' : 'low';
        const kw = dc.gridAllocation?.allocatedKw ?? Math.max(0, summarizeKw(dc, session.scenario));
        const deferredKw = dc.gridAllocation?.deferredKw ?? 0;
        const queuePressure = Math.min(
          1,
          (dc.queueDepth + (dc.slurm?.pendingJobs ?? 0) * 45 + (dc.slurm?.heldJobs ?? 0) * 70) / 1800,
        );
        const queueLabel = queuePressure > 0.68 ? 'deep queue' : queuePressure > 0.34 ? 'active queue' : 'short queue';
        const speaking = recentTalkers.has(dc.name);
        return (
          <li key={dc.id} className={`cyl2__row cyl2__row--${drawClass} ${speaking ? 'cyl2__row--talk' : ''}`}>
            <div className="cyl2__head">
              <span className="cyl2__dot" aria-hidden="true" />
              <b className="cyl2__name">{dc.name}</b>
              {speaking && <span className="cyl2__live">live</span>}
            </div>
            <div className="cyl2__meta">
              <span><i>{Math.round(kw)}</i> kw</span>
              <span><i>{Math.round(deferredKw)}</i> deferred</span>
              <span className="cyl2__q">{queueLabel}</span>
            </div>
            <div className="cyl2__bar">
              <i style={{ width: `${Math.round(relative * 100)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
