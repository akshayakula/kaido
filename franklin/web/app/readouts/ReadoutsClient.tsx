'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, DemoSession } from '@/lib/types';

const DEFAULT_SESSION_ID = 'default';

type StoreHealth = {
  configured: boolean;
  mode: 'upstash' | 'memory' | 'memory-fallback';
  ok: boolean;
  host: string | null;
  ping?: string;
  roundTrip?: boolean;
  activeSessions?: number;
  error?: string;
};

type ReadoutMode = 'conversation' | 'events' | 'json';

export function ReadoutsClient() {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [storeHealth, setStoreHealth] = useState<StoreHealth | null>(null);
  const [mode, setMode] = useState<ReadoutMode>('conversation');
  const [filter, setFilter] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 1000);
    return () => window.clearInterval(interval);
  }, []);

  async function refresh() {
    const [sessionResponse, healthResponse] = await Promise.all([
      fetch(`/api/sessions/${DEFAULT_SESSION_ID}/state`),
      fetch('/api/upstash/health'),
    ]);

    if (sessionResponse.ok) {
      const data = (await sessionResponse.json()) as { session: DemoSession };
      setSession(data.session);
    }

    if (healthResponse.ok || healthResponse.status === 503) {
      const data = (await healthResponse.json()) as StoreHealth;
      setStoreHealth(data);
    }

    setLastUpdated(Date.now());
  }

  const events = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = session?.events ?? [];
    if (!q) return all;
    return all.filter((event) =>
      [event.type, event.from, event.to, event.body].some((part) => part.toLowerCase().includes(q))
    );
  }, [filter, session]);

  const latestAi = session?.events.find((event) => event.type === 'AI_NEGOTIATION' || event.type === 'AI_FALLBACK');
  const deferredKw = session?.datacenters.reduce((sum, dc) => sum + (dc.gridAllocation?.deferredKw ?? 0), 0);

  return (
    <main className="shell readouts-shell">
      <header className="hero readouts-hero">
        <div>
          <p className="eyebrow">Agentic API readouts</p>
          <h1>Full negotiation stream</h1>
          <p className="hero-copy">Raw default-session events, agent messages, OpenDSS solves, Slurm actions, and backing store status.</p>
        </div>
        <div className="hero-actions">
          <a className="secondary-link" href="/dashboard">Dashboard</a>
          <a className="secondary-link" href="/join">Join</a>
        </div>
      </header>

      <section className="readout-status-grid">
        <ReadoutStat label="Session" value={session?.id ?? 'loading'} detail={session ? `${session.datacenters.length} data centers` : 'polling'} />
        <ReadoutStat label="Grid" value={session?.grid.health ?? 'waiting'} detail={session?.grid.solver ?? 'readout pending'} />
        <ReadoutStat label="Feeder" value={formatKw(session?.grid.feederKw)} detail="OpenDSS total load" />
        <ReadoutStat label="Transformer" value={formatRatio(session?.grid.transformerLoading)} detail="solved loading" />
        <ReadoutStat label="Deferred" value={formatKw(deferredKw)} detail="agent allocation" />
        <ReadoutStat label="Events" value={String(session?.events.length ?? 0)} detail={latestAi ? latestAi.type : 'no AI turn yet'} />
        <ReadoutStat label="Store" value={storeHealthLabel(storeHealth)} detail={storeHealth?.host ?? 'server-side only'} />
        <ReadoutStat label="Updated" value={lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'waiting'} detail="1s polling" />
      </section>

      <GridPhysicsReadout session={session} />

      <section className="panel readouts-console">
        <div className="readouts-toolbar">
          <div className="mode-tabs" role="tablist" aria-label="Readout mode">
            <button data-active={mode === 'conversation'} onClick={() => setMode('conversation')}>Conversation</button>
            <button data-active={mode === 'events'} onClick={() => setMode('events')}>Event API</button>
            <button data-active={mode === 'json'} onClick={() => setMode('json')}>Raw JSON</button>
          </div>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by agent, event type, or text"
            aria-label="Filter readouts"
          />
        </div>

        {mode === 'conversation' && <ConversationReadout events={events} />}
        {mode === 'events' && <EventApiReadout events={events} />}
        {mode === 'json' && <JsonReadout session={session} storeHealth={storeHealth} />}
      </section>
    </main>
  );
}

