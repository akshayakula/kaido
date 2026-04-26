'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionSummary } from '@/lib/types';

const DEFAULT_SESSION_ID = 'default';

export function JoinClient() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/sessions')
      .then((response) => response.json())
      .then((data: { sessions: SessionSummary[] }) => {
        setSessions(data.sessions);
        setError('');
      })
      .catch(() => {
        setError('Could not load the shared grid session. Try refreshing.');
      });
  }, []);

  const selected = useMemo(() => sessions.find((session) => session.id === DEFAULT_SESSION_ID) ?? sessions[0], [sessions]);

  async function join() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/sessions/${DEFAULT_SESSION_ID}/datacenters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        datacenterId?: string;
        session?: unknown;
        error?: string;
      };
      if (!response.ok || !data.sessionId || !data.datacenterId) {
        setError(data.error || 'Could not join the default grid session.');
        return;
      }
      window.localStorage.setItem(`dc:${data.sessionId}`, data.datacenterId);
      if ('session' in data) {
        window.sessionStorage.setItem(`joined:${data.sessionId}:${data.datacenterId}`, JSON.stringify(data.session));
      }
      const destination = `/session/${data.sessionId}/datacenter?dc=${data.datacenterId}`;
      router.push(destination);
      window.location.assign(destination);
    } catch {
      setError('Network error while joining the grid session.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell join-shell">
      <section className="join-hero">
        <p className="eyebrow">Join as a data center</p>
        <h1>Send inference demand and let your agent negotiate for grid headroom</h1>
        <p>Name your data-center agent if you want, then submit compute demand from your phone or laptop into the shared default grid session.</p>
      </section>

      <section className="join-form panel">
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Data Center 07" />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button onClick={join} disabled={busy}>{busy ? 'Joining...' : 'Become a data-center agent'}</button>
        <a className="secondary-link" href="/dashboard">Open dashboard</a>
      </section>
    </main>
  );
}
