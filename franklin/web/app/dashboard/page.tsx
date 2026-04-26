'use client';

import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { GridMap } from '@/components/GridMap';
import type { AgentEvent, DataCenterAgent, DemoSession, Scenario } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';
import { scenarioBrief, scenarioLabel, scenarioOptions } from '@/lib/scenarios';

const DEFAULT_SESSION_ID = 'default';

type StoreHealth = {
  configured: boolean;
  mode: 'upstash' | 'memory' | 'memory-fallback';
  ok: boolean;
  host: string | null;
  activeSessions?: number;
};

export default function DashboardPage() {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [chatMessage, setChatMessage] = useState('');
  const [joinCopied, setJoinCopied] = useState(false);
  const [storeHealth, setStoreHealth] = useState<StoreHealth | null>(null);

  useEffect(() => {
    refresh(DEFAULT_SESSION_ID);
    refreshStoreHealth();
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    const interval = window.setInterval(async () => {
      const response = await fetch(`/api/sessions/${session.id}/tick`, { method: 'POST' });
      if (response.ok) {
        const data = (await response.json()) as { session: DemoSession };
        setSession(data.session);
      }
      refreshStoreHealth();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [session?.id]);

  // Inject draggable + collapsible chrome onto the floating dashboard cards.
  // Persists position + collapsed-state per panel in localStorage.
  useEffect(() => {
    type Target = { sel: string; label: string; defaultCollapsed?: boolean };
    const targets: Target[] = [
      { sel: '.dashboard-screen .cylinder-readout',     label: 'Cylinder live read',  defaultCollapsed: true },
      { sel: '.dashboard-screen .diagnostics-stack',    label: 'Diagnostics' },
      { sel: '.dashboard-screen .gpu-scheduler-panel',  label: 'GPU scheduler',       defaultCollapsed: true },
      { sel: '.dashboard-screen .negotiation-panel',    label: 'Agent conversation',  defaultCollapsed: true },
      { sel: '.dashboard-screen .terminal-panel',       label: 'OpenDSS terminal' },
      { sel: '.dashboard-screen .site-card',            label: 'Grid agent' },
    ];

    const cleanups: Array<() => void> = [];
    let raf = 0;

    const wire = (target: Target) => {
      const el = document.querySelector<HTMLElement>(target.sel);
      if (!el || el.dataset.fpInited) return;
      el.dataset.fpInited = '1';
      el.classList.add('fp-card');

      const stored: { x?: number; y?: number; collapsed?: boolean } = (() => {
        try { return JSON.parse(localStorage.getItem('fp:' + target.sel) || '{}'); }
        catch { return {}; }
      })();
      if (stored.x != null && stored.y != null) {
        el.style.transform = `translate(${stored.x}px, ${stored.y}px)`;
      }
      const startCollapsed = stored.collapsed ?? target.defaultCollapsed ?? false;
      if (startCollapsed) el.classList.add('fp-collapsed');

      const bar = document.createElement('div');
      bar.className = 'fp-bar';
      const handle = document.createElement('div');
      handle.className = 'fp-handle';
      handle.textContent = target.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fp-collapse';
      btn.setAttribute('aria-label', 'toggle panel');
      btn.textContent = el.classList.contains('fp-collapsed') ? '+' : '–';
      bar.appendChild(handle);
      bar.appendChild(btn);
      el.prepend(bar);

      const save = (patch: Partial<{ x: number; y: number; collapsed: boolean }>) => {
        const cur = (() => {
          try { return JSON.parse(localStorage.getItem('fp:' + target.sel) || '{}'); }
          catch { return {}; }
        })();
        localStorage.setItem('fp:' + target.sel, JSON.stringify({ ...cur, ...patch }));
      };

      // Mouse drag — header is the grab handle.
      const onMouseDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.fp-collapse')) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const m = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
        const baseX = m ? parseFloat(m[1]) : 0;
        const baseY = m ? parseFloat(m[2]) : 0;
        el.classList.add('fp-dragging');
        const onMove = (ev: MouseEvent) => {
          const x = baseX + (ev.clientX - startX);
          const y = baseY + (ev.clientY - startY);
          el.style.transform = `translate(${x}px, ${y}px)`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          el.classList.remove('fp-dragging');
          const mm = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
          if (mm) save({ x: parseFloat(mm[1]), y: parseFloat(mm[2]) });
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      };
      bar.addEventListener('mousedown', onMouseDown);

      const onClick = () => {
        el.classList.toggle('fp-collapsed');
        const collapsed = el.classList.contains('fp-collapsed');
        btn.textContent = collapsed ? '+' : '–';
        save({ collapsed });
      };
      btn.addEventListener('click', onClick);

      cleanups.push(() => {
        bar.removeEventListener('mousedown', onMouseDown);
        btn.removeEventListener('click', onClick);
        bar.remove();
        delete el.dataset.fpInited;
        el.classList.remove('fp-card', 'fp-collapsed', 'fp-dragging');
      });
    };

    // Run after render; the React-rendered cards may not be in the DOM yet
    // on first effect tick.
    const tick = () => {
      targets.forEach(wire);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
      cleanups.forEach((fn) => fn());
    };
  }, [session?.id]);

  const joinUrl = useMemo(() => {
    if (!session) return '';
    return `${window.location.origin}/join`;
  }, [session]);

  async function refresh(id: string) {
    const response = await fetch(`/api/sessions/${id}/state`);
    if (!response.ok) return;
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function refreshStoreHealth() {
    const response = await fetch('/api/upstash/health');
    if (!response.ok && response.status !== 503) return;
    const data = (await response.json()) as StoreHealth;
    setStoreHealth(data);
  }

  async function changeScenario(scenario: Scenario) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/scenario`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function sendOperatorMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !chatMessage.trim()) return;
    const message = chatMessage;
    setChatMessage('');
    const response = await fetch(`/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  async function overrideDataCenter(
    datacenterId: string,
    override: { schedulerCap?: number; batterySupportKw?: number; instruction: string }
  ) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/datacenters/${datacenterId}/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(override),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  async function copyJoinUrl() {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    setJoinCopied(true);
    window.setTimeout(() => setJoinCopied(false), 1400);
  }

  const drawLevel = session ? getDrawLevel(session) : 'waiting';
  const voltageTone =
    !session ? 'waiting' : session.grid.health === 'normal' ? 'steady' : session.grid.health === 'stressed' ? 'strained' : 'critical';
  const solverTone = session?.grid.solver === 'opendss' ? 'OpenDSS solve' : session ? 'approximate' : 'waiting';
  const dssPreview = session ? buildDssPreview(session) : null;

  return (
    <main className="dashboard-screen v2">
      <header className="hero operator-topbar">
        <a className="brand-link" href="/" aria-label="Franklin home">Franklin</a>
        <span className="topbar-status" data-health={session?.grid.health ?? 'normal'}>
          {session?.grid.health
            ? <><i className="topbar-dot" />{session.grid.health.toUpperCase()} · {session.site.region}</>
            : 'connecting…'}
        </span>
        <div className="hero-actions">
          <a className="hdr-btn" href="/readouts">Readouts</a>
          <a className="hdr-btn" href="/grid-sensor">Franklin sensors</a>
          <a className="hdr-btn hdr-btn--primary" href="/join">Join as data center →</a>
        </div>
      </header>

      <section className="dashboard-grid dashboard-stage">
        <div className="map-panel globe-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Grid site</p>
              <h2>{session ? `${session.site.name} · ${session.site.region}` : 'No session yet'}</h2>
              {session && <small className="scenario-brief">{scenarioBrief(session.scenario)}</small>}
            </div>
            {session && (
              <select value={session.scenario} onChange={(event) => changeScenario(event.target.value as Scenario)}>
                {scenarioOptions.map((scenario) => <option key={scenario.value} value={scenario.value}>{scenario.label}</option>)}
              </select>
            )}
          </div>
          <div className="map-wrap"><GridMap session={session} /></div>
        </div>
      </section>

      <aside className="side-stack diagnostics-stack">
          <section className="status-card" data-health={session?.grid.health ?? 'normal'}>
            <span>Grid status</span>
            <b>{session?.grid.health.toUpperCase() ?? 'WAITING'}</b>
            <small>{session ? 'Default shared session' : 'Loading default session'}</small>
          </section>
          <section className="metrics">
            <Metric label="Grid health" value={voltageTone} />
            <Metric label="Relative draw" value={drawLevel} />
            <Metric label="Readout" value={solverTone} />
            <Metric label="Data centers" value={session ? String(session.datacenters.length) : '-'} />
            <Metric label="Session store" value={storeHealth ? storeHealthLabel(storeHealth) : 'checking'} />
          </section>
          <section className="join-card">
            <p className="eyebrow">Participant entry</p>
            <h2>Users go to the website and join the shared grid</h2>
            <div className="join-link-row">
              <input readOnly value={joinUrl || 'Loading join link'} onClick={(event) => event.currentTarget.select()} />
              <button onClick={copyJoinUrl} disabled={!joinUrl}>{joinCopied ? 'Copied' : 'Copy'}</button>
            </div>
            <a className="primary-link" href="/join">Open join page</a>
          </section>

      <section className="lower-grid diagnostics-bottom">
        <section className="panel gpu-scheduler-panel">
          <div className="panel-head compact">
            <div>
              <p className="eyebrow">Data-center agents</p>
              <h2>GPU scheduler state</h2>
            </div>
          </div>
          <div className="agent-list">
            {session?.datacenters.length ? session.datacenters.map((dc) => (
              <article className="agent-row" key={dc.id}>
                <div>
                  <b>{dc.name}</b>
                  <span>{Math.round(summarizeKw(dc, session.scenario))} kW · {dc.slurm?.runningJobs ?? 0} running · {dc.slurm?.pendingJobs ?? 0} pending</span>
                </div>
                <div className="bar"><i style={{ width: `${Math.round(dc.actualUtilization * 100)}%` }} /></div>
                <small>{dc.slurm?.state ?? 'normal'} · {dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount)}/{dc.gpuCount} GPUs · cap {Math.round(dc.schedulerCap * 100)}%</small>
                <div className="slurm-strip">
                  <span>held {dc.slurm?.heldJobs ?? 0}</span>
                  <span>done {dc.slurm?.completedJobs ?? 0}</span>
                  <span>backfill {dc.slurm?.backfillWindowMinutes ?? 0}m</span>
                  <span>preempt {dc.slurm?.preemptions ?? 0}</span>
                </div>
                <div className="override-buttons">
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        schedulerCap: Math.max(0.32, dc.schedulerCap - 0.1),
                        instruction: `Manual override: reduce scheduler cap to ${Math.round(Math.max(0.32, dc.schedulerCap - 0.1) * 100)}%.`,
                      })
                    }
                  >
                    Cap down
                  </button>
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        schedulerCap: Math.min(0.96, dc.schedulerCap + 0.1),
                        instruction: `Manual override: restore scheduler cap to ${Math.round(Math.min(0.96, dc.schedulerCap + 0.1) * 100)}%.`,
                      })
                    }
                  >
                    Cap up
                  </button>
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        batterySupportKw: Math.min(220, dc.batterySupportKw + 50),
                        instruction: `Manual override: commit ${Math.round(Math.min(220, dc.batterySupportKw + 50))} kW battery support.`,
                      })
                    }
                  >
                    +Battery
                  </button>
                </div>
              </article>
            )) : <div className="empty">No data centers have joined yet.</div>}
          </div>
        </section>

        <section className="panel negotiation-panel">
          <div className="panel-head compact">
            <div>
              <p className="eyebrow">A2A negotiation</p>
              <h2>Agent conversation</h2>
            </div>
          </div>
          <div className="conversation-map" aria-label="Agent conversation legend">
            <span>Grid agent</span>
            <i />
            <span>Data-center agents</span>
            <i />
            <span>Slurm + OpenDSS</span>
          </div>
          <div className="event-list conversation-thread">
            {session?.events.length ? session.events.map((event, index) => (
              <ConversationEvent key={event.id} event={event} isLatest={index === 0} />
            )) : <div className="empty">Waiting for agents to negotiate.</div>}
          </div>
          <form className="chat-form" onSubmit={sendOperatorMessage}>
            <input
              value={chatMessage}
              onChange={(event) => setChatMessage(event.target.value)}
              placeholder="Broadcast an instruction to the grid agent"
              disabled={!session}
            />
            <button disabled={!session || !chatMessage.trim()}>Send</button>
          </form>
        </section>
      </section>

      <section className="panel dss-panel terminal-panel">
        <div className="panel-head compact">
          <div>
            <p className="eyebrow">OpenDSS system</p>
            <h2>Actual circuit being solved</h2>
          </div>
          <span className="solver-badge">{session?.grid.solver === 'opendss' ? 'Live OpenDSS' : 'Approx fallback'}</span>
        </div>
        {dssPreview ? (
          <>
            <div className="dss-facts">
              <span><b>Scenario</b>{scenarioLabel(dssPreview.scenario)}</span>
              <span className="dss-brief"><b>Posture</b>{dssPreview.brief}</span>
              <span><b>Source</b>{dssPreview.config.sourcePu.toFixed(3)} pu</span>
              <span><b>Transformer</b>{dssPreview.config.substationKva.toLocaleString()} kVA</span>
              <span><b>Feeder limit</b>{dssPreview.config.lineNormamps} A</span>
              <span><b>Total load</b>{Math.round(dssPreview.feederKw).toLocaleString()} kW</span>
            </div>
            <pre className="dss-commands" aria-label="OpenDSS command list">
              {dssPreview.commands.map((command, index) => `${String(index + 1).padStart(2, '0')}. ${command}`).join('\n')}
            </pre>
          </>
        ) : (
          <div className="empty">Waiting for the default session.</div>
        )}
      </section>
      </aside>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><b>{value}</b></div>;
}

