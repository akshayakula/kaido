'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DeviceListItem, EventRow } from '@/lib/sensor-store';

const REFRESH_MS = 2000;     // poll Upstash every 2s — sensor1 publishes at 0.5 Hz

const STATE_TONE: Record<string, string> = {
  NORMAL: 'sensor-pill sensor-pill--normal',
  STRESSED: 'sensor-pill sensor-pill--stressed',
  EMERGENCY: 'sensor-pill sensor-pill--emergency',
  RECOVERING: 'sensor-pill sensor-pill--recovering',
  OFFLINE: 'sensor-pill sensor-pill--offline',
};

// The hardware sensor id in Upstash (live Pi). Everything else is synthetic.
const LIVE_DEVICE_ID = 'sensor1';

// Build "Franklin sensor N" labels from the actual Upstash device list, with
// the live hardware pinned to #1 and the rest numbered in stable id order.
function buildLabels(devices: { device: string }[]): Record<string, string> {
  const live = devices.filter(d => d.device === LIVE_DEVICE_ID).map(d => d.device);
  const rest = devices.filter(d => d.device !== LIVE_DEVICE_ID).map(d => d.device).sort();
  const out: Record<string, string> = {};
  [...live, ...rest].forEach((id, i) => { out[id] = `Franklin sensor ${i + 1}`; });
  return out;
}

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d);
const cToF = (c: number | null | undefined) =>
  c === null || c === undefined || Number.isNaN(c) ? null : c * 9 / 5 + 32;
// Δ°F = Δ°C × 9/5 (no offset for deltas / margins).
const dCToF = (c: number | null | undefined) =>
  c === null || c === undefined || Number.isNaN(c) ? null : c * 9 / 5;

// Overall sensor health 0-1. Heavily dominated by temperature — both
// drift from baseline and absolute operating range. Tiny amount of weight
// for humidity. Server health is ignored for the temp-sensitive variant
// so the number reacts immediately when temp moves.
//
// Drift falloff (Δ from baseline, °F):
//    ±0  → 1.00     ±1  → 0.97     ±2  → 0.89     ±3  → 0.75
//    ±4  → 0.56     ±5  → 0.31     ±6+ → 0.00
// Absolute-temp falloff: ideal 70-80 °F, hard zero by 50 / 100 °F.
// Overall sensor health 0-1. Temperature drift dominates; absolute temp
// band, humidity, and (optionally) microphone activity contribute.
//
// `tempSens` (1-10) shrinks the drift Δ°F that drives the score to zero.
// At sens=5 (default) zero is hit at ±6 °F drift. At sens=10, ±2 °F. At
// sens=1, ±18 °F.
//
// `micSens` (1-10) controls how much the live mic peak-to-peak voltage
// suppresses the score. At sens=1 the mic doesn't enter the score; at
// sens=10 a saturated mic pulls the score down by ~30%.
function overallHealth(
  tele: { temp_c?: number; humidity?: number; delta_c?: number; mic_pp_v?: number } | undefined,
  features: { temp_delta?: number } | undefined,
  _serverHealth: number | null | undefined,
  sens: Sensitivity = { temp: 5, mic: 5 },
): number | null {
  const tempC = tele?.temp_c;
  const hum   = tele?.humidity;
  const deltaC = tele?.delta_c ?? features?.temp_delta;
  const micV   = tele?.mic_pp_v;
  if (tempC === undefined && hum === undefined && deltaC === undefined) return null;

  const tempF = tempC === undefined ? null : tempC * 9 / 5 + 32;
  const deltaF = deltaC === undefined ? null : deltaC * 9 / 5;

  // Drift falloff scale shrinks with higher temp sensitivity.
  const driftScale = 36 / (sens.temp * sens.temp + 6); // sens=1→5.1, sens=5→1.16, sens=10→0.34 (multiplied below by 6)
  const k = 6 * driftScale; // °F at which drift score hits 0
  const driftScore = deltaF === null ? 1
    : Math.max(0, 1 - Math.pow(Math.abs(deltaF) / k, 2));

  const bandScore = tempF === null ? 1
    : tempF >= 70 && tempF <= 80 ? 1
    : Math.max(0, 1 - Math.abs(tempF - 75) / 12);
  const humScore = hum === undefined ? 1
    : hum >= 30 && hum <= 65 ? 1
    : Math.max(0, 1 - Math.abs(hum - 47.5) / 25);

  // Mic contribution: a per-sample peak-to-peak voltage above a sliding
  // threshold pulls the score down. Operator can dial weight 0..0.30.
  const micWeight = (sens.mic - 1) / 9 * 0.30; // sens=1→0, sens=10→0.30
  const micThreshold = 0.005 * (11 - sens.mic) / 6; // sens=1→0.0083, sens=10→0.0008
  const micExcess = micV === undefined ? 0
    : Math.max(0, Math.min(1, (micV - micThreshold) / (micThreshold * 4)));
  const micPenalty = micExcess * micWeight;

  // Temp drift dominates. Remaining weight covers band, humidity, mic penalty.
  const positive = driftScore * 0.65 + bandScore * 0.2 + humScore * 0.15;
  return Math.max(0, Math.min(1, positive - micPenalty));
}
const ts = (t: number) => new Date(t * 1000).toLocaleTimeString();
const healthColor = (h: number | null | undefined) =>
  h === null || h === undefined ? 'var(--muted)' :
  h > 0.85 ? 'var(--green)' : h > 0.55 ? 'var(--yellow)' : 'var(--red)';

