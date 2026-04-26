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

const N_BUSES = 4;
const BUS_LABELS = ['bus0', 'bus1', 'bus2', 'bus3'];
const FEEDER_NAMES = ['backbone', 'feeder1', 'feeder2', 'feeder3'];

type Tone = 'ok' | 'warn' | 'critical';

function lineTone(loading: number): Tone {
  if (loading > 1) return 'critical';
  if (loading > 0.82) return 'warn';
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

  // ── Layout constants ──────────────────────────────────────────────────────
  const W = 1120;
  const srcX = 65;
  const xfX  = 205;
  const busY  = 130;
  // 4 bus x-centres, evenly spread from xfmr to right edge
  const busXs = [340, 540, 740, 940];
  const BOX_W = 108;
  const BOX_H = 76;
  const BOX_GAP = 10;
  const LOAD_TOP = busY + 90;

  // Group DCs equally across the 4 buses by round-robin index
  const dcsByBus: typeof dcs[] = Array.from({ length: N_BUSES }, () => []);
  dcs.forEach((dc, i) => dcsByBus[i % N_BUSES].push(dc));
  const maxPerBus = Math.max(1, ...dcsByBus.map((b) => b.length));
  const H = LOAD_TOP + maxPerBus * (BOX_H + BOX_GAP) + 68;

  // Per-feeder loading lookup (from solver; falls back to global max)
  const lineLoadingMap: Record<string, number> = {};
  (grid.lineLoadings ?? []).forEach((l) => {
    lineLoadingMap[l.name.toLowerCase()] = l.loading;
  });
  const feederLoading = (name: string) => lineLoadingMap[name] ?? grid.lineLoadingMax;

  const vt = voltTone(grid.voltageMin);
  const totalKw = dcs.reduce((sum, dc) => sum + summarizeKw(dc, session.scenario), 0);

  return (
    <div className="dss-circuit">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="dss-svg"
        role="img"
        aria-label="OpenDSS single-line circuit diagram"
      >
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
          </marker>
        </defs>

        {/* ── Source ──────────────────────────────────────────────────── */}
        <g transform={`translate(${srcX}, ${busY})`} className={`dss-node tone-${vt}`}>
          <circle r="26" className="dss-source-ring" />
          <path d="M -12 0 q 6 -10 12 0 t 12 0" className="dss-source-wave" />
          <text y="-38" className="dss-cap">Source · PJM</text>
          <text y="48"  className="dss-val">{config.sourcePu.toFixed(3)} pu</text>
          <text y="64"  className="dss-sub">12.47 kV · 3φ</text>
        </g>

        {/* ── Wire: source → transformer ───────────────────────────────── */}
        <line x1={srcX + 26} y1={busY} x2={xfX - 28} y2={busY} className="dss-wire" />

        {/* ── Substation transformer ──────────────────────────────────── */}
        <g transform={`translate(${xfX}, ${busY})`} className="dss-node">
          <circle cx="-12" r="16" className="dss-coil" />
          <circle cx="12"  r="16" className="dss-coil" />
          <text y="-38" className="dss-cap">Substation Xfmr</text>
          <text y="48"  className="dss-val">{config.substationKva.toLocaleString()} kVA</text>
          <text y="64"  className="dss-sub">12.47 / 12.47 kV · YY</text>
        </g>

        {/* ── Wire: xfmr → bus0 (Backbone) ────────────────────────────── */}
        {(() => {
          const lt = lineTone(feederLoading('backbone'));
          return (
            <>
              <line x1={xfX + 28} y1={busY} x2={busXs[0] - 6} y2={busY} className={`dss-wire tone-${lt}`} />
              <text x={(xfX + 28 + busXs[0] - 6) / 2} y={busY - 10} textAnchor="middle" className="dss-sub">
                Backbone
              </text>
            </>
          );
        })()}

        {/* ── Feeder segments between buses ───────────────────────────── */}
        {[0, 1, 2].map((seg) => {
          const x1 = busXs[seg] + 6;
          const x2 = busXs[seg + 1] - 6;
          const mid = (x1 + x2) / 2;
          const lt = lineTone(feederLoading(FEEDER_NAMES[seg + 1]));
          return (
            <g key={seg}>
              <line x1={x1} y1={busY} x2={x2} y2={busY} className={`dss-wire tone-${lt}`} />
              <text x={mid} y={busY - 10} textAnchor="middle" className="dss-sub">
                Feeder{seg + 1} · {(feederLoading(FEEDER_NAMES[seg + 1]) * 100).toFixed(0)}%
              </text>
            </g>
          );
        })}

        {/* ── Bus nodes (vertical marks + labels) ─────────────────────── */}
        {busXs.map((bx, bi) => {
          const busKw = dcsByBus[bi].reduce((s, dc) => s + summarizeKw(dc, session.scenario), 0);
          const lt = lineTone(feederLoading(FEEDER_NAMES[bi] ?? 'backbone'));
          return (
            <g key={bi}>
              {/* Vertical bus bar mark */}
              <line x1={bx} y1={busY - 14} x2={bx} y2={busY + 14} className={`dss-bus tone-${lt}`} strokeWidth={4} />
              <text x={bx} y={busY + 30} textAnchor="middle" className="dss-bus-label">
                {BUS_LABELS[bi]}
              </text>
              {busKw > 0 && (
                <text x={bx} y={busY - 22} textAnchor="middle" className="dss-sub">
                  {Math.round(busKw).toLocaleString()} kW
                </text>
              )}
            </g>
          );
        })}

        {/* ── Total kW label top-right ─────────────────────────────────── */}
        <text x={W - 12} y={busY - 22} textAnchor="end" className="dss-bus-label">
          {Math.round(totalKw).toLocaleString()} kW total · limit {config.lineNormamps} A
        </text>

        {/* ── DC loads per bus column ──────────────────────────────────── */}
        {dcs.length > 0
          ? busXs.map((bx, bi) =>
              dcsByBus[bi].length > 0
                ? dcsByBus[bi].map((dc, ci) => {
                    const y = LOAD_TOP + ci * (BOX_H + BOX_GAP);
                    const kw = Math.round(summarizeKw(dc, session.scenario));
                    const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
                    const utilPct = Math.round((allocated / Math.max(1, dc.gpuCount)) * 100);
                    const dcTone: Tone = utilPct > 80 ? 'critical' : utilPct > 55 ? 'warn' : 'ok';
                    // Global DC index for "DC N" label
                    const globalIdx = bi + ci * N_BUSES + 1;
                    // Wire from bus bar (first DC) or from bottom of previous DC box
                    const wireY1 = ci === 0 ? busY + 14 : LOAD_TOP + (ci - 1) * (BOX_H + BOX_GAP) + BOX_H;
                    const wireMidY = wireY1 + (y - wireY1) / 2;
                    return (
                      <g key={dc.id} className={`dss-load-group tone-${dcTone}`}>
                        {/* Tap line down from bus or previous box */}
                        <line x1={bx} y1={wireY1} x2={bx} y2={y} className="dss-wire" markerEnd="url(#arrow)" />
                        {/* Branch label mid-wire */}
                        <text x={bx + 6} y={wireMidY} className="dss-sub">
                          Line.DC{globalIdx}
                        </text>
                        {/* Load box */}
                        <rect x={bx - BOX_W / 2} y={y} width={BOX_W} height={BOX_H} rx="4" className="dss-load-box" />
                        <text x={bx} y={y + 16} textAnchor="middle" className="dss-cap">DC {globalIdx}</text>
                        <text x={bx} y={y + 34} textAnchor="middle" className="dss-val">{kw} kW</text>
                        <text x={bx} y={y + 50} textAnchor="middle" className="dss-sub">{allocated}/{dc.gpuCount} GPU · {utilPct}%</text>
                        <text x={bx} y={y + 66} textAnchor="middle" className="dss-dim">{dc.name}</text>
                        {/* Ground */}
                        <g transform={`translate(${bx}, ${y + BOX_H})`} className="dss-ground">
                          <line x1="-8" y1="4"  x2="8"  y2="4" />
                          <line x1="-5" y1="8"  x2="5"  y2="8" />
                          <line x1="-2" y1="12" x2="2" y2="12" />
                        </g>
                      </g>
                    );
                  })
                : null
            )
          : (
            // No DCs — station service on bus0
            <g className="dss-load-group tone-ok">
              <line x1={busXs[0]} y1={busY + 14} x2={busXs[0]} y2={LOAD_TOP} className="dss-wire" />
              <rect x={busXs[0] - 70} y={LOAD_TOP} width="140" height="58" rx="4" className="dss-load-box" />
              <text x={busXs[0]} y={LOAD_TOP + 22} textAnchor="middle" className="dss-cap">Station service</text>
              <text x={busXs[0]} y={LOAD_TOP + 44} textAnchor="middle" className="dss-val">80 kW</text>
            </g>
          )
        }
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
