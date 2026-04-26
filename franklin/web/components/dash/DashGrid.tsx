'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadLayout, saveLayout, type DashLayoutState } from '@/lib/dashLayout';

type DashGridChild = { id: string; node: ReactNode };

type DashGridProps = {
  panels: DashGridChild[];
  defaultOrder: string[];
  defaultCollapsed?: Record<string, boolean>;
  onLayoutChange?: (layout: DashLayoutState) => void;
  /** Pass children-render function for full control */
  renderPanel?: (id: string, ctx: { collapsed: boolean; onToggle: () => void; dragHandlers: DragHandlers }) => ReactNode;
};

export type DragHandlers = {
  onDragStart: (id: string, rect: DOMRect) => void;
  onDragOver: (id: string) => void;
  onDragEnd: () => void;
};

export function useDashLayout(defaultOrder: string[], defaultCollapsed: Record<string, boolean> = {}) {
  const [layout, setLayout] = useState<DashLayoutState>(() => ({ order: defaultOrder, collapsed: defaultCollapsed }));
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const persisted = loadLayout(defaultOrder);
    setLayout({
      order: persisted.order,
      collapsed: { ...defaultCollapsed, ...persisted.collapsed },
    });
  }, [defaultOrder, defaultCollapsed]);

  useEffect(() => {
    if (!initialized.current) return;
    saveLayout(layout);
  }, [layout]);

  return { layout, setLayout };
}

/** Hook that wires drag-to-swap behavior for a list of panel IDs. */
export function useDragSwap(layout: DashLayoutState, setLayout: (next: DashLayoutState) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number; label: string } | null>(null);

  useEffect(() => {
    if (!dragId) return;
    const move = (e: PointerEvent) => {
      setGhost((g) => (g ? { ...g, x: e.clientX - g.w / 2, y: e.clientY - 16 } : g));
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const panel = el?.closest('[data-panel-id]') as HTMLElement | null;
      if (panel) setHoverId(panel.dataset.panelId ?? null);
    };
    const up = () => {
      if (dragId && hoverId && dragId !== hoverId) {
        const order = [...layout.order];
        const a = order.indexOf(dragId);
        const b = order.indexOf(hoverId);
        if (a !== -1 && b !== -1) {
          [order[a], order[b]] = [order[b], order[a]];
          setLayout({ ...layout, order });
        }
      }
      setDragId(null);
      setHoverId(null);
      setGhost(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragId, hoverId, layout, setLayout]);

  const handlers: DragHandlers = useMemo(
    () => ({
      onDragStart: (id, rect) => {
        setDragId(id);
        setGhost({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, label: id });
      },
      onDragOver: (id) => setHoverId(id),
      onDragEnd: () => {
        setDragId(null);
        setHoverId(null);
        setGhost(null);
      },
    }),
    []
  );

  return { dragId, hoverId, ghost, handlers };
}

export function DashGrid({ panels, defaultOrder, defaultCollapsed, onLayoutChange, renderPanel }: DashGridProps) {
  const { layout, setLayout } = useDashLayout(defaultOrder, defaultCollapsed);
  const { dragId, hoverId, ghost, handlers } = useDragSwap(layout, (next) => {
    setLayout(next);
    onLayoutChange?.(next);
  });

  const map = new Map(panels.map((p) => [p.id, p.node] as const));

  return (
    <div className={`dash-grid ${dragId ? 'dash-grid--dragging' : ''}`}>
      {layout.order.map((id) => {
        const collapsed = !!layout.collapsed[id];
        const onToggle = () => setLayout({ ...layout, collapsed: { ...layout.collapsed, [id]: !collapsed } });
        const isHover = hoverId === id && dragId !== id;
        const isDrag = dragId === id;
        return (
          <div
            key={id}
            className={`dash-slot ${collapsed ? 'dash-slot--collapsed' : ''} ${isHover ? 'dash-slot--hover' : ''} ${isDrag ? 'dash-slot--dragging' : ''}`}
            data-slot-id={id}
          >
            {renderPanel
              ? renderPanel(id, { collapsed, onToggle, dragHandlers: handlers })
              : map.get(id)}
          </div>
        );
      })}
      {ghost && (
        <div
          className="dash-grid__ghost"
          style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: 32 }}
        >
          {ghost.label}
        </div>
      )}
    </div>
  );
}
