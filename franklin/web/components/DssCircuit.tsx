'use client';

import type { DemoSession, Scenario } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

type DssConfig = { sourcePu: number; substationKva: number; lineNormamps: number; cooling: number };

const SCENARIO_CONFIGS: Record<Scenario, DssConfig> = {
  nominal:           { sourcePu: 1.02,  substationKva: 8500, lineNormamps: 430, cooling: 0.28 },
  heatwave:          { sourcePu: 1.0,   substationKva: 7600, lineNormamps: 390, cooling: 0.44 },
  feeder_constraint: { sourcePu: 0.985, substationKva: 6500, lineNormamps: 320, cooling: 0.32 },
  renewable_drop:    { sourcePu: 0.992, substationKva: 7000, lineNormamps: 360, cooling: 0.30 },
  demand_spike:      { sourcePu: 1.0,   substationKva: 7800, lineNormamps: 380, cooling: 0.36 },
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

export function DssCircuit({ session }: { session: DemoSession | null }) {
  if (!session) {
    return <div className="empty">Waiting for the default session.</div>;
  }

  const config = SCENARIO_CONFIGS[session.scenario];
  const { grid } = session;
  const dcs = session.datacenters;

  const W = 960;
  const H = 360;
  const srcX = 70;
  const busY = 120;
  const xfX = 230;
  const busStart = 340;
  const busEnd = W - 60;
  const loadTop = H - 130;

  const lt = lineTone(grid.lineLoadingMax);
  const vt = voltTone(grid.voltageMin);

  const N = Math.max(1, dcs.length);
  const xs = dcs.map((_, i) => busStart + ((busEnd - busStart) * (i + 0.5)) / N);

  const totalKw = dcs.reduce((sum, dc) => sum + summarizeKw(dc, session.scenario), 0);

  return (
    <div className="dss-circuit">
      <svg viewBox={`0 0 ${W} ${H}`} className="dss-svg" role="img" aria-label="OpenDSS single-line circuit diagram">
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
          </marker>
        </defs>

        {/* Source (PJM/Thévenin) */}
        <g transform={`translate(${srcX}, ${busY})`} className={`dss-node tone-${vt}`}>
          <circle r="26" className="dss-source-ring" />
          <path d="M -12 0 q 6 -10 12 0 t 12 0" className="dss-source-wave" />
          <text y="-38" className="dss-cap">Source · PJM</text>
          <text y="48" className="dss-val">{config.sourcePu.toFixed(3)} pu</text>
          <text y="64" className="dss-sub">12.47 kV · 3φ</text>
        </g>

        {/* Wire: source → transformer */}
        <line x1={srcX + 26} y1={busY} x2={xfX - 28} y2={busY} className="dss-wire" />

        {/* Substation transformer (two-coil symbol) */}
        <g transform={`translate(${xfX}, ${busY})`} className="dss-node">
          <circle cx="-12" r="16" className="dss-coil" />
          <circle cx="12"  r="16" className="dss-coil" />
          <text y="-38" className="dss-cap">Substation Xfmr</text>
          <text y="48" className="dss-val">{config.substationKva.toLocaleString()} kVA</text>
          <text y="64" className="dss-sub">12.47 / 12.47 kV · YY</text>
        </g>

        {/* Wire: transformer → bus0 */}
        <line x1={xfX + 28} y1={busY} x2={busStart} y2={busY} className="dss-wire" />

        {/* bus0 — thick horizontal bar, color reflects loading */}
        <line x1={busStart} y1={busY} x2={busEnd} y2={busY} className={`dss-bus tone-${lt}`} />
        <text x={busStart} y={busY - 16} className="dss-bus-label">
          bus0 · feeder limit {config.lineNormamps} A · loading {grid.lineLoadingMax.toFixed(2)}×
        </text>
        <text x={busEnd} y={busY - 16} textAnchor="end" className="dss-bus-label">
          {Math.round(totalKw).toLocaleString()} kW total
        </text>

        {/* Loads */}
        {dcs.length > 0 ? dcs.map((dc, i) => {
          const x = xs[i];
          const kw = Math.round(summarizeKw(dc, session.scenario));
          const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
          const utilPct = Math.round((allocated / Math.max(1, dc.gpuCount)) * 100);
          const dcTone: Tone = utilPct > 80 ? 'critical' : utilPct > 55 ? 'warn' : 'ok';
          return (
            <g key={dc.id} className={`dss-load-group tone-${dcTone}`}>
              {/* Tap line down from bus */}
              <line x1={x} y1={busY} x2={x} y2={loadTop - 4} className="dss-wire" markerEnd="url(#arrow)" />
              {/* Branch length label (Line.DCi) */}
              <text x={x + 6} y={busY + 32} className="dss-sub">Line.DC{i + 1}</text>
              {/* Load box */}
              <rect x={x - 56} y={loadTop} width="112" height="68" rx="4" className="dss-load-box" />
              <text x={x} y={loadTop + 18} textAnchor="middle" className="dss-cap">DC {i + 1}</text>
              <text x={x} y={loadTop + 38} textAnchor="middle" className="dss-val">{kw} kW</text>
              <text x={x} y={loadTop + 54} textAnchor="middle" className="dss-sub">{allocated}/{dc.gpuCount} GPU · {utilPct}%</text>
              <text x={x} y={loadTop + 86} textAnchor="middle" className="dss-dim">{dc.name}</text>
              {/* Ground symbol */}
              <g transform={`translate(${x}, ${loadTop + 68})`} className="dss-ground">
                <line x1="-8" y1="4" x2="8" y2="4" />
                <line x1="-5" y1="8" x2="5" y2="8" />
                <line x1="-2" y1="12" x2="2" y2="12" />
              </g>
            </g>
          );
        }) : (
          <g className="dss-load-group tone-ok">
            <line x1={(busStart + busEnd) / 2} y1={busY} x2={(busStart + busEnd) / 2} y2={loadTop - 4} className="dss-wire" />
            <rect x={(busStart + busEnd) / 2 - 70} y={loadTop} width="140" height="58" rx="4" className="dss-load-box" />
            <text x={(busStart + busEnd) / 2} y={loadTop + 22} textAnchor="middle" className="dss-cap">Station service</text>
            <text x={(busStart + busEnd) / 2} y={loadTop + 44} textAnchor="middle" className="dss-val">80 kW</text>
          </g>
        )}
      </svg>

      <div className="dss-facts compact">
        <span><b>Voltage floor</b>{grid.voltageMin.toFixed(3)} pu</span>
        <span><b>Loading</b>{grid.lineLoadingMax.toFixed(2)}×</span>
        <span><b>Reserve</b>{Math.round(grid.reserveKw).toLocaleString()} kW</span>
        <span><b>Frequency</b>{grid.frequencyHz.toFixed(2)} Hz</span>
        <span><b>Losses</b>{Math.round(grid.lossesKw)} kW</span>
      </div>
    </div>
  );
}
