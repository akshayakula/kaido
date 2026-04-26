'use client';

import { useEffect, useState } from 'react';
import type { DomLoadSample, FuelMixSample } from '@/lib/gridstatus';

const REFRESH_MS = 60_000;

type FuelEntry = { fuel: string; mw: number };

function topFuels(sample: FuelMixSample | null, count = 5): FuelEntry[] {
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
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const FUEL_COLORS: Record<string, string> = {
  gas:        '#f2d36b',
  natural_gas:'#f2d36b',
  nuclear:    '#78a8e6',
  coal:       '#a47356',
  oil:        '#c97a5b',
  hydro:      '#5fc4d3',
  wind:       '#7fd99c',
  solar:      '#f5b454',
  storage:    '#b4a0dc',
  other:      '#9aa090',
  multiple_fuels: '#9aa090',
};

function fuelColor(name: string): string {
  const k = name.toLowerCase();
  return FUEL_COLORS[k] ?? '#9aa090';
}

export function PjmPanel() {
  const [dom, setDom] = useState<DomLoadSample | null>(null);
  const [mix, setMix] = useState<FuelMixSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [dRes, fRes] = await Promise.all([
          fetch('/api/grid/dom-load'),
          fetch('/api/grid/fuel-mix'),
        ]);
        const d = await dRes.json().catch(() => ({}));
        const f = await fRes.json().catch(() => ({}));
        if (!alive) return;
        if (!dRes.ok && !fRes.ok) {
          setError(d?.error || f?.error || 'gridstatus.io unreachable');
        } else {
          setError(null);
        }
        setDom(d?.sample ?? null);
        setMix(f?.sample ?? null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };
    refresh();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const fuels = topFuels(mix);
  const totalMw = fuels.reduce((s, f) => s + f.mw, 0);

  if (loading && !dom && !mix && !error) {
    return <div className="pjm2__empty">connecting to gridstatus.io…</div>;
  }

  return (
    <div className="pjm2">
      <div className="pjm2__hero">
        <div className="pjm2__hero-block">
          <span className="pjm2__lbl">DOM zone load</span>
          <b className="pjm2__val">{dom ? fmtMw(dom.mw) : '—'}</b>
          <small>{ageLabel(dom?.interval_start_utc)} · {dom?.is_verified ? 'verified' : 'preliminary'}</small>
        </div>
        <div className="pjm2__hero-block">
          <span className="pjm2__lbl">PJM total</span>
          <b className="pjm2__val">{totalMw ? fmtMw(totalMw) : '—'}</b>
          <small>{ageLabel(mix?.time_utc as string | undefined)} · fuel-mix</small>
        </div>
      </div>

      {fuels.length > 0 ? (
        <>
          <div className="pjm2__stack">
            {fuels.map((f) => {
              const pct = totalMw > 0 ? (f.mw / totalMw) * 100 : 0;
              return (
                <span
                  key={f.fuel}
                  className="pjm2__stack-seg"
                  style={{ width: `${pct}%`, background: fuelColor(f.fuel) }}
                  title={`${f.fuel}: ${fmtMw(f.mw)} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <ul className="pjm2__fuels">
            {fuels.map((f) => {
              const pct = totalMw > 0 ? (f.mw / totalMw) * 100 : 0;
              return (
                <li key={f.fuel}>
                  <span className="pjm2__swatch" style={{ background: fuelColor(f.fuel) }} aria-hidden="true" />
                  <span className="pjm2__fname">{f.fuel.replace(/_/g, ' ')}</span>
                  <span className="pjm2__fmw">{fmtMw(f.mw)}</span>
                  <span className="pjm2__fpct">{pct.toFixed(0)}%</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : !error ? (
        <div className="pjm2__empty">no fuel-mix samples available</div>
      ) : null}

      {error && (
        <div className="pjm2__error">
          <b>gridstatus.io</b>
          <small>{error}</small>
          <small className="pjm2__hint">set GRIDSTATUS_API_KEY_1 in your env</small>
        </div>
      )}
    </div>
  );
}