function GridAnalogReadouts({ session }: { session: DemoSession | null }) {
  if (!session) {
    return (
      <section className="analog-panel">
        <p className="eyebrow">Analog grid readouts</p>
        <div className="empty">Waiting for OpenDSS state.</div>
      </section>
    );
  }

  const { grid } = session;
  return (
    <section className="analog-panel">
      <p className="eyebrow">Analog grid readouts</p>
      <AnalogGauge
        label="Voltage floor"
        value={`${grid.voltageMin.toFixed(3)} pu`}
        detail={grid.voltageMin < 0.955 ? 'below ANSI band' : grid.voltageMin < 0.974 ? 'sagging' : 'stable'}
        tone={grid.voltageMin < 0.955 ? 'critical' : grid.voltageMin < 0.974 ? 'warn' : 'ok'}
        fill={scale(grid.voltageMin, 0.9, 1.03)}
      />
      <AnalogGauge
        label="Feeder loading"
        value={`${grid.lineLoadingMax.toFixed(2)}x`}
        detail={grid.lineLoadingMax > 1 ? 'above feeder limit' : grid.lineLoadingMax > 0.82 ? 'near constraint' : 'within margin'}
        tone={grid.lineLoadingMax > 1 ? 'critical' : grid.lineLoadingMax > 0.82 ? 'warn' : 'ok'}
        fill={scale(grid.lineLoadingMax, 0.3, 1.25)}
      />
      <AnalogGauge
        label="Reserve"
        value={`${Math.round(grid.reserveKw).toLocaleString()} kW`}
        detail={grid.reserveKw < 250 ? 'no headroom' : grid.reserveKw < 900 ? 'thin margin' : 'available'}
        tone={grid.reserveKw < 250 ? 'critical' : grid.reserveKw < 900 ? 'warn' : 'ok'}
        fill={scale(grid.reserveKw, 0, 2800)}
      />
      <AnalogGauge
        label="Frequency"
        value={`${grid.frequencyHz.toFixed(2)} Hz`}
        detail={grid.frequencyHz < 59.98 ? 'droop visible' : 'nominal'}
        tone={grid.frequencyHz < 59.98 ? 'warn' : 'ok'}
        fill={scale(grid.frequencyHz, 59.9, 60.05)}
      />
      <AnalogGauge
        label="Losses"
        value={`${Math.round(grid.lossesKw)} kW`}
        detail="thermal waste"
        tone={grid.lossesKw > 220 ? 'warn' : 'ok'}
        fill={scale(grid.lossesKw, 40, 320)}
      />
    </section>
  );
}

