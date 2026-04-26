'use client';

import { useEffect, useMemo, useState } from 'react';
import { GridMap } from '@/components/GridMap';
import { PjmStatus } from '@/components/PjmStatus';
import { OpenDssPanel } from '@/components/dash/OpenDssPanel';
import { AnalogReadouts } from '@/components/dash/AnalogReadouts';
import { A2APanel } from '@/components/dash/A2APanel';
import { JoinPanel } from '@/components/dash/JoinPanel';
import { PjmPanel } from '@/components/dash/PjmPanel';
import { useDashLayout, useDragSwap } from '@/components/dash/DashGrid';
import { clearLayout } from '@/lib/dashLayout';
import type { DemoSession, Scenario } from '@/lib/types';
import { scenarioOptions } from '@/lib/scenarios';

const DEFAULT_SESSION_ID = 'default';
const PANEL_IDS = ['opendss', 'readouts', 'a2a', 'pjm', 'join'] as const;
const DEFAULT_ORDER: string[] = [...PANEL_IDS];

const PANEL_ICONS: Record<string, string> = {
  opendss:  '⚡',
  readouts: '◐',
  a2a:      '◌',
  pjm:      '⚙',
  join:     '+',
};
const PANEL_LABELS: Record<string, string> = {
  opendss:  'Electrical layout',
  readouts: 'Capacity & health',
  a2a:      'A2A chat',
  pjm:      'PJM ISO live',
  join:     'Upstash data centers',
};

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
      pjm: {
        eyebrow: 'PJM ISO · gridstatus.io',
        title: 'Live load & fuel mix',
        node: <PjmPanel />,
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

  // Visibility — X to hide, dropdown to bring back.
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PANEL_IDS.map((id) => [id, true])),
  );
  const [visHydrated, setVisHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('dash4:vis');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        setVisible((cur) => ({ ...cur, ...parsed }));
      }
    } catch { /* ignore */ }
    setVisHydrated(true);
  }, []);
  useEffect(() => {
    if (!visHydrated) return;
    try { window.localStorage.setItem('dash4:vis', JSON.stringify(visible)); } catch { /* ignore */ }
  }, [visible, visHydrated]);
  const closePanel = (id: string) => setVisible((v) => ({ ...v, [id]: false }));
  const togglePanelVis = (id: string) => setVisible((v) => ({ ...v, [id]: !v[id] }));
  const allHidden = PANEL_IDS.every((id) => !visible[id]);
  const toggleAllPanels = () => {
    const next = allHidden;
    setVisible(Object.fromEntries(PANEL_IDS.map((id) => [id, next])));
  };

  function resetLayout() {
    clearLayout();
    setLayout({ order: DEFAULT_ORDER, collapsed: {} });
    applyDefaultPositions();
  }

  // Approximate panel widths/heights — used for the non-overlapping default layout.
  const PANEL_SIZE: Record<string, { w: number; h: number }> = {
    opendss:  { w: 420, h: 340 },
    readouts: { w: 320, h: 300 },
    a2a:      { w: 380, h: 420 },
    pjm:      { w: 320, h: 340 },
    join:     { w: 340, h: 360 },
  };

  function computeDefaults(viewportW: number, viewportH: number) {
    const M = 18;
    const HUD_OFFSET = 64;
    const w = viewportW;
    const h = viewportH;
    const sz = PANEL_SIZE;

    return {
      opendss:  { left: M,                                                 top: HUD_OFFSET },
      readouts: { left: Math.max(M, w - sz.readouts.w - M),                top: HUD_OFFSET },
      pjm:      { left: Math.max(M, w - sz.pjm.w - M),                     top: Math.max(HUD_OFFSET + sz.readouts.h + 10, h - sz.pjm.h - M) },
      a2a:      { left: M,                                                 top: Math.max(HUD_OFFSET + sz.opendss.h + 10, h - sz.a2a.h - M) },
      join:     { left: Math.max(M, (w - sz.join.w) / 2),                  top: Math.max(HUD_OFFSET + 24, h - sz.join.h - M) },
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
            <CyberDropdown
              label="scenario"
              value={session.scenario}
              options={scenarioOptions.map((s) => ({ value: s.value, label: s.label }))}
              onChange={(v) => changeScenario(v as Scenario)}
            />
          )}
          <PanelsDropdown
            order={DEFAULT_ORDER}
            visible={visible}
            labels={PANEL_LABELS}
            icons={PANEL_ICONS}
            onToggle={togglePanelVis}
          />
          <button type="button" className="dash4-default" onClick={applyDefaultPositions} title="Default view (no overlap)">
            <span aria-hidden="true">◇</span>Default
          </button>
          <button
            type="button"
            className={`dash4-default ${allHidden ? 'dash4-default--off' : ''}`}
            onClick={toggleAllPanels}
            title={allHidden ? 'Show all panels' : 'Hide all panels'}
            aria-pressed={allHidden}
          >
            <span aria-hidden="true">{allHidden ? '◉' : '○'}</span>{allHidden ? 'Show all' : 'Hide all'}
          </button>
          <button type="button" className="dash4-reset" onClick={resetLayout} title="Reset layout">↺</button>
          <a className="dash4-link" href="/grid-sensor" title="Open Franklin sensors">
            <span aria-hidden="true">◉</span>Sensors
          </a>
          <a className="dash4-link" href="/grid" title="PJM live + OpenDSS deep-dive">
            <span aria-hidden="true">⚡</span>Grid
          </a>
          <a className="dash4-link dash4-link--accent" href="/join">Join →</a>
        </div>

        {posHydrated && layout.order.map((id) => {
          if (!visible[id]) return null;
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
              onClose={() => closePanel(id)}
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
  onClose,
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
  onClose?: () => void;
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
        <div className="fpanel__actions">
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
          {onClose && (
            <button
              type="button"
              className="fpanel__close"
              aria-label="Close panel"
              onClick={onClose}
              title="Close (re-open from Panels menu)"
            >
              ×
            </button>
          )}
        </div>
      </header>
      <div className="fpanel__body">
        <div className="fpanel__body-inner">{children}</div>
      </div>
    </section>
  );
}

// --- Cyber-styled dropdown for the scenario selector ---
function CyberDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.cyberd')) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className={`cyberd ${open ? 'cyberd--open' : ''}`}>
      <button type="button" className="cyberd__btn" onClick={() => setOpen((v) => !v)}>
        <span className="cyberd__lbl">{label}</span>
        <span className="cyberd__val">{current?.label ?? value}</span>
        <span className="cyberd__chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="cyberd__menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`cyberd__opt ${o.value === value ? 'cyberd__opt--on' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="cyberd__opt-mark" aria-hidden="true">{o.value === value ? '◉' : '○'}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Panels dropdown (icons; click to toggle visibility) ---
function PanelsDropdown({
  order,
  visible,
  labels,
  icons,
  onToggle,
}: {
  order: string[];
  visible: Record<string, boolean>;
  labels: Record<string, string>;
  icons: Record<string, string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hiddenCount = order.filter((id) => !visible[id]).length;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.cyberd')) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className={`cyberd cyberd--panels ${open ? 'cyberd--open' : ''}`}>
      <button type="button" className="cyberd__btn" onClick={() => setOpen((v) => !v)} title="Show or hide panels">
        <span className="cyberd__lbl">panels</span>
        <span className="cyberd__val">{order.length - hiddenCount}/{order.length}</span>
        <span className="cyberd__chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="cyberd__menu" role="menu">
          {order.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={!!visible[id]}
              className={`cyberd__opt ${visible[id] ? 'cyberd__opt--on' : 'cyberd__opt--off'}`}
              onClick={() => onToggle(id)}
            >
              <span className="cyberd__icon" aria-hidden="true">{icons[id] ?? '·'}</span>
              <span className="cyberd__opt-text">{labels[id] ?? id}</span>
              <span className="cyberd__check" aria-hidden="true">{visible[id] ? '●' : '○'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
