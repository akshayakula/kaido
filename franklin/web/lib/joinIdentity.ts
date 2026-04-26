/**
 * Tiny helper for the participant-side identity stored in localStorage:
 * "I am acting as data center X in session Y".
 *
 * - Set on /join after a successful POST.
 * - Read on /join and on /session/.../datacenter to skip the form,
 *   restore the participant view after a refresh, or detect that the
 *   operator deleted the DC and clear the stale entry.
 */

export type JoinIdentity = { sessionId: string; datacenterId: string; displayName?: string };

function idKey(sessionId: string) { return `dc:${sessionId}`; }
function nameKey(sessionId: string) { return `dc:${sessionId}:name`; }

export function loadJoinIdentity(sessionId: string): JoinIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const dcId = window.localStorage.getItem(idKey(sessionId));
    if (!dcId) return null;
    const displayName = window.localStorage.getItem(nameKey(sessionId)) ?? undefined;
    return { sessionId, datacenterId: dcId, displayName };
  } catch {
    return null;
  }
}

export function saveJoinIdentity(sessionId: string, datacenterId: string, displayName?: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(idKey(sessionId), datacenterId);
    if (displayName) window.localStorage.setItem(nameKey(sessionId), displayName);
  } catch { /* quota / private mode */ }
}

export function clearJoinIdentity(sessionId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(idKey(sessionId));
    window.localStorage.removeItem(nameKey(sessionId));
  } catch { /* ignore */ }
}