function GridPhysicsReadout({ session }: { session: DemoSession | null }) {
  const loads = session?.grid.datacenterLoads ?? [];
  const lines = session?.grid.lineLoadings ?? [];

  return (
    <section className="panel opendss-physics-panel">
      <div className="panel-head compact">
        <div>
          <p className="eyebrow">OpenDSS solved circuit</p>
          <h2>Load changes by joined data center</h2>
        </div>
        <span className="solver-badge">{session?.grid.solver === 'opendss' ? 'Live OpenDSS' : 'Approx fallback'}</span>
      </div>

      <div className="physics-grid">
        <div className="physics-table">
          <div className="physics-row physics-head">
            <span>Data center</span>
            <span>Bus</span>
            <span>Requested</span>
            <span>Allocated</span>
            <span>Deferred</span>
            <span>Branch</span>
          </div>
          {loads.length ? loads.map((load) => (
            <div className="physics-row" key={`${load.id ?? load.name}-${load.bus}`}>
              <span>{load.name}</span>
              <span>{load.bus}</span>
              <span>{formatKw(load.requestedKw ?? load.kw)}</span>
              <span>{formatKw(load.allocatedKw ?? load.kw)}</span>
              <span>{formatKw(load.deferredKw)}</span>
              <span>{load.lineLoading === undefined ? load.line : `${load.line} · ${Math.round(load.lineLoading * 100)}%`}</span>
            </div>
          )) : <div className="empty">Waiting for a solved data-center load.</div>}
        </div>

        <div className="line-loading-list">
          <p className="eyebrow">Feeder branches</p>
          {lines.slice(0, 8).map((line) => (
            <div className="line-loading-row" key={line.name}>
              <span>{line.name}</span>
              <b>{Math.round(line.loading * 100)}%</b>
              <small>{line.amps.toFixed(1)} A</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReadoutStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="readout-stat">
      <span>{label}</span>
      <b>{value}</b>
      <small>{detail}</small>
    </article>
  );
}

function ConversationReadout({ events }: { events: AgentEvent[] }) {
  if (!events.length) return <div className="empty">No matching agent events yet.</div>;

  return (
    <div className="readout-conversation">
      {events.map((event) => (
        <article className="readout-message" data-type={event.type} key={event.id}>
          <div className="readout-message-head">
            <b>{formatActor(event.from)}</b>
            <span>{event.type}</span>
            <time>{new Date(event.at).toLocaleTimeString()}</time>
          </div>
          <p>{event.body}</p>
          <small>{formatActor(event.from)} to {formatActor(event.to)} · event id {event.id}</small>
        </article>
      ))}
    </div>
  );
}

function EventApiReadout({ events }: { events: AgentEvent[] }) {
  if (!events.length) return <div className="empty">No matching event API entries yet.</div>;

  return (
    <div className="api-event-list">
      {events.map((event) => (
        <article className="api-event" key={event.id}>
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </article>
      ))}
    </div>
  );
}

function JsonReadout({ session, storeHealth }: { session: DemoSession | null; storeHealth: StoreHealth | null }) {
  return (
    <div className="json-grid">
      <article>
        <h2>GET /api/sessions/default/state</h2>
        <pre>{JSON.stringify({ session }, null, 2)}</pre>
      </article>
      <article>
        <h2>GET /api/upstash/health</h2>
        <pre>{JSON.stringify(storeHealth, null, 2)}</pre>
      </article>
    </div>
  );
}

function formatActor(actor: string) {
  const labels: Record<string, string> = {
    'grid-agent': 'Grid agent',
    'data-center-agents': 'All data centers',
    opendss: 'OpenDSS',
    slurm: 'Slurm scheduler',
    operator: 'Operator',
    'ai-agent': 'NIM agent',
    demo: 'Demo runtime',
  };
  return labels[actor] ?? actor;
}

function storeHealthLabel(health: StoreHealth | null) {
  if (!health) return 'checking';
  if (health.mode === 'upstash' && health.ok) return 'Upstash live';
  if (health.mode === 'memory-fallback') return 'Redis fallback';
  if (!health.configured) return 'memory only';
  return health.ok ? health.mode : 'store error';
}

function formatKw(value: number | undefined) {
  return typeof value === 'number' ? `${Math.round(value).toLocaleString()} kW` : 'waiting';
}

function formatRatio(value: number | undefined) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'waiting';
}