import { ChatterWaveform } from '@/components/ChatterWaveform';
import {
  SensitivityControls,
  loadSensitivity,
  saveSensitivity,
  micThresholds,
  tempThresholdC,
  DEFAULT_SENSITIVITY,
  type Sensitivity,
} from '@/components/SensitivityControls';

// MockWaveform now renders a real waveform sampled from chatter.mp3, windowed
// per device id so each card looks different.
function MockWaveform({ seed, live }: { seed: string; live: boolean }) {
  return <ChatterWaveform seed={seed} live={live} />;
}

function RecalibratePanel({
  device,
  sensitivity,
  onSensitivityChange,
}: {
  device: string;
  sensitivity: Sensitivity;
  onSensitivityChange: (s: Sensitivity) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'queued' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    setState('sending'); setErr(null);
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(device)}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'recalibrate',
          duration: 6,
          ...micThresholds(sensitivity.mic),
          temp_threshold_c: tempThresholdC(sensitivity.temp),
        }),
      });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      saveSensitivity(device, sensitivity);
      setState('queued');
      setTimeout(() => { setState('idle'); setOpen(false); }, 1800);
    } catch (e) {
      setErr(String(e));
      setState('error');
      setTimeout(() => setState('idle'), 4000);
    }
  }

  const triggerLabel = state === 'sending' ? 'Sending…'
    : state === 'queued' ? '✓ Recalibrating'
    : state === 'error' ? 'Failed · retry'
    : open ? 'Cancel' : 'Recalibrate';

  return (
    <div className="recal">
      <button
        type="button"
        className={`sensor-audio__btn sensor-audio__btn--alt sensor-audio__btn--${state}`}
        onClick={() => {
          if (state === 'sending' || state === 'queued') return;
          setOpen(v => !v);
        }}
        disabled={state === 'sending' || state === 'queued'}
        title={err ?? 'Reset temp baseline + push sensitivity to the Pi'}
      >
        {triggerLabel}
      </button>
      {open && (
        <div className="recal__panel">
          <SensitivityControls value={sensitivity} onChange={onSensitivityChange} />
          <div className="recal__actions">
            <button
              type="button"
              className="sensor-audio__btn sensor-audio__btn--alt"
              onClick={() => setOpen(false)}
              disabled={state === 'sending'}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sensor-audio__btn sensor-audio__btn--alt sensor-audio__btn--primary"
              onClick={confirm}
              disabled={state === 'sending'}
            >
              {state === 'sending' ? 'Sending…' : 'Confirm recalibration'}
            </button>
          </div>
          {err && <div className="recal__err">{err}</div>}
        </div>
      )}
    </div>
  );
}

