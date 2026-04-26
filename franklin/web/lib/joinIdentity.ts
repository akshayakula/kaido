/**
 * Tiny helper for the participant-side identity stored in localStorage:
 * "I am acting as data center X in session Y".
 *
 * - Set on /join after a successful POST.
 * - Read on /join and on /session/.../datacenter to skip the form,
 *   restore the participant view after a refresh, or detect that the
 *   operator deleted the DC and clear the stale entry.
 */

export type JoinIdentity = { sessionId: string; datacenterId: string };

function key(sessionId: string) {
  return `dc:${sessionId}`;
}

export function loadJoinIdentity(sessionId: string): JoinIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const dcId = window.localStorage.getItem(key(sessionId));
    if (!dcId) return null;
    return { sessionId, datacenterId: dcId };
  } catch {
    return null;
  }
}

export function saveJoinIdentity(sessionId: string, datacenterId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(sessionId), datacenterId);
  } catch { /* quota / private mode */ }
}

export function clearJoinIdentity(sessionId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key(sessionId));
  } catch { /* ignore */ }
}
