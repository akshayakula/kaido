'use client';

import { useEffect, useState } from 'react';
import type { DomLoadSample, FuelMixSample } from '@/lib/gridstatus';

const REFRESH_MS = 60_000;

type FuelEntry = { fuel: string; mw: number };

function topFuels(sample: FuelMixSample | null, count = 4): FuelEntry[] {
  if (!sample) return [];
  const entries: FuelEntry[] = [];
  for (const [k, v] of Object.entries(sample)) {
    if (k === 'time_utc' || k === 'interval_start_utc' || k === 'interval_end_utc') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    entries.push({ fuel: k, mw: v });
  }
  entries.sort((a, b) => b.mw - a.mw);
  return entries.slice(0, count);
}

function fmtMw(mw: number): string {
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function ageLabel(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function PjmStatus() {
  const [dom, setDom] = useState<DomLoadSample | null>(null);
  const [mix, setMix] = useState<FuelMixSample | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [d, f] = await Promise.all([
          fetch('/api/grid/dom-load').then((r) => r.json()),
          fetch('/api/grid/fuel-mix').then((r) => r.json()),
        ]);
        if (!alive) return;
        setDom(d?.sample ?? null);
        setMix(f?.sample ?? null);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(String(err));
      }
    };
    refresh();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const fuels = topFuels(mix);
  const totalMw = fuels.reduce((s, f) => s + f.mw, 0);

  return (
    <section className="panel pjm-panel">
      <div className="panel-head compact">
        <div>
          <p className="eyebrow">ISO · Virginia</p>
          <h2>PJM Interconnection</h2>
        </div>
        <span className="solver-badge">gridstatus.io</span>
      </div>
      <div className="readout-grid">
        <div className="metric">
          <span>DOM zone load</span>
          <b>{dom ? fmtMw(dom.mw) : '—'}</b>
        </div>
        <div className="metric">
          <span>DOM updated</span>
          <b>{ageLabel(dom?.interval_start_utc)}</b>
        </div>
        <div className="metric">
          <span>Fuel mix total</span>
          <b>{totalMw ? fmtMw(totalMw) : '—'}</b>
        </div>
        <div className="metric">
          <span>Fuel mix updated</span>
          <b>{ageLabel(mix?.time_utc as string | undefined)}</b>
        </div>
      </div>
      {fuels.length > 0 && (
        <ul className="pjm-fuels">
          {fuels.map((f) => {
            const pct = totalMw > 0 ? (f.mw / totalMw) * 100 : 0;
            return (
              <li key={f.fuel}>
                <div className="pjm-fuels__row">
                  <span>{f.fuel.replace(/_/g, ' ')}</span>
                  <b>{fmtMw(f.mw)} · {pct.toFixed(0)}%</b>
                </div>
                <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <small className="pjm-error">PJM data unavailable: {error}</small>}
    </section>
  );
}
