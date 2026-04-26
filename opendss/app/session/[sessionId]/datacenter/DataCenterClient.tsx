'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import type { DataCenterAgent, DemoSession, RequestType } from '@/lib/types';

const requests: { type: RequestType; label: string; detail: string }[] = [
  { type: 'standard_inference', label: 'Standard inference', detail: 'Normal chat traffic' },
  { type: 'priority_inference', label: 'Priority inference', detail: 'Higher urgency request' },
  { type: 'batch_inference', label: 'Batch inference', detail: 'Large flexible queue' },
  { type: 'urgent_burst', label: 'Urgent burst', detail: 'Sudden GPU spike' },
];

export function DataCenterClient() {
  const params = useParams<{ sessionId: string }>();
  const search = useSearchParams();
  const [session, setSession] = useState<DemoSession | null>(null);
  const [busy, setBusy] = useState<RequestType | null>(null);
  const [chatMessage, setChatMessage] = useState('');
  const datacenterId = search.get('dc') ?? '';

  useEffect(() => {
    const cached = window.sessionStorage.getItem(`joined:${params.sessionId}:${datacenterId}`);
    if (cached) {
      try {
        setSession(JSON.parse(cached) as DemoSession);
      } catch {
        window.sessionStorage.removeItem(`joined:${params.sessionId}:${datacenterId}`);
      }
    }
    const interval = window.setInterval(refresh, 1000);
    refresh();
    return () => window.clearInterval(interval);
  }, [datacenterId, params.sessionId]);

  const datacenter = useMemo<DataCenterAgent | undefined>(
    () => session?.datacenters.find((dc) => dc.id === datacenterId),
    [datacenterId, session]
  );

  async function refresh() {
    const response = await fetch(`/api/sessions/${params.sessionId}/state`);
    if (!response.ok) return;
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
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
        <a className="secondary-link" href="/join">Switch session</a>
      </header>

      {!datacenter ? (
        <section className="panel empty-state">This data-center agent was not found in the session.</section>
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
