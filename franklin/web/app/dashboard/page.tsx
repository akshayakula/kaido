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
    applyDefaultPositions();
  }

  // Approximate panel widths/heights — used for the non-overlapping default layout.
  const PANEL_SIZE: Record<string, { w: number; h: number }> = {
    opendss:  { w: 420, h: 360 },
    readouts: { w: 320, h: 320 },
    a2a:      { w: 380, h: 480 },
    join:     { w: 340, h: 360 },
  };

  function computeDefaults(viewportW: number, viewportH: number) {
    const M = 18;
    const HUD_OFFSET = 64;
    const w = viewportW;
    const h = viewportH;
    const opendss  = PANEL_SIZE.opendss;
    const readouts = PANEL_SIZE.readouts;
    const a2a      = PANEL_SIZE.a2a;
    const join     = PANEL_SIZE.join;

    return {
      opendss:  { left: M,                                  top: HUD_OFFSET },
      readouts: { left: Math.max(M, w - readouts.w - M),    top: HUD_OFFSET },
      a2a:      { left: M,                                  top: Math.max(HUD_OFFSET + opendss.h + 12, h - a2a.h - M) },
      join:     { left: Math.max(M, w - join.w - M),        top: Math.max(HUD_OFFSET + readouts.h + 12, h - join.h - M) },
    } as Record<string, { left: number; top: number }>;
  }

  // positions live in parent state (single source of truth — drag math is simple).
  const [positions, setPositions] = useState<Record<string, { left: number; top: number }>>({});
  const [posHydrated, setPosHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const defaults = computeDefaults(window.innerWidth, window.innerHeight);
    let next: Record<string, { left: number; top: number }> = { ...defaults };
    try {
      const raw = window.localStorage.getItem('dash4:pos:all');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { left: number; top: number }>;
        next = { ...defaults, ...parsed };
      }
    } catch { /* ignore */ }
    setPositions(next);
    setPosHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!posHydrated) return;
    try { window.localStorage.setItem('dash4:pos:all', JSON.stringify(positions)); } catch { /* ignore */ }
  }, [positions, posHydrated]);

  function applyDefaultPositions() {
    if (typeof window === 'undefined') return;
    const defaults = computeDefaults(window.innerWidth, window.innerHeight);
    setPositions(defaults);
    setLayout({ order: DEFAULT_ORDER, collapsed: {} });
    try { window.localStorage.removeItem('dash4:pos:all'); } catch { /* ignore */ }
  }

  function setPanelPos(id: string, p: { left: number; top: number }) {
    setPositions((prev) => ({ ...prev, [id]: p }));
  }

  return (
    <main className="dashboard-screen v4">
      <div className="dash4-mapbg">
        <GridMap session={session} />
      </div>

      <div className="dash4-overlay">
        <div className="dash4-hud">
          <a className="dash4-brand" href="/" aria-label="Franklin home">FRANKLIN</a>
          <span className="dash4-status" data-health={session?.grid.health ?? 'normal'}>
            <i />{session?.grid.health?.toUpperCase() ?? '…'} · {session?.site.region ?? ''}
          </span>
          <span className="dash4-iso" title="Virginia is in PJM ISO">PJM · DOM</span>
          {session && (
            <select className="dash4-scenario" value={session.scenario} onChange={(e) => changeScenario(e.target.value as Scenario)}>
              {scenarioOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          )}
          <button type="button" className="dash4-default" onClick={applyDefaultPositions} title="Default view (no overlap)">Default</button>
          <button type="button" className="dash4-reset" onClick={resetLayout} title="Reset layout">↺</button>
          <a className="dash4-link" href="/join">Join →</a>
        </div>

        {posHydrated && layout.order.map((id) => {
          const meta = panelMap[id];
          if (!meta) return null;
          const collapsed = !!layout.collapsed[id];
          const onToggle = () =>
            setLayout({ ...layout, collapsed: { ...layout.collapsed, [id]: !collapsed } });
          const pos = positions[id] ?? { left: 18, top: 64 };
          return (
            <FloatingPanel
              key={id}
              id={id}
              eyebrow={meta.eyebrow}
              title={meta.title}
              collapsed={collapsed}
              onToggle={onToggle}
              pos={pos}
              onPosChange={(p) => setPanelPos(id, p)}
              isDragging={dragId === id}
              onDragStart={handlers.onDragStart}
              onDragEnd={handlers.onDragEnd}
            >
              {meta.node}
            </FloatingPanel>
          );
        })}
      </div>
    </main>
  );
}

// --- Floating panel (free-drag, collapsible, transparent over map) ---
function FloatingPanel({
  id,
  eyebrow,
  title,
  collapsed,
  onToggle,
  pos,
  onPosChange,
  isDragging,
  onDragStart,
  onDragEnd,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  pos: { left: number; top: number };
  onPosChange: (p: { left: number; top: number }) => void;
  isDragging: boolean;
  onDragStart: (id: string, rect: DOMRect) => void;
  onDragEnd: () => void;
  children: React.ReactNode;
}) {
  function handlePointerDown(e: React.PointerEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [data-no-drag]')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...pos };
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onDragStart(id, rect);

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const next = {
        left: start.left + dx,
        top: start.top + dy,
      };
      // Clamp inside viewport (keep at least 40px on screen).
      const maxLeft = window.innerWidth - 40;
      const maxTop = window.innerHeight - 40;
      next.left = Math.max(-rect.width + 80, Math.min(maxLeft, next.left));
      next.top = Math.max(0, Math.min(maxTop, next.top));
      onPosChange(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onDragEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const style: React.CSSProperties = {
    left: pos.left,
    top: pos.top,
  };

  return (
    <section
      className={`fpanel ${collapsed ? 'fpanel--collapsed' : ''} ${isDragging ? 'fpanel--dragging' : ''}`}
      style={style}
      data-panel-id={id}
      role="region"
      aria-label={title}
    >
      <header className="fpanel__head" onPointerDown={handlePointerDown}>
        <div className="fpanel__title">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="fpanel__chev"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          onClick={onToggle}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M3 5 L6 8 L9 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transformOrigin: 'center', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(.2,.8,.2,1)' }}
            />
          </svg>
        </button>
      </header>
      <div className="fpanel__body">
        <div className="fpanel__body-inner">{children}</div>
      </div>
    </section>
  );
}
