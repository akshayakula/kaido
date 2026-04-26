// Resolve the URL of the franklin Flask server (the thing that talks to Lambda).
// Default port matches `franklin/server/app.py`'s deterministic-port convention
// for this kaido checkout.
export const FRANKLIN_SERVER_URL =
  process.env.FRANKLIN_SERVER_URL ?? 'http://127.0.0.1:3782';

const FRANKLIN_API_TOKEN = process.env.FRANKLIN_API_TOKEN ?? '';

/** Headers that authenticate against the Flask server when a token is set. */
export function franklinAuthHeaders(): Record<string, string> {
  return FRANKLIN_API_TOKEN ? { authorization: `Bearer ${FRANKLIN_API_TOKEN}` } : {};
}

/** Build a URL targeting the Flask server, including ?token= for endpoints
 * we stream raw bodies through (SSE, audio files) — useful when we can't
 * easily inject an auth header on the upstream side. */
export function franklinUrl(path: string): string {
  const base = FRANKLIN_SERVER_URL.replace(/\/$/, '');
  if (!FRANKLIN_API_TOKEN) return `${base}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${path}${sep}token=${encodeURIComponent(FRANKLIN_API_TOKEN)}`;
}
