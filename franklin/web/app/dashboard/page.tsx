'use client';

import { useEffect, useMemo, useState } from 'react';
import { GridMap } from '@/components/GridMap';
import { PjmStatus } from '@/components/PjmStatus';
import { OpenDssPanel } from '@/components/dash/OpenDssPanel';
import { AnalogReadouts } from '@/components/dash/AnalogReadouts';
import { A2APanel } from '@/components/dash/A2APanel';
import { JoinPanel } from '@/components/dash/JoinPanel';
import { DashPanel } from '@/components/dash/DashPanel';
import { useDashLayout, useDragSwap } from '@/components/dash/DashGrid';
import { clearLayout } from '@/lib/dashLayout';
import type { DemoSession, Scenario } from '@/lib/types';
import { scenarioBrief, scenarioOptions } from '@/lib/scenarios';

const DEFAULT_SESSION_ID = 'default';
const PANEL_IDS = ['opendss', 'readouts', 'a2a', 'join'] as const;
const DEFAULT_ORDER: string[] = [...PANEL_IDS];

export default function DashboardPage() {
  const [session, setSession] = useState<DemoSession | null>(null);

  useEffect(() => {
    refresh(DEFAULT_SESSION_ID);
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    const interval = window.setInterval(async () => {
      const response = await fetch(`/api/sessions/${session.id}/tick`, { method: 'POST' });
      if (response.ok) {
        const data = (await response.json()) as { session: DemoSession };
        setSession(data.session);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [session?.id]);

  async function refresh(id: string) {
    const response = await fetch(`/api/sessions/${id}/state`);
    if (!response.ok) return;
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function changeScenario(scenario: Scenario) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/scenario`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  async function sendOperatorMessage(message: string) {
    if (!session || !message.trim()) return;
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

  async function deleteDc(datacenterId: string) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/datacenters/${datacenterId}`, {
      method: 'DELETE',
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  async function addDc(displayName?: string) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/datacenters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  const { layout, setLayout } = useDashLayout(DEFAULT_ORDER);
  const { dragId, hoverId, ghost, handlers } = useDragSwap(layout, setLayout);

  const panelMap = useMemo(() => {
    const map: Record<string, { eyebrow: string; title: string; node: React.ReactNode }> = {
      opendss: {
        eyebrow: 'OpenDSS · single-line',
        title: 'Electrical layout',
        node: <OpenDssPanel session={session} />,
      },
      readouts: {
        eyebrow: 'Live grid readouts',
        title: 'Capacity & health',
        node: <AnalogReadouts session={session} />,
      },
      a2a: {
        eyebrow: 'Negotiation trace',
        title: 'Agent-to-agent chat',
        node: <A2APanel session={session} onSendMessage={sendOperatorMessage} />,
      },
      join: {
        eyebrow: 'Upstash data centers',
        title: 'Join · manage',
        node: (
          <JoinPanel
            session={session}
            onAddDc={addDc}
            onDeleteDc={async (id) => deleteDc(id)}
          />
        ),
      },
    };
    return map;
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetLayout() {
    clearLayout();
    setLayout({ order: DEFAULT_ORDER, collapsed: {} });
  }

  return (
    <main className="dashboard-screen v4">
      <header className="dash4-topbar">
        <a className="brand-link" href="/" aria-label="Franklin home">Franklin</a>
        <span className="dash4-status" data-health={session?.grid.health ?? 'normal'}>
          <i />{session?.grid.health?.toUpperCase() ?? '…'} · {session?.site.region ?? ''}
        </span>
        <span className="dash4-iso" title="Virginia is in PJM ISO">PJM ISO · DOM</span>
        {session && (
          <select className="dash4-scenario" value={session.scenario} onChange={(e) => changeScenario(e.target.value as Scenario)}>
            {scenarioOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        )}
        <div className="dash4-actions">
          <button type="button" className="dash4-reset" onClick={resetLayout} title="Reset layout">↺</button>
          <a className="hdr-btn" href="/grid-sensor">Sensors</a>
          <a className="hdr-btn hdr-btn--primary" href="/join">Join →</a>
        </div>
      </header>

      <section className="dash4-map">
        <GridMap session={session} />
        {session && <small className="dash4-map__brief">{scenarioBrief(session.scenario)}</small>}
      </section>

      <PjmStatus />

      <div className={`dash4-grid ${dragId ? 'dash4-grid--dragging' : ''}`}>
        {layout.order.map((id) => {
          const meta = panelMap[id];
          if (!meta) return null;
          const collapsed = !!layout.collapsed[id];
          const onToggle = () =>
            setLayout({ ...layout, collapsed: { ...layout.collapsed, [id]: !collapsed } });
          const isHover = hoverId === id && dragId !== id;
          const isDrag = dragId === id;
          return (
            <div
              key={id}
              className={`dash4-slot dash4-slot--${id} ${isHover ? 'is-hover' : ''} ${isDrag ? 'is-drag' : ''}`}
              data-panel-id={id}
            >
              <DashPanel
                id={id}
                eyebrow={meta.eyebrow}
                title={meta.title}
                collapsed={collapsed}
                onToggle={onToggle}
                onDragStart={handlers.onDragStart}
                onDragOver={handlers.onDragOver}
                onDragEnd={handlers.onDragEnd}
              >
                {meta.node}
              </DashPanel>
            </div>
          );
        })}
        {ghost && (
          <div
            className="dash4-ghost"
            style={{ left: ghost.x, top: ghost.y, width: ghost.w }}
          >
            moving…
          </div>
        )}
      </div>
    </main>
  );
}
