export type PanelState = { id: string; collapsed: boolean };
export type DashLayoutState = { order: string[]; collapsed: Record<string, boolean> };

const STORAGE_KEY = 'dash:layout:v4';

export function loadLayout(defaultOrder: string[]): DashLayoutState {
  if (typeof window === 'undefined') return { order: defaultOrder, collapsed: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { order: defaultOrder, collapsed: {} };
    const parsed = JSON.parse(raw) as Partial<DashLayoutState>;
    const knownIds = new Set(defaultOrder);
    const order = (parsed.order ?? []).filter((id) => knownIds.has(id));
    for (const id of defaultOrder) if (!order.includes(id)) order.push(id);
    return { order, collapsed: parsed.collapsed ?? {} };
  } catch {
    return { order: defaultOrder, collapsed: {} };
  }
}

export function saveLayout(state: DashLayoutState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — ignore */
  }
}

export function clearLayout() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
