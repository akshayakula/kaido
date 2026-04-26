'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { DemoSession } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

type Tone = 'ok' | 'warn' | 'critical';

function tone(value: number, warn: number, crit: number, invert = false): Tone {
  if (invert) {
    if (value < crit) return 'critical';
    if (value < warn) return 'warn';
    return 'ok';
  }
  if (value > crit) return 'critical';
  if (value > warn) return 'warn';
  return 'ok';
}

function scale(value: number, min: number, max: number) {
  return Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 100);
}

const HISTORY_LEN = 24;

export function AnalogReadouts({ session }: { session: DemoSession | null }) {
  const [capacityHistory, setCapacityHistory] = useState<number[]>([]);
  const lastTickRef = useRef<number>(-1);

  useEffect(() => {
    if (!session) return;
    if (session.tick === lastTickRef.current) return;
    lastTickRef.current = session.tick;
    const totalKw = session.datacenters.reduce((s, dc) => s + summarizeKw(dc, session.scenario), 0);
    const firmKw = session.datacenters.reduce(
      (s, dc) => s + dc.baseKw + dc.gpuCount * dc.gpuKw * 0.95,
      0,
    );
    const used = firmKw > 0 ? Math.min(1.2, totalKw / firmKw) : 0;
    setCapacityHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), used]);
  }, [session]);

  if (!session) {
    return <div className="readouts2 readouts2--empty">Waiting for OpenDSS state.</div>;
  }

  const { grid } = session;
  const totalKw = session.datacenters.reduce((s, dc) => s + summarizeKw(dc, session.scenario), 0);
  const firmKw = session.datacenters.reduce(
    (s, dc) => s + dc.baseKw + dc.gpuCount * dc.gpuKw * 0.95,
    0,
  );
  const used = firmKw > 0 ? Math.min(1.2, totalKw / firmKw) : 0;
  const headroomKw = Math.max(0, firmKw - totalKw);
  const capTone: Tone = used > 0.95 ? 'critical' : used > 0.8 ? 'warn' : 'ok';

  return (
    <div className="readouts2">
      <div className={`readouts2__hero tone-${capTone}`}>
        <div className="readouts2__hero-left">
          <p className="eyebrow">Capacity used</p>
          <div className="readouts2__hero-num">
            <b>{Math.round(used * 100)}</b>
            <span>%</span>
          </div>
          <small>{Math.round(headroomKw).toLocaleString()} kW headroom · {Math.round(firmKw).toLocaleString()} kW firm</small>
        </div>
        <Sparkline values={capacityHistory} tone={capTone} />
      </div>

      <div className="readouts2__grid">
        <Gauge
          label="Voltage floor"
          value={`${grid.voltageMin.toFixed(3)} pu`}
          tone={tone(grid.voltageMin, 0.974, 0.955, true)}
          fill={scale(grid.voltageMin, 0.9, 1.03)}
        />
        <Gauge
          label="Feeder loading"
          value={`${grid.lineLoadingMax.toFixed(2)}×`}
          tone={tone(grid.lineLoadingMax, 0.82, 1)}
          fill={scale(grid.lineLoadingMax, 0.3, 1.25)}
        />
        <Gauge
          label="Reserve"
          value={`${Math.round(grid.reserveKw).toLocaleString()} kW`}
          tone={tone(grid.reserveKw, 900, 250, true)}
          fill={scale(grid.reserveKw, 0, 2800)}
        />
        <Gauge
          label="Frequency"
          value={`${grid.frequencyHz.toFixed(2)} Hz`}
          tone={tone(grid.frequencyHz, 59.98, 59.95, true)}
          fill={scale(grid.frequencyHz, 59.9, 60.05)}
        />
      </div>
    </div>
  );
}

function Gauge({ label, value, tone, fill }: { label: string; value: string; tone: Tone; fill: number }) {
  return (
    <div className={`gauge2 tone-${tone}`} style={{ ['--g' as string]: `${fill}%` } as CSSProperties}>
      <div className="gauge2__arc">
        <div className="gauge2__arc-fill" />
      </div>
      <div className="gauge2__txt">
        <span>{label}</span>
        <b>{value}</b>
      </div>
    </div>
  );
}

function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  if (values.length < 2) {
    return <div className="sparkline2 sparkline2--empty" />;
  }
  const W = 140;
  const H = 56;
  const max = Math.max(1.0, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(0.001, max - min);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - ((v - min) / range) * H).toFixed(1)}`);
  const path = `M ${pts.join(' L ')}`;
  const area = `${path} L ${W},${H} L 0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`sparkline2 tone-${tone}`} preserveAspectRatio="none">
      <path d={area} className="sparkline2__area" />
      <path d={path} className="sparkline2__line" />
    </svg>
  );
}
