'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DeviceListItem, EventRow, ZoneScore } from '@/lib/sensor-store';

const REFRESH_MS = 5000;

const STATE_TONE: Record<string, string> = {
  NORMAL: 'sensor-pill sensor-pill--normal',
  STRESSED: 'sensor-pill sensor-pill--stressed',
  EMERGENCY: 'sensor-pill sensor-pill--emergency',
  RECOVERING: 'sensor-pill sensor-pill--recovering',
  OFFLINE: 'sensor-pill sensor-pill--offline',
};

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d);
const ts = (t: number) => new Date(t * 1000).toLocaleTimeString();
const healthColor = (h: number | null | undefined) =>
  h === null || h === undefined ? 'var(--muted)' :
  h > 0.85 ? 'var(--green)' : h > 0.55 ? 'var(--yellow)' : 'var(--red)';

export default function GridSensorClient() {
  const [devices, setDevices] = useState<DeviceListItem[]>([]);
  const [zones, setZones] = useState<Record<string, ZoneScore>>({});
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [d, z, e] = await Promise.all([
          fetch('/api/devices').then(r => r.json()),
          fetch('/api/zones').then(r => r.json()),
          fetch('/api/events?limit=60').then(r => r.json()),
        ]);
        if (!alive) return;
        setDevices(d); setZones(z); setEvents(e); setError(null);
      } catch (err) {
        if (alive) setError(String(err));
      }
    };
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const fleetSummary = useMemo(() => {
    const byState: Record<string, number> = {};
    for (const d of devices) byState[d.state] = (byState[d.state] || 0) + 1;
    return byState;
  }, [devices]);

  return (
    <main className="sensor-screen">
      <header className="sensor-topbar">
        <div>
          <span className="sensor-eyebrow">FRANKLIN · GRID SENSOR</span>
          <h1>Field telemetry &amp; transformer health</h1>
          <p>
            Live fusion of <strong>thermal</strong>, <strong>acoustic</strong>, and{' '}
            <strong>humidity</strong> signals from edge sensors. Health and state are
            scored every 30 s by the fusion runner; this view auto-refreshes every {REFRESH_MS / 1000}s.
          </p>
        </div>
        <nav className="sensor-nav">
          <a href="/">home</a>
          <a href="/dashboard">grid management</a>
          <a href="/viewer/" target="_blank" rel="noreferrer">audio analysis ↗</a>
        </nav>
      </header>

      {error && <div className="sensor-error">connection error · {error}</div>}

      <section className="sensor-section">
        <h2>Zones</h2>
        <div className="sensor-grid sensor-grid--zones">
          {Object.entries(zones).length === 0 && <div className="sensor-empty">No zones yet · run <code>fusion.runner</code></div>}
          {Object.entries(zones).map(([name, z]) => {
            const r = z.zone_resilience;
            const c = healthColor(r);
            return (
              <article key={name} className="sensor-card sensor-card--zone">
                <header>
                  <span className="sensor-card__title">ZONE {name}</span>
                  <span className="sensor-card__count">{z.device_count} devices</span>
                </header>
                <div className="sensor-card__big" style={{ color: c }}>{fmt(r)}</div>
                <div className="sensor-card__lbl">resilience</div>
                <div className="sensor-bar">
                  <div className="sensor-bar__fill" style={{ background: c, width: `${(r ?? 0) * 100}%` }} />
                </div>
                <dl>
                  <div><dt>min health</dt><dd>{fmt(z.min_health)}</dd></div>
                  <div><dt>mean health</dt><dd>{fmt(z.mean_health)}</dd></div>
                  <div><dt>emergency</dt><dd>{(z.emergency_fraction * 100).toFixed(0)}%</dd></div>
                  <div><dt>txns/hr</dt><dd>{fmt(z.transitions_per_hour, 2)}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className="sensor-section">
        <h2>Devices · {devices.length}{' '}
          <span className="sensor-section__hint">
            {Object.entries(fleetSummary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}
          </span>
        </h2>
        <div className="sensor-grid sensor-grid--devices">
          {devices.length === 0 && <div className="sensor-empty">No devices yet · seed mock data with <code>python -m fusion.mock seed</code></div>}
          {devices.map(d => {
            const c = healthColor(d.health);
            const tele = d.latest_telemetry || {} as Partial<DeviceListItem['latest_telemetry']>;
            const f = d.features || {};
            const comps = d.components || { thermal: 0, audio: 0, humidity: 0, joint: 0, stability: 0 };
            return (
              <article key={d.device} className={`sensor-card sensor-card--device sensor-state-${d.state}`}>
                <header>
                  <div>
                    <div className="sensor-card__title">{d.device}</div>
                    <div className="sensor-card__sub">{d.zone ?? '—'} · {d.profile ?? '—'}</div>
                  </div>
                  <span className={STATE_TONE[d.state] || 'sensor-pill'}>{d.state}</span>
                </header>

                <div className="sensor-bar sensor-bar--lg">
                  <div className="sensor-bar__fill" style={{ background: c, width: `${(d.health ?? 0) * 100}%` }} />
                </div>
                <div className="sensor-card__lbl sensor-card__lbl--inline">
                  <span>health</span><strong style={{ color: c }}>{fmt(d.health)}</strong>
                </div>

                <div className="sensor-components">
                  {(['thermal', 'audio', 'humidity', 'joint', 'stability'] as const).map(k => (
                    <div key={k} className={`sensor-component sensor-component--${k}`}>
                      <div className="sensor-component__name">{k}</div>
                      <div className="sensor-component__val">{fmt(comps[k])}</div>
                    </div>
                  ))}
                </div>

                {(d.flags?.length ?? 0) > 0 && (
                  <div className="sensor-flags">
                    {d.flags.map(flag => <span key={flag} className="sensor-flag">{flag}</span>)}
                  </div>
                )}

                <dl className="sensor-telemetry">
                  <div><dt>temp</dt><dd>{fmt((tele as any)?.temp_c, 1)} °C <em>(Δ {fmt((f as any).temp_delta, 1)})</em></dd></div>
                  <div><dt>humidity</dt><dd>{fmt((tele as any)?.humidity, 1)}% <em>(dew Δ {fmt((f as any).dew_point_margin, 1)})</em></dd></div>
                  <div><dt>pop rate</dt><dd>{fmt((f as any).pop_rate, 2)} /s</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className="sensor-section">
        <h2>Recent events</h2>
        <div className="sensor-events">
          {events.length === 0 ? <div className="sensor-empty">No events</div> : (
            <table>
              <thead>
                <tr><th>time</th><th>device</th><th>kind</th><th>from → to</th><th>flags</th></tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.ts}-${i}`}>
                    <td>{ts(e.ts)}</td>
                    <td>{e.device}</td>
                    <td>{e.kind}</td>
                    <td>
                      <span className="sensor-pill sensor-pill--small">{e.from || '—'}</span>
                      <span className="sensor-arrow">→</span>
                      <span className={`${STATE_TONE[e.to ?? ''] || 'sensor-pill'} sensor-pill--small`}>{e.to || '—'}</span>
                    </td>
                    <td>{(e.flags ?? []).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
