'use client';

import { useEffect, useState } from 'react';
import type { DeviceListItem } from '@/lib/sensor-store';
import { ChatterWaveform } from '@/components/ChatterWaveform';

function MockWaveform({ seed, live }: { seed: string; live: boolean }) {
  return <ChatterWaveform seed={seed} live={live} />;
}

const REFRESH_MS = 2000;
const LIVE_WINDOW_S = 1800;
const LIVE_DEVICE_ID = 'sensor1';
const LIVE_DEVICE_LABEL = 'Franklin sensor 1';

const STATE_TONE: Record<string, string> = {
  NORMAL: 'sensor-pill sensor-pill--normal',
  STRESSED: 'sensor-pill sensor-pill--stressed',
  EMERGENCY: 'sensor-pill sensor-pill--emergency',
  RECOVERING: 'sensor-pill sensor-pill--recovering',
  OFFLINE: 'sensor-pill sensor-pill--offline',
};

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d);
const cToF = (c: number | null | undefined) =>
  c === null || c === undefined || Number.isNaN(c) ? null : c * 9 / 5 + 32;

// Same temp-sensitive scoring as the grid-sensor cards: drift from baseline
// dominates (Δ°F squared falloff), absolute band is secondary, humidity small.
function overallHealth(
  tempC: number | undefined,
  hum: number | undefined,
  deltaC: number | undefined,
): number | null {
  if (tempC === undefined && hum === undefined && deltaC === undefined) return null;
  const tempF = tempC === undefined ? null : tempC * 9 / 5 + 32;
  const deltaF = deltaC === undefined ? null : deltaC * 9 / 5;
  const driftScore = deltaF === null ? 1 : Math.max(0, 1 - Math.pow(Math.abs(deltaF) / 6, 2));
  const bandScore  = tempF === null ? 1 : tempF >= 70 && tempF <= 80 ? 1 : Math.max(0, 1 - Math.abs(tempF - 75) / 12);
  const humScore   = hum === undefined ? 1 : hum >= 30 && hum <= 65 ? 1 : Math.max(0, 1 - Math.abs(hum - 47.5) / 25);
  const computed = driftScore * 0.7 + bandScore * 0.2 + humScore * 0.1;
  return Math.max(0, Math.min(1, computed));
}
const ts = (t: number) => new Date(t * 1000).toLocaleTimeString();
const healthColor = (h: number | null | undefined) =>
  h === null || h === undefined ? 'var(--muted)' :
  h > 0.85 ? 'var(--green)' : h > 0.55 ? 'var(--yellow)' : 'var(--red)';

export function FranklinLiveSensor() {
  const [device, setDevice] = useState<DeviceListItem | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const list: DeviceListItem[] = await fetch('/api/devices').then(r => r.json());
        if (!alive) return;
        const d = list.find(x => x.device === LIVE_DEVICE_ID) ?? null;
        setDevice(d);
      } catch {
        /* ignore */
      }
    };
    refresh();
    const pollId = setInterval(refresh, REFRESH_MS);
    const tickId = setInterval(() => setNow(Date.now()), 500);
    return () => { alive = false; clearInterval(pollId); clearInterval(tickId); };
  }, []);

  if (!device) {
    return (
      <section className="franklin-live-panel sensor-empty">
        Waiting for {LIVE_DEVICE_LABEL}…
      </section>
    );
  }

  const tele = (device.latest_telemetry ?? {}) as Record<string, number | undefined>;
  const teleTs = tele.ts;
  const ageS = teleTs ? Math.max(0, now / 1000 - teleTs) : null;
  const isLive = ageS !== null && ageS < LIVE_WINDOW_S;
  const overall = overallHealth(tele.temp_c, tele.humidity, tele.delta_c);
  const overallC = healthColor(overall);

  return (
    <section
      className={`franklin-live-panel sensor-card sensor-card--device sensor-state-${device.state}${isLive ? ' sensor-card--live' : ''}`}
    >
      <header>
        <div>
          <div className="sensor-card__title">
            {LIVE_DEVICE_LABEL}
            {isLive && <span className="sensor-card__live-badge">LIVE</span>}
          </div>
          <div className="sensor-card__sub">
            <code>{device.device}</code> · {device.zone ?? '—'}
          </div>
        </div>
        <span className={STATE_TONE[device.state] || 'sensor-pill'}>{device.state}</span>
      </header>

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

      <dl className="sensor-telemetry">
        <div><dt>temp</dt><dd>{fmt(cToF(tele.temp_c), 1)} °F</dd></div>
        <div><dt>humidity</dt><dd>{fmt(tele.humidity, 1)}%</dd></div>
        {teleTs && <div><dt>updated</dt><dd>{ts(teleTs)}</dd></div>}
      </dl>

      <div className="sensor-audio">
        <MockWaveform seed={device.device} live={isLive} />
        <a
          className="sensor-audio__btn"
          href={`/viewer/?device=${encodeURIComponent(device.device)}`}
        >
          Audio analysis ↗
        </a>
      </div>
    </section>
  );
}
