'use client';

import type { DemoSession, Scenario } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

const SCENARIO_CONFIGS: Record<Scenario, { sourcePu: number; substationKva: number; lineNormamps: number }> = {
  nominal:           { sourcePu: 1.02,  substationKva: 8500, lineNormamps: 430 },
  heatwave:          { sourcePu: 1.0,   substationKva: 7600, lineNormamps: 390 },
  feeder_constraint: { sourcePu: 0.985, substationKva: 6500, lineNormamps: 320 },
  renewable_drop:    { sourcePu: 0.992, substationKva: 7000, lineNormamps: 360 },
  demand_spike:      { sourcePu: 1.0,   substationKva: 7800, lineNormamps: 380 },
};

type Tone = 'ok' | 'warn' | 'critical';

function lineTone(loadingMax: number): Tone {
  if (loadingMax > 1) return 'critical';
  if (loadingMax > 0.82) return 'warn';
  return 'ok';
}
function voltTone(voltageMin: number): Tone {
  if (voltageMin < 0.955) return 'critical';
  if (voltageMin < 0.974) return 'warn';
  return 'ok';
}

export function OpenDssPanel({ session }: { session: DemoSession | null }) {
  if (!session) return <div className="dss-empty">Waiting for the default session.</div>;

  const cfg = SCENARIO_CONFIGS[session.scenario];
  const { grid } = session;
  const dcs = session.datacenters;

  const W = 920;
  const H = 320;
  const srcX = 70;
  const busY = 110;
  const xfX = 220;
  const busStart = 320;
  const busEnd = W - 50;
  const loadTop = H - 120;

  const lt = lineTone(grid.lineLoadingMax);
  const vt = voltTone(grid.voltageMin);

  const N = Math.max(1, dcs.length);
  const xs = dcs.map((_, i) => busStart + ((busEnd - busStart) * (i + 0.5)) / N);
  const totalKw = dcs.reduce((sum, dc) => sum + summarizeKw(dc, session.scenario), 0);
  const maxKw = Math.max(1, ...dcs.map((dc) => summarizeKw(dc, session.scenario)));

  return (
    <div className="dss2">
      <div className="dss2__head">
        <div className="dss2__stat">
          <span>Bus loading</span>
          <b className={`tone-${lt}`}>{grid.lineLoadingMax.toFixed(2)}×</b>
        </div>
        <div className="dss2__stat">
          <span>Voltage floor</span>
          <b className={`tone-${vt}`}>{grid.voltageMin.toFixed(3)} pu</b>
        </div>
        <div className="dss2__stat">
          <span>Total load</span>
          <b>{Math.round(totalKw).toLocaleString()} kW</b>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="dss2__svg" role="img" aria-label="Single-line OpenDSS diagram">
        {/* Source */}
        <g transform={`translate(${srcX}, ${busY})`} className={`dss2-source tone-${vt}`}>
          <circle r="22" className="dss2-source__ring" />
          <circle r="14" className="dss2-source__pulse" />
          <path d="M -10 0 q 5 -8 10 0 t 10 0" className="dss2-source__wave" />
          <text y="-32" className="dss2-cap">source</text>
          <text y="42" className="dss2-val">{cfg.sourcePu.toFixed(2)} pu</text>
        </g>

        {/* Source → Xfmr line with flowing dashes */}
        <line x1={srcX + 22} y1={busY} x2={xfX - 22} y2={busY} className={`dss2-flow tone-${lt}`} />

        {/* Transformer */}
        <g transform={`translate(${xfX}, ${busY})`} className="dss2-xfmr">
          <circle cx="-9" r="13" className="dss2-coil" />
          <circle cx="9"  r="13" className="dss2-coil" />
          <text y="-32" className="dss2-cap">substation</text>
          <text y="42" className="dss2-val">{cfg.substationKva.toLocaleString()} kVA</text>
        </g>

        {/* Xfmr → Bus */}
        <line x1={xfX + 22} y1={busY} x2={busStart} y2={busY} className={`dss2-flow tone-${lt}`} />

        {/* Bus0 */}
        <line x1={busStart} y1={busY} x2={busEnd} y2={busY} className={`dss2-bus tone-${lt}`} />
        <text x={busStart} y={busY - 14} className="dss2-bus-label">bus0 · feeder limit {cfg.lineNormamps} A</text>

        {/* Loads */}
        {dcs.length > 0 ? dcs.map((dc, i) => {
          const x = xs[i];
          const kw = Math.round(summarizeKw(dc, session.scenario));
          const intensity = kw / maxKw;
          const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
          const utilPct = Math.round((allocated / Math.max(1, dc.gpuCount)) * 100);
          const t: Tone = utilPct > 80 ? 'critical' : utilPct > 55 ? 'warn' : 'ok';
          return (
            <g key={dc.id} className={`dss2-load tone-${t}`} style={{ ['--flow-speed' as string]: `${(2.6 - intensity * 1.8).toFixed(2)}s` }}>
              <line x1={x} y1={busY} x2={x} y2={loadTop} className="dss2-flow dss2-flow--vert" />
              <rect x={x - 48} y={loadTop} width="96" height="58" rx="3" className="dss2-load__box" />
              <text x={x} y={loadTop + 18} className="dss2-cap" textAnchor="middle">{shortName(dc.name, i)}</text>
              <text x={x} y={loadTop + 36} className="dss2-val" textAnchor="middle">{kw} kW</text>
              <text x={x} y={loadTop + 50} className="dss2-sub" textAnchor="middle">{utilPct}% · {allocated}/{dc.gpuCount}</text>
            </g>
          );
        }) : (
          <g className="dss2-load tone-ok">
            <line x1={(busStart + busEnd) / 2} y1={busY} x2={(busStart + busEnd) / 2} y2={loadTop} className="dss2-flow dss2-flow--vert" />
            <rect x={(busStart + busEnd) / 2 - 60} y={loadTop} width="120" height="48" rx="3" className="dss2-load__box" />
            <text x={(busStart + busEnd) / 2} y={loadTop + 22} className="dss2-cap" textAnchor="middle">station service</text>
            <text x={(busStart + busEnd) / 2} y={loadTop + 38} className="dss2-val" textAnchor="middle">80 kW</text>
          </g>
        )}
      </svg>
    </div>
  );
}

function shortName(name: string, i: number) {
  if (!name) return `dc${i + 1}`;
  if (name.length <= 12) return name.toLowerCase();
  return name.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
}
