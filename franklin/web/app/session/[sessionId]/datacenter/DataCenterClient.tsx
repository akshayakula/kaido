'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import type { DataCenterAgent, DemoSession, RequestType } from '@/lib/types';
import { clearJoinIdentity, loadJoinIdentity, saveJoinIdentity } from '@/lib/joinIdentity';

const requests: { type: RequestType; label: string; detail: string }[] = [
  { type: 'standard_inference', label: 'Standard inference', detail: 'Normal chat traffic' },
  { type: 'priority_inference', label: 'Priority inference', detail: 'Higher urgency request' },
  { type: 'batch_inference', label: 'Batch inference', detail: 'Large flexible queue' },
  { type: 'urgent_burst', label: 'Urgent burst', detail: 'Sudden GPU spike' },
];

export function DataCenterClient() {
  const params = useParams<{ sessionId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<DemoSession | null>(null);
  const [busy, setBusy] = useState<RequestType | null>(null);
  const [chatMessage, setChatMessage] = useState('');
  const [datacenterId, setDatacenterId] = useState<string>(search.get('dc') ?? '');
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectInFlight = useRef(false);
  // Source of truth for "the id we currently belong to" — updates synchronously
  // so a stale interval tick doesn't trigger a second reconnect after the first.
  const liveDcId = useRef(datacenterId);
  useEffect(() => { liveDcId.current = datacenterId; }, [datacenterId]);

  useEffect(() => {
    if (params.sessionId && datacenterId) {
      saveJoinIdentity(params.sessionId, datacenterId);
    }
    // Hydrate from local snapshot (localStorage outlives the tab; sessionStorage
    // is the legacy backup written by older joins).
    const localKey = `joined:${params.sessionId}:${datacenterId}`;
    const cached =
      window.localStorage.getItem(localKey) ??
      window.sessionStorage.getItem(localKey);
    if (cached) {
      try {
        setSession(JSON.parse(cached) as DemoSession);
      } catch {
        window.localStorage.removeItem(localKey);
        window.sessionStorage.removeItem(localKey);
      }
    }
    const interval = window.setInterval(refresh, 1000);
    refresh();
    return () => window.clearInterval(interval);
  }, [datacenterId, params.sessionId]);

  // Persist a fresh snapshot whenever the live session changes so that a
  // refresh shows our DC immediately, before the next poll lands.
  useEffect(() => {
    if (!session || !datacenterId) return;
    try {
      window.localStorage.setItem(
        `joined:${params.sessionId}:${datacenterId}`,
        JSON.stringify(session),
      );
    } catch { /* quota — ignore */ }
  }, [session, datacenterId, params.sessionId]);

  function leaveSession() {
    if (params.sessionId && datacenterId) {
      clearJoinIdentity(params.sessionId);
      try {
        window.localStorage.removeItem(`joined:${params.sessionId}:${datacenterId}`);
        window.sessionStorage.removeItem(`joined:${params.sessionId}:${datacenterId}`);
      } catch { /* ignore */ }
    }
    router.push('/join');
  }

  const liveDc = useMemo<DataCenterAgent | undefined>(
    () => session?.datacenters.find((dc) => dc.id === datacenterId),
    [datacenterId, session]
  );
  // Fallback stub used while the DC isn't yet in the session view (or has been
  // removed upstream but the user still has the URL). Lets the participant UI
  // render and POST updates without showing a "not found" wall.
  const datacenter: DataCenterAgent | undefined = useMemo(() => {
    if (liveDc) return liveDc;
    if (!datacenterId) return undefined;
    const saved = loadJoinIdentity(params.sessionId);
    // Pull the most recent broadcast from the grid agent so the status card
    // reflects the actual feeder posture, not a placeholder string.
    const latestBroadcast = session?.events.find(
      (e) =>
        (e.from === 'grid-agent' && (e.to === 'data-center-agents' || e.type === 'POWER_FLOW_RESULT')) ||
        e.type === 'REQUEST_RELIEF',
    );
    const fallbackInstruction = latestBroadcast?.body
      ?? (session?.grid.health === 'emergency'
        ? 'Grid emergency — broadcast pending.'
        : session?.grid.health === 'stressed'
          ? 'Grid stressed — relief negotiation in progress.'
          : 'Grid nominal.');
    return {
      id: datacenterId,
      name: saved?.displayName || 'Data center',
      lat: 39.04,
      lng: -77.49,
      joinedAt: Date.now(),
      gpuCount: 96,
      gpuKw: 0.72,
      baseKw: 420,
      queueDepth: 0,
      desiredUtilization: 0.4,
      actualUtilization: 0.0,
      schedulerCap: 0.86,
      latencyMs: 38,
      batteryKwh: 480,
      batterySoc: 0.72,
      batterySupportKw: 0,
      priority: 0.5,
      lastInstruction: fallbackInstruction,
      slurm: undefined,
    } as unknown as DataCenterAgent;
  }, [liveDc, datacenterId, params.sessionId, session]);

  async function refresh() {
    let response = await fetch(`/api/sessions/${params.sessionId}/state`);
    // Session was wiped (TTL/manual). Bootstrap a new one and continue.
    if (response.status === 404) {
      await fetch('/api/sessions');
      response = await fetch(`/api/sessions/${params.sessionId}/state`);
      if (!response.ok) return;
    } else if (!response.ok) {
      return;
    }
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function manualRejoin() {
    if (reconnectInFlight.current) return;
    reconnectInFlight.current = true;
    setReconnecting(true);
    try {
      const saved = loadJoinIdentity(params.sessionId);
      const displayName = saved?.displayName;
      const r = await fetch(`/api/sessions/${params.sessionId}/datacenters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (r.ok) {
        const j = (await r.json()) as { datacenterId: string; session: DemoSession };
        saveJoinIdentity(params.sessionId, j.datacenterId, displayName);
        liveDcId.current = j.datacenterId;
        setDatacenterId(j.datacenterId);
        setSession(j.session);
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          url.searchParams.set('dc', j.datacenterId);
          window.history.replaceState(null, '', url.toString());
        }
      }
    } finally {
      reconnectInFlight.current = false;
      setReconnecting(false);
    }
  }

  async function sendRequest(requestType: RequestType) {
    if (!datacenterId) return;
    setBusy(requestType);
    try {
      const response = await fetch(`/api/sessions/${params.sessionId}/datacenters/${datacenterId}/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestType }),
      });
      if (response.ok) {
        const data = (await response.json()) as { session: DemoSession };
        setSession(data.session);
      }
    } finally {
      setBusy(null);
    }
  }

  async function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!datacenterId || !chatMessage.trim()) return;
    const message = chatMessage;
    setChatMessage('');
    const response = await fetch(`/api/sessions/${params.sessionId}/datacenters/${datacenterId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  return (
    <main className="shell phone-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Data-center agent</p>
          <h1>{datacenter?.name ?? 'Joining session...'}</h1>
        </div>
        <div className="hero-actions">
          <a className="secondary-link" href="/readouts">Readouts</a>
          <button type="button" className="secondary-link" onClick={leaveSession}>
            Leave &amp; clear local
          </button>
        </div>
      </header>

      {!datacenterId ? (
        <section className="panel empty-state">
          <p>No data-center id in URL. Visit /join to register.</p>
        </section>
      ) : !datacenter ? (
        <section className="panel empty-state">Loading session…</section>
      ) : (
        <section className="phone-grid">
          <article className="status-card" data-health={session?.grid.health ?? 'normal'}>
            <span>Grid instruction</span>
            <b>{session?.grid.health.toUpperCase()}</b>
            <small>{datacenter.lastInstruction}</small>
          </article>

          <section className="panel request-panel">
            <p className="eyebrow">Submit demand</p>
            <h2>Ask your autonomous agent for more inference</h2>
            <div className="request-grid">
              {requests.map((request) => (
                <button key={request.type} onClick={() => sendRequest(request.type)} disabled={busy === request.type}>
                  <b>{request.label}</b>
                  <span>{request.detail}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="metrics tall">
            <Metric label="GPU use" value={`${Math.round(datacenter.actualUtilization * 100)}%`} />
            <Metric label="Scheduler cap" value={`${Math.round(datacenter.schedulerCap * 100)}%`} />
            <Metric label="Slurm state" value={datacenter.slurm?.state ?? 'normal'} />
            <Metric label="Jobs" value={`${datacenter.slurm?.runningJobs ?? 0} run / ${datacenter.slurm?.pendingJobs ?? 0} pend`} />
            <Metric label="Allocated GPUs" value={`${datacenter.slurm?.allocatedGpus ?? Math.round(datacenter.actualUtilization * datacenter.gpuCount)}/${datacenter.gpuCount}`} />
            <Metric label="Latency" value={`${datacenter.latencyMs} ms`} />
            <Metric label="Battery" value={`${Math.round(datacenter.batterySoc * 100)}%`} />
            <Metric label="Grid support" value={`${Math.round(datacenter.batterySupportKw)} kW`} />
            <Metric label="Grid readout" value={session?.grid.solver === 'opendss' ? 'OpenDSS' : 'approx'} />
          </section>

          <section className="panel slurm-panel">
            <p className="eyebrow">Mock Slurm</p>
            <h2>{datacenter.slurm?.partition ?? 'inference'} partition</h2>
            <div className="slurm-grid">
              <span>held jobs <b>{datacenter.slurm?.heldJobs ?? 0}</b></span>
              <span>completed <b>{datacenter.slurm?.completedJobs ?? 0}</b></span>
              <span>backfill <b>{datacenter.slurm?.backfillWindowMinutes ?? 0}m</b></span>
              <span>preemptions <b>{datacenter.slurm?.preemptions ?? 0}</b></span>
            </div>
            <p className="slurm-reason">{datacenter.slurm?.reason ?? 'Scheduler state is initializing.'}</p>
          </section>

          <section className="panel">
            <p className="eyebrow">Local agent chat</p>
            <h2>Negotiation trace</h2>
            <div className="event-list">
              {session?.events
                .filter((event) => event.from === datacenter.name || event.to === datacenter.name || event.to === 'data-center-agents' || event.from === 'grid-agent')
                .slice(0, 12)
                .map((event) => (
                  <article key={event.id} className="event">
                    <div><b>{event.type}</b><span>{new Date(event.at).toLocaleTimeString()}</span></div>
                    <p>{event.from} {'->'} {event.to}</p>
                    <small>{event.body}</small>
                  </article>
                ))}
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input
                value={chatMessage}
                onChange={(event) => setChatMessage(event.target.value)}
                placeholder="Ask the grid agent for more capacity"
              />
              <button disabled={!chatMessage.trim()}>Send</button>
            </form>
          </section>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><b>{value}</b></div>;
}
