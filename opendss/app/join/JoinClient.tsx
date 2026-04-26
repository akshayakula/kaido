'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { SessionSummary } from '@/lib/types';

export function JoinClient() {
  const router = useRouter();
  const search = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(search.get('session') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/sessions')
      .then((response) => response.json())
      .then((data: { sessions: SessionSummary[] }) => {
        setSessions(data.sessions);
        if (!sessionId && data.sessions[0]) setSessionId(data.sessions[0].id);
      });
  }, [sessionId]);

  const selected = useMemo(() => sessions.find((session) => session.id === sessionId), [sessions, sessionId]);

  async function join() {
    if (!sessionId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/datacenters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { sessionId: string; datacenterId: string };
      window.localStorage.setItem(`dc:${data.sessionId}`, data.datacenterId);
      router.push(`/session/${data.sessionId}/datacenter?dc=${data.datacenterId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell join-shell">
      <section className="join-hero">
        <p className="eyebrow">Join as a data center</p>
        <h1>Send inference demand and let your agent negotiate for grid headroom</h1>
        <p>Choose an active session, name your data-center agent if you want, then submit compute demand from your phone or laptop.</p>
      </section>

      <section className="join-form panel">
        <label>
          <span>Active session</span>
          <select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            <option value="">Select a session</option>
            {sessions.map((session) => (
              <option value={session.id} key={session.id}>
                {session.label} · {session.locationName} · {session.participantCount} data centers
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Data Center 07" />
        </label>
        {selected && <div className="selected-session">Grid is {selected.health}; {selected.participantCount} data centers connected.</div>}
        <button onClick={join} disabled={!sessionId || busy}>{busy ? 'Joining...' : 'Become a data-center agent'}</button>
        <a className="secondary-link" href="/dashboard">Open dashboard</a>
      </section>
    </main>
  );
}
