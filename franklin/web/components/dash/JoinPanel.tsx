'use client';

import { useEffect, useState } from 'react';
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
  const [joinUrl, setJoinUrl] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 4;

  useEffect(() => {
    setJoinUrl(`${window.location.origin}/join`);
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
      <div className="join2__topline">
        <QrSvg value={joinUrl} size={88} />
        <div className="join2__topline-info">
          <button type="button" className="join2__copy" onClick={copy} disabled={!joinUrl}>
            {copied ? '✓ Copied' : 'Copy join link'}
          </button>
          <a className="join2__open" href="/join">Open join page ↗</a>
          <p className="join2__count">
            <b>{session?.datacenters.length ?? 0}</b> data centers
          </p>
        </div>
      </div>

      <form className="join2__add" onSubmit={add}>
        <input
          placeholder="add a data center…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={busy !== null}
        />
        <button disabled={busy !== null}>{busy === 'add' ? '…' : '+'}</button>
      </form>

      {(() => {
        const all = session?.datacenters ?? [];
        const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
        const safePage = Math.min(page, totalPages - 1);
        const slice = all.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
        return (
          <>
            <ul className="join2__list">
              {slice.length ? slice.map((dc) => (
                <li key={dc.id} className="join2__item">
                  <div className="join2__item-main">
                    <b>{dc.name}</b>
                    <small>{Math.round(summarizeKw(dc, session!.scenario))} kW · {dc.gpuCount} GPU · {fmtJoined(dc.joinedAt)}</small>
                  </div>
                  <button
                    type="button"
                    className="join2__del"
                    aria-label={`Remove ${dc.name}`}
                    disabled={busy !== null}
                    onClick={() => remove(dc.id, dc.name)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              )) : (
                <li className="join2__empty">No data centers in Upstash.</li>
              )}
            </ul>
            {all.length > PAGE_SIZE && (
              <div className="join2__pager">
                <button
                  type="button"
                  className="join2__pager-btn"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  aria-label="Previous page"
                >‹</button>
                <span className="join2__pager-info">
                  page {safePage + 1} / {totalPages} · {all.length} total
                </span>
                <button
                  type="button"
                  className="join2__pager-btn"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  aria-label="Next page"
                >›</button>
              </div>
            )}
          </>
        );
      })()}
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
