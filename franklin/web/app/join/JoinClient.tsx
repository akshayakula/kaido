'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DemoSession, SessionSummary } from '@/lib/types';
import { clearJoinIdentity, loadJoinIdentity, saveJoinIdentity } from '@/lib/joinIdentity';

const DEFAULT_SESSION_ID = 'default';

export function JoinClient() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/sessions')
      .then((response) => response.json())
      .then(async (data: { sessions: SessionSummary[]; session?: DemoSession }) => {
        if (!alive) return;
        setSessions(data.sessions);
        setError('');
        // If localStorage says we already joined as a DC, verify it still
        // exists upstream and offer a "rejoin" shortcut. Otherwise clear it.
        const id = loadJoinIdentity(DEFAULT_SESSION_ID);
        if (!id) return;
        const sess = data.session ?? null;
        const dc = sess?.datacenters.find((d) => d.id === id.datacenterId);
        if (dc) {
          setExisting({ id: dc.id, name: dc.name });
          setDisplayName(dc.name);
        } else {
          clearJoinIdentity(DEFAULT_SESSION_ID);
          window.sessionStorage.removeItem(`joined:${DEFAULT_SESSION_ID}:${id.datacenterId}`);
        }
      })
      .catch(() => {
        if (alive) setError('Could not load the shared grid session. Try refreshing.');
      });
    return () => { alive = false; };
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
      saveJoinIdentity(data.sessionId, data.datacenterId);
      if ('session' in data && data.session) {
        try {
          window.localStorage.setItem(
            `joined:${data.sessionId}:${data.datacenterId}`,
            JSON.stringify(data.session),
          );
        } catch { /* quota — fine to skip */ }
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
        {existing && (
          <div className="join-existing">
            <p className="eyebrow">Saved on this device</p>
            <b>{existing.name}</b>
            <div className="join-existing__row">
              <a
                className="primary-link"
                href={`/session/${DEFAULT_SESSION_ID}/datacenter?dc=${existing.id}`}
              >
                Rejoin →
              </a>
              <button
                type="button"
                className="secondary-link"
                onClick={() => {
                  clearJoinIdentity(DEFAULT_SESSION_ID);
                  try {
                    window.localStorage.removeItem(`joined:${DEFAULT_SESSION_ID}:${existing.id}`);
                    window.sessionStorage.removeItem(`joined:${DEFAULT_SESSION_ID}:${existing.id}`);
                  } catch { /* ignore */ }
                  setExisting(null);
                  setDisplayName('');
                }}
              >
                Clear local session
              </button>
            </div>
          </div>
        )}
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Data Center 07" />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button onClick={join} disabled={busy}>{busy ? 'Joining...' : existing ? 'Join as new data center' : 'Become a data-center agent'}</button>
        <a className="secondary-link" href="/dashboard">Open dashboard</a>
      </section>
    </main>
  );
}