function ageString(seconds: number): { label: string; tone: 'live' | 'fresh' | 'stale' | 'cold' } {
  if (seconds < 5)   return { label: `${seconds.toFixed(0)}s ago`, tone: 'live' };
  if (seconds < 30)  return { label: `${seconds.toFixed(0)}s ago`, tone: 'fresh' };
  if (seconds < 120) return { label: `${seconds.toFixed(0)}s ago`, tone: 'stale' };
  if (seconds < 3600) return { label: `${Math.round(seconds / 60)} min ago`, tone: 'cold' };
  return { label: `${Math.round(seconds / 3600)} h ago`, tone: 'cold' };
}

export default function GridSensorClient() {
  const [devices, setDevices] = useState<DeviceListItem[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sens, setSens] = useState<Record<string, Sensitivity>>({});

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [d, e] = await Promise.all([
          fetch('/api/devices').then(r => r.json()),
          fetch('/api/events?limit=60').then(r => r.json()),
        ]);
        if (!alive) return;
        setDevices(d); setEvents(e); setError(null);
        setLastFetched(Date.now());
      } catch (err) {
        if (alive) setError(String(err));
      }
    };
    refresh();
    const pollId = setInterval(refresh, REFRESH_MS);
    // Tick a separate clock every 500ms so the "Xs ago" label updates
    // smoothly without re-fetching from Upstash.
    const tickId = setInterval(() => setNow(Date.now()), 500);
    return () => { alive = false; clearInterval(pollId); clearInterval(tickId); };
  }, []);

  const fleetSummary = useMemo(() => {
    const byState: Record<string, number> = {};
    for (const d of devices) byState[d.state] = (byState[d.state] || 0) + 1;
    return byState;
  }, [devices]);

  // Pin the live hardware sensor (sensor1) to the leftmost position; keep the
  // rest in stable id order.
  const orderedDevices = useMemo(() => {
    const pinned = devices.filter(d => d.device === LIVE_DEVICE_ID);
    const rest = devices.filter(d => d.device !== LIVE_DEVICE_ID).slice().sort((a, b) => a.device.localeCompare(b.device));
    return [...pinned, ...rest];
  }, [devices]);

  const labels = useMemo(() => buildLabels(orderedDevices), [orderedDevices]);
  const labelFor = (id: string) => labels[id] ?? id;

  const fetchedAge = lastFetched ? Math.max(0, (now - lastFetched) / 1000) : null;

  return (
    <main className="sensor-screen">
      <header className="sensor-topbar">
        <div>
          <span className="sensor-eyebrow">FRANKLIN SENSORS</span>
          <h1>Field telemetry &amp; transformer health</h1>
          <p>
            Live fusion of <strong>thermal</strong>, <strong>acoustic</strong>, and{' '}
            <strong>humidity</strong> signals from edge sensors. Polling every {REFRESH_MS / 1000}s.
            {fetchedAge !== null && (
              <>
                {' '}
                Last fetch <strong className={fetchedAge < 3 ? 'sensor-fresh-live' : 'sensor-fresh-stale'}>
                  {fetchedAge.toFixed(1)}s ago
                </strong>.
              </>
            )}
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
        <h2>Devices · {devices.length}{' '}
          <span className="sensor-section__hint">
            {Object.entries(fleetSummary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}
          </span>
        </h2>
        <div className="sensor-grid sensor-grid--devices">
          {orderedDevices.length === 0 && <div className="sensor-empty">No devices yet · seed mock data with <code>python -m fusion.mock seed</code></div>}
          {orderedDevices.map(d => {
            const tele = d.latest_telemetry || {} as Partial<DeviceListItem['latest_telemetry']>;
            const f = d.features || {};
            const ds = sens[d.device] ?? loadSensitivity(d.device);
            const overall = overallHealth(
              tele as { temp_c?: number; humidity?: number; delta_c?: number; mic_pp_v?: number },
              f as { temp_delta?: number },
              d.health,
              ds,
            );
            const overallC = healthColor(overall);
            const teleTs = (tele as any)?.ts as number | undefined;
            const ageS = teleTs ? Math.max(0, now / 1000 - teleTs) : null;
            const age = ageS !== null ? ageString(ageS) : null;
            const isLive = d.device === LIVE_DEVICE_ID || (d.profile && d.profile !== 'unknown' && d.profile !== 'healthy' && d.profile !== 'stressed' && d.profile !== 'failing');
            return (
              <article key={d.device} className={`sensor-card sensor-card--device sensor-state-${d.state}${age ? ' freshness-' + age.tone : ''}${d.device === LIVE_DEVICE_ID && ageS !== null && ageS < 1800 ? ' sensor-card--live' : ''}`}>
                <header>
                  <div>
                    <div className="sensor-card__title">
                      {labelFor(d.device)}
                      {d.device === LIVE_DEVICE_ID && ageS !== null && ageS < 1800 && <span className="sensor-card__live-badge">LIVE</span>}
                    </div>
                    <div className="sensor-card__sub">
                      <code>{d.device}</code> · {d.zone ?? '—'} · {d.profile ?? '—'}
                    </div>
                  </div>
                  <span className={STATE_TONE[d.state] || 'sensor-pill'}>{d.state}</span>
                </header>

                {age && (
                  <div className={`sensor-freshness sensor-freshness--${age.tone}`}>
                    <span className="sensor-freshness__dot" aria-hidden="true" />
                    <span>updated {age.label}</span>
                    {teleTs && <span className="sensor-freshness__time">{ts(teleTs)}</span>}
                  </div>
                )}

                <div className="sensor-overall">
                  <div className="sensor-overall__label">Overall health</div>
                  <div className="sensor-overall__row">
                    <div className="sensor-overall__score" style={{ color: overallC }}>
                      {overall === null ? '—' : Math.round(overall * 100)}
                      <span className="sensor-overall__unit">/100</span>
                    </div>
                    <div className="sensor-bar sensor-bar--lg sensor-overall__bar">
                      <div className="sensor-bar__fill" style={{ background: overallC, width: `${(overall ?? 0) * 100}%` }} />
                    </div>
                  </div>
                </div>

                {(d.flags?.length ?? 0) > 0 && (
                  <div className="sensor-flags">
                    {d.flags.map(flag => <span key={flag} className="sensor-flag">{flag}</span>)}
                  </div>
                )}

                <dl className="sensor-telemetry">
                  <div><dt>temp</dt><dd>{fmt(cToF((tele as any)?.temp_c), 1)} °F <em>(Δ {fmt(dCToF((f as any).temp_delta), 1)})</em></dd></div>
                  <div><dt>humidity</dt><dd>{fmt((tele as any)?.humidity, 1)}% <em>(dew Δ {fmt(dCToF((f as any).dew_point_margin), 1)} °F)</em></dd></div>
                </dl>

                <div className="sensor-audio">
                  <MockWaveform seed={d.device} live={d.device === LIVE_DEVICE_ID && ageS !== null && ageS < 1800} />
                  <div className="sensor-audio__actions">
                    <a
                      className="sensor-audio__btn"
                      href={`/viewer/?device=${encodeURIComponent(d.device)}`}
                    >
                      Audio analysis ↗
                    </a>
                    <RecalibratePanel
                      device={d.device}
                      sensitivity={ds}
                      onSensitivityChange={(s) => setSens(prev => ({ ...prev, [d.device]: s }))}
                    />
                  </div>
                </div>
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
