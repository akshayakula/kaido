'use client';

import { useRef, type ReactNode } from 'react';

type DashPanelProps = {
  id: string;
  title: string;
  eyebrow?: string;
  collapsed: boolean;
  onToggle: () => void;
  onDragStart?: (id: string, rect: DOMRect) => void;
  onDragOver?: (id: string) => void;
  onDragEnd?: () => void;
  draggable?: boolean;
  actions?: ReactNode;
  children: ReactNode;
};

export function DashPanel({
  id,
  title,
  eyebrow,
  collapsed,
  onToggle,
  onDragStart,
  onDragOver,
  onDragEnd,
  draggable = true,
  actions,
  children,
}: DashPanelProps) {
  const ref = useRef<HTMLElement>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLElement>) {
    if (!draggable || !onDragStart || !ref.current) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [data-no-drag]')) return;
    if (e.pointerType === 'touch' && !target.closest('[data-drag-handle]')) return;
    e.preventDefault();
    onDragStart(id, ref.current.getBoundingClientRect());
  }

  function handlePointerEnter() {
    onDragOver?.(id);
  }

  function handlePointerUp() {
    onDragEnd?.();
  }

  return (
    <section
      ref={ref}
      className={`dash-panel ${collapsed ? 'dash-panel--collapsed' : ''}`}
      data-panel-id={id}
      onPointerEnter={handlePointerEnter}
      onPointerUp={handlePointerUp}
      role="region"
      aria-label={title}
    >
      <header
        className="dash-panel__head"
        data-drag-handle
        onPointerDown={handlePointerDown}
      >
        <div className="dash-panel__title">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        <div className="dash-panel__actions">
          {actions}
          <button
            type="button"
            className="dash-panel__chev"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            onClick={onToggle}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 5 L7 9 L11 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transformOrigin: 'center', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(.2,.8,.2,1)' }}
              />
            </svg>
          </button>
        </div>
      </header>
      <div className="dash-panel__body">
        <div className="dash-panel__body-inner">{children}</div>
      </div>
    </section>
  );
}