function AnalogGauge({
  label,
  value,
  detail,
  tone,
  fill,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'ok' | 'warn' | 'critical';
  fill: number;
}) {
  return (
    <div className="analog-gauge" data-tone={tone} style={{ '--gauge-angle': `${-74 + fill * 1.48}deg` } as CSSProperties}>
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <i aria-hidden="true" />
      <small>{detail}</small>
    </div>
  );
}

function scale(value: number, min: number, max: number) {
  return Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 100);
}

function ConversationEvent({ event, isLatest }: { event: AgentEvent; isLatest: boolean }) {
  const fromRole = agentRole(event.from);
  const toRole = agentRole(event.to);
  const tone = eventTone(event.type);

  return (
    <article className={`event conversation-event ${tone}`} data-latest={isLatest ? 'true' : 'false'}>
      <div className="conversation-meta">
        <span className="move-label">{isLatest ? 'Latest move' : eventMoveLabel(event.type)}</span>
        <time>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
      </div>
      <div className="conversation-route">
        <span className="actor-chip" data-role={fromRole}>{formatActor(event.from)}</span>
        <span className="route-arrow">to</span>
        <span className="actor-chip" data-role={toRole}>{formatActor(event.to)}</span>
      </div>
      <p className="conversation-title">{eventMoveLabel(event.type)}</p>
      <small>{event.body}</small>
      <div className="conversation-hint">{eventHint(event)}</div>
    </article>
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

function agentRole(actor: string) {
  if (actor === 'grid-agent') return 'grid';
  if (actor === 'opendss') return 'opendss';
  if (actor === 'slurm') return 'scheduler';
  if (actor === 'operator') return 'operator';
  if (actor === 'data-center-agents') return 'datacenter';
  if (actor === 'ai-agent' || actor === 'demo') return 'system';
  return 'datacenter';
}

function eventMoveLabel(type: string) {
  const labels: Record<string, string> = {
    SOLVE_READY: 'Grid model initialized',
    JOIN_GRID: 'Data center joined',
    SBATCH: 'Inference jobs submitted',
    MANUAL_OVERRIDE: 'Operator override',
    SCENARIO_CHANGE: 'Scenario changed',
    REQUEST_RELIEF: 'Grid asks for relief',
    RELIEF_OFFER: 'Data center offers flexibility',
    POWER_FLOW_RESULT: 'OpenDSS reports grid health',
    AI_NEGOTIATION: 'Agent explains tradeoff',
    AI_DISABLED: 'AI messaging disabled',
    AI_FALLBACK: 'Fallback negotiation message',
    CHAT: 'Direct message',
  };
  return labels[type] ?? type.replaceAll('_', ' ').toLowerCase();
}

function eventTone(type: string) {
  if (type === 'REQUEST_RELIEF' || type === 'POWER_FLOW_RESULT') return 'grid-move';
  if (type === 'RELIEF_OFFER' || type === 'SBATCH' || type === 'JOIN_GRID') return 'datacenter-move';
  if (type === 'MANUAL_OVERRIDE' || type === 'SCENARIO_CHANGE' || type === 'CHAT') return 'operator-move';
  if (type.startsWith('AI_')) return 'ai-move';
  return 'system-move';
}

function eventHint(event: AgentEvent) {
  if (event.type === 'REQUEST_RELIEF') return 'Meaning: the grid is constrained, so data centers should reduce flexible GPU work or use batteries.';
  if (event.type === 'RELIEF_OFFER') return 'Meaning: a data-center agent found schedulable load it can delay or shift.';
  if (event.type === 'POWER_FLOW_RESULT') return 'Meaning: OpenDSS solved the feeder after the latest scheduler actions.';
  if (event.type === 'SBATCH') return 'Meaning: participant demand entered the mock Slurm queue.';
  if (event.type === 'AI_NEGOTIATION') return 'Meaning: the agent is translating grid state into a scheduling decision.';
  if (event.type === 'MANUAL_OVERRIDE') return 'Meaning: the operator directly changed one data center agent.';
  if (event.type === 'SCENARIO_CHANGE') return 'Meaning: the grid agent is reacting to a new disruption condition.';
  if (event.type === 'JOIN_GRID') return 'Meaning: a phone/browser joined as a simulated data-center agent.';
  return `Raw event: ${event.type}`;
}

function storeHealthLabel(health: StoreHealth) {
  if (health.mode === 'upstash' && health.ok) return 'Upstash live';
  if (health.mode === 'memory-fallback') return 'Redis fallback';
  if (!health.configured) return 'memory only';
  return 'checking';
}

function getDrawLevel(session: DemoSession) {
  if (!session.datacenters.length) return 'idle';
  const averageDraw =
    session.datacenters.reduce((sum, dc) => {
      const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
      return sum + Math.max(dc.actualUtilization, allocated / Math.max(1, dc.gpuCount));
    }, 0) / session.datacenters.length;
  if (averageDraw > 0.68) return 'heavy';
  if (averageDraw > 0.36) return 'moderate';
  return 'light';
}

type DssConfig = {
  sourcePu: number;
  substationKva: number;
  lineNormamps: number;
  cooling: number;
};

function getScenarioConfig(scenario: Scenario): DssConfig {
  const configs: Record<Scenario, DssConfig> = {
    nominal: { sourcePu: 1.02, substationKva: 8500, lineNormamps: 430, cooling: 0.28 },
    heatwave: { sourcePu: 1, substationKva: 7600, lineNormamps: 390, cooling: 0.44 },
    feeder_constraint: { sourcePu: 0.985, substationKva: 6500, lineNormamps: 320, cooling: 0.32 },
    renewable_drop: { sourcePu: 0.992, substationKva: 7000, lineNormamps: 360, cooling: 0.3 },
    demand_spike: { sourcePu: 1, substationKva: 7800, lineNormamps: 380, cooling: 0.36 },
  };
  return configs[scenario];
}

function buildDssPreview(session: DemoSession) {
  const config = getScenarioConfig(session.scenario);
  const commands = [
    'Clear',
    `New Circuit.AgentGrid basekv=12.47 pu=${config.sourcePu} phases=3 bus1=sourcebus angle=0 MVAsc3=200000 MVAsc1=210000`,
    `New Transformer.Substation phases=3 windings=2 buses=(sourcebus,subbus) conns=(wye,wye) kvs=(12.47,12.47) kvas=(${config.substationKva},${config.substationKva}) %rs=(0.2,0.2) xhl=1.25`,
    `New Linecode.Feeder nphases=3 r1=0.26 x1=0.34 r0=0.52 x0=1.08 units=km normamps=${config.lineNormamps}`,
    'New Line.Backbone bus1=subbus bus2=bus0 phases=3 linecode=Feeder length=0.35 units=km',
  ];
  let feederKw = 0;

  session.datacenters.forEach((dc, index) => {
    const loadNumber = index + 1;
    const bus = `dc${loadNumber}bus`;
    const lengthKm = 0.45 + (loadNumber % 4) * 0.18;
    const kw = datacenterKw(dc, config.cooling);
    const kvar = kw * 0.33;
    feederKw += kw;
    commands.push(`New Line.DC${loadNumber} bus1=bus0 bus2=${bus} phases=3 linecode=Feeder length=${lengthKm.toFixed(3)} units=km`);
    commands.push(
      `New Load.Load${loadNumber} bus1=${bus} phases=3 conn=wye kv=12.47 kw=${kw.toFixed(3)} kvar=${kvar.toFixed(3)} model=1`
    );
  });

  if (!session.datacenters.length) {
    feederKw = 80;
    commands.push('New Load.StationService bus1=bus0 phases=3 conn=wye kv=12.47 kw=80 kvar=25 model=1');
  }

  commands.push('Set Voltagebases=[12.47]', 'CalcVoltageBases', 'Set maxcontroliter=50', 'Solve');
  return { commands, config, feederKw, scenario: session.scenario, brief: scenarioBrief(session.scenario) };
}

function datacenterKw(dc: DataCenterAgent, coolingFactor: number) {
  const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
  const util = Math.max(dc.actualUtilization, allocated / Math.max(1, dc.gpuCount));
  const computeKw = dc.gpuCount * dc.gpuKw * util;
  return Math.max(0, dc.baseKw + computeKw + computeKw * coolingFactor - dc.batterySupportKw);
}
