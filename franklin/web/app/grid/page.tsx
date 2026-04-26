'use client';

import { useEffect, useState } from 'react';
import { OpenDssPanel } from '@/components/dash/OpenDssPanel';
import { PjmPanel } from '@/components/dash/PjmPanel';
import type { DemoSession } from '@/lib/types';

const DEFAULT_SESSION_ID = 'default';

export default function GridDeepDivePage() {
  const [session, setSession] = useState<DemoSession | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const r = await fetch(`/api/sessions/${DEFAULT_SESSION_ID}/state`);
        if (!r.ok) return;
        const data = (await r.json()) as { session: DemoSession };
        if (alive) setSession(data.session);
      } catch { /* ignore */ }
    };
    refresh();
    const tickId = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/sessions/${DEFAULT_SESSION_ID}/tick`, { method: 'POST' });
        if (!r.ok) return;
        const data = (await r.json()) as { session: DemoSession };
        if (alive) setSession(data.session);
      } catch { /* ignore */ }
    }, 2000);
    return () => { alive = false; window.clearInterval(tickId); };
  }, []);

  return (
    <main className="grid-deep">
      <header className="grid-deep__head">
        <a className="grid-deep__brand" href="/" aria-label="Franklin home">FRANKLIN</a>
        <span className="grid-deep__crumb">/ grid</span>
        <div className="grid-deep__nav">
          <a className="grid-deep__link" href="/dashboard">← Dashboard</a>
          <a className="grid-deep__link" href="/grid-sensor">Sensors</a>
          <a className="grid-deep__link grid-deep__link--accent" href="/join">Join →</a>
        </div>
      </header>

      <section className="grid-deep__hero">
        <div className="grid-deep__hero-tag">PJM Interconnection · DOM zone · Northern Virginia</div>
        <h1>Live grid, end&#8209;to&#8209;end.</h1>
        <p>
          Real‑time wholesale electricity load and fuel mix from <a href="https://gridstatus.io" target="_blank" rel="noreferrer">gridstatus.io</a>,
          paired with the OpenDSS feeder solving every tick under your data centers&apos; demand.
        </p>
      </section>

      <section className="grid-deep__split">
        <article className="grid-deep__card grid-deep__card--pjm">
          <header>
            <p className="eyebrow">ISO source · gridstatus.io</p>
            <h2>PJM live</h2>
          </header>
          <PjmPanel />
        </article>

        <article className="grid-deep__card grid-deep__card--dss">
          <header>
            <p className="eyebrow">OpenDSS · single‑line</p>
            <h2>Feeder flow chart</h2>
          </header>
          <OpenDssPanel session={session} />
          <footer className="grid-deep__dss-foot">
            <span>{session?.datacenters.length ?? 0} data centers</span>
            <span>·</span>
            <span>{session?.scenario ?? '—'}</span>
            <span>·</span>
            <span>{session?.grid.solver === 'opendss' ? 'live OpenDSS' : 'approx fallback'}</span>
          </footer>
        </article>
      </section>

      <section className="grid-deep__notes">
        <h3>Why this matters</h3>
        <div className="grid-deep__notes-grid">
          <div>
            <b>PJM</b>
            <p>Wholesale market operator covering 13 states + DC. The DOM zone is Dominion Energy&apos;s service territory in Virginia — where every Ashburn data center connects.</p>
          </div>
          <div>
            <b>DOM zone load</b>
            <p>Hourly verified consumption. Reflects the entire territory, not just data centers — but data‑center load is now the fastest‑growing slice.</p>
          </div>
          <div>
            <b>Fuel mix</b>
            <p>What&apos;s actually generating right now: gas, nuclear, coal, hydro, wind, solar, storage. Gas + nuclear typically dominate PJM in the base load.</p>
          </div>
          <div>
            <b>OpenDSS</b>
            <p>EPRI&apos;s open‑source distribution solver. We synthesize a feeder per session, drop in your data‑center loads, and solve it every tick to surface voltage and feeder loading.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
