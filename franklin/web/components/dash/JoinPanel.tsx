'use client';

import { useMemo, useState } from 'react';
import type { DemoSession } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

export function JoinPanel({
  session,
  onDeleteDc,
  onAddDc,
}: {
  session: DemoSession | null;
  onDeleteDc: (id: string, name: string) => Promise<void>;
  onAddDc: (name?: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const joinUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/join`;
  }, []);

  async function copy() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy('add');
    try {
      await onAddDc(newName.trim() || undefined);
      setNewName('');
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove ${name} from Upstash and the grid?`)) return;
    setBusy(id);
    try {
      await onDeleteDc(id, name);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="join2">
      <div className="join2__qr">
        <QrSvg value={joinUrl} size={140} />
        <div className="join2__qr-side">
          <p className="eyebrow">Scan or share</p>
          <div className="join2__url">
            <input readOnly value={joinUrl || 'loading…'} onClick={(e) => e.currentTarget.select()} />
            <button onClick={copy} disabled={!joinUrl}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <a className="primary-link" href="/join">Open join page →</a>
          <p className="join2__count">{session?.datacenters.length ?? 0} data centers joined</p>
        </div>
      </div>

      <form className="join2__add" onSubmit={add}>
        <input
          placeholder="Add data center (name optional)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={busy !== null}
        />
        <button disabled={busy !== null}>{busy === 'add' ? 'Adding…' : '+ Add'}</button>
      </form>

      <ul className="join2__list">
        {session?.datacenters.length ? session.datacenters.map((dc) => (
          <li key={dc.id} className="join2__item">
            <div className="join2__item-main">
              <b>{dc.name}</b>
              <small>{Math.round(summarizeKw(dc, session.scenario))} kW · {dc.gpuCount} GPU · joined {fmtJoined(dc.joinedAt)}</small>
            </div>
            <button
              type="button"
              className="join2__del"
              aria-label={`Remove ${dc.name}`}
              disabled={busy !== null}
              onClick={() => remove(dc.id, dc.name)}
            >
              {busy === dc.id ? '…' : '×'}
            </button>
          </li>
        )) : (
          <li className="join2__empty">No data centers in Upstash.</li>
        )}
      </ul>
    </div>
  );
}

function fmtJoined(ts: number) {
  const ms = Date.now() - ts;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* Minimal in-house QR renderer (numeric+ASCII content only).
   For the join URL we bundle a tiny client-side QR encoder via canvas. */
function QrSvg({ value, size }: { value: string; size: number }) {
  if (!value) return <div className="qr-placeholder" style={{ width: size, height: size }} />;
  // Use Google Charts as a fallback-free QR provider would be ideal; offline use a CSS placeholder.
  // To keep dependencies minimal, encode via the public quickchart QR endpoint.
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}&color=e4e2c9&bgcolor=141612`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} width={size} height={size} alt="Join QR code" className="qr-img" />;
}
