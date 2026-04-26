'use client';

import { useMemo, useState } from 'react';
import type { AgentEvent, DemoSession } from '@/lib/types';

type FilterRole = 'all' | 'grid' | 'datacenter' | 'operator' | 'system';

const ROLE_FILTERS: { id: FilterRole; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'grid', label: 'Grid' },
  { id: 'datacenter', label: 'DCs' },
  { id: 'operator', label: 'Op' },
  { id: 'system', label: 'AI/Sys' },
];

export function A2APanel({
  session,
  onSendMessage,
}: {
  session: DemoSession | null;
  onSendMessage: (text: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterRole>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');

  const events = session?.events ?? [];

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (filter !== 'all') {
        const role = roleOf(e.from);
        if (role !== filter && roleOf(e.to) !== filter) return false;
      }
      if (query.trim()) {
        const q = query.toLowerCase();
        if (!e.body.toLowerCase().includes(q) && !e.from.toLowerCase().includes(q) && !e.to.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [events, filter, query]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft.trim()) return;
    onSendMessage(draft);
    setDraft('');
  }

  return (
    <div className="a2a2">
      <div className="a2a2__filters">
        {ROLE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`a2a2__chip ${filter === f.id ? 'a2a2__chip--on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <input
          className="a2a2__search"
          placeholder="search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="a2a2__list">
        {filtered.length === 0 ? (
          <div className="a2a2__empty">No events match.</div>
        ) : (
          filtered.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              isOpen={openId === e.id}
              onToggle={() => setOpenId(openId === e.id ? null : e.id)}
              session={session}
            />
          ))
        )}
      </div>
      <form className="a2a2__compose" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={session ? 'broadcast to grid agent…' : 'connecting…'}
          disabled={!session}
        />
        <button disabled={!session || !draft.trim()}>Send</button>
      </form>
    </div>
  );
}

function EventRow({
  event,
  isOpen,
  onToggle,
  session,
}: {
  event: AgentEvent;
  isOpen: boolean;
  onToggle: () => void;
  session: DemoSession | null;
}) {
  const fromRole = roleOf(event.from);
  return (
    <div className={`a2a2__row a2a2__row--${fromRole} ${isOpen ? 'a2a2__row--open' : ''}`}>
      <button type="button" className="a2a2__row-head" onClick={onToggle} aria-expanded={isOpen}>
        <span className="a2a2__time">{fmtTime(event.at)}</span>
        <span className="a2a2__route">
          <em>{shortActor(event.from)}</em>
          <span aria-hidden="true">→</span>
          <em>{shortActor(event.to)}</em>
        </span>
        <span className="a2a2__title">{eventLabel(event.type)}</span>
      </button>
      <div className="a2a2__row-body">
        <p>{event.body}</p>
        <small className="a2a2__hint">{eventHint(event)}</small>
        {session && (
          <dl className="a2a2__context">
            <div><dt>voltage</dt><dd>{session.grid.voltageMin.toFixed(3)} pu</dd></div>
            <div><dt>loading</dt><dd>{session.grid.lineLoadingMax.toFixed(2)}×</dd></div>
            <div><dt>reserve</dt><dd>{Math.round(session.grid.reserveKw).toLocaleString()} kW</dd></div>
          </dl>
        )}
      </div>
    </div>
  );
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function shortActor(actor: string) {
  if (actor === 'grid-agent') return 'grid';
  if (actor === 'data-center-agents') return 'all dcs';
  if (actor === 'opendss') return 'opendss';
  if (actor === 'slurm') return 'slurm';
  if (actor === 'operator') return 'operator';
  if (actor === 'ai-agent') return 'agent';
  if (actor === 'demo') return 'sys';
  return actor;
}

export function roleOf(actor: string): 'grid' | 'opendss' | 'datacenter' | 'operator' | 'system' {
  if (actor === 'grid-agent') return 'grid';
  if (actor === 'opendss' || actor === 'slurm') return 'opendss';
  if (actor === 'operator') return 'operator';
  if (actor === 'data-center-agents') return 'datacenter';
  if (actor === 'ai-agent' || actor === 'demo') return 'system';
  return 'datacenter';
}

function eventLabel(type: string) {
  const labels: Record<string, string> = {
    SOLVE_READY: 'grid model initialized',
    JOIN_GRID: 'data center joined',
    SBATCH: 'jobs submitted',
    MANUAL_OVERRIDE: 'operator override',
    SCENARIO_CHANGE: 'scenario changed',
    REQUEST_RELIEF: 'asks for relief',
    RELIEF_OFFER: 'offers flexibility',
    POWER_FLOW_RESULT: 'power flow result',
    AI_NEGOTIATION: 'agent reasoning',
    AI_DISABLED: 'AI off',
    AI_FALLBACK: 'fallback message',
    CHAT: 'direct message',
  };
  return labels[type] ?? type.replaceAll('_', ' ').toLowerCase();
}

function eventHint(event: AgentEvent) {
  if (event.type === 'REQUEST_RELIEF') return 'Grid is constrained; data centers should defer flexible work or use batteries.';
  if (event.type === 'RELIEF_OFFER') return 'A data-center agent found schedulable load it can delay.';
  if (event.type === 'POWER_FLOW_RESULT') return 'OpenDSS solved the feeder after the latest scheduler actions.';
  if (event.type === 'SBATCH') return 'Participant demand entered the mock Slurm queue.';
  if (event.type === 'AI_NEGOTIATION') return 'Agent translating grid state into a scheduling decision.';
  if (event.type === 'MANUAL_OVERRIDE') return 'Operator directly changed an agent.';
  if (event.type === 'SCENARIO_CHANGE') return 'Grid agent reacting to a new disruption condition.';
  if (event.type === 'JOIN_GRID') return 'A new data-center agent joined the shared grid.';
  return `Raw event: ${event.type}`;
}
