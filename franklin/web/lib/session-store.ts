import { Redis } from '@upstash/redis';
import { createSessionWithId, normalizeSession } from './simulation';
import type { DemoSession, SessionSummary } from './types';

const SESSION_TTL_SECONDS = 60 * 60 * 4;
const ACTIVE_KEY = 'sessions:active';
export const DEFAULT_SESSION_ID = 'default';
const memory = new Map<string, { session: DemoSession; expiresAt: number }>();

function normalizeUpstashUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

const _upstashUrl = normalizeUpstashUrl(process.env.UPSTASH_REDIS_REST_URL);
const _upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

let redis: Redis | null = null;
if (_upstashUrl && _upstashToken) {
  try {
    redis = new Redis({ url: _upstashUrl, token: _upstashToken });
  } catch (err) {
    console.warn('[session-store] failed to init Upstash client; falling back to memory:', err);
    redis = null;
  }
}

export type SessionStoreHealth = {
  configured: boolean;
  mode: 'upstash' | 'memory' | 'memory-fallback';
  ok: boolean;
  host: string | null;
  ping?: string;
  roundTrip?: boolean;
  activeSessions?: number;
  error?: string;
};

export async function getSessionStoreHealth(): Promise<SessionStoreHealth> {
  const host = getUpstashHost();
  if (!redis) {
    return { configured: false, mode: 'memory', ok: true, host };
  }

  try {
    const key = `session-store-health:${crypto.randomUUID().slice(0, 10)}`;
    const ping = await redis.ping();
    await redis.set(key, { ok: true, at: Date.now() }, { ex: 60 });
    const roundTrip = await redis.get<{ ok: boolean; at: number }>(key);
    const activeSessions = await redis.zcard(ACTIVE_KEY).catch(() => undefined);
    return {
      configured: true,
      mode: 'upstash',
      ok: ping === 'PONG' && roundTrip?.ok === true,
      host,
      ping,
      roundTrip: roundTrip?.ok === true,
      activeSessions,
    };
  } catch (error) {
    return {
      configured: true,
      mode: 'memory-fallback',
      ok: false,
      host,
      error: error instanceof Error ? error.message : 'Unknown Upstash error',
    };
  }
}

export async function saveSession(session: DemoSession) {
  session.updatedAt = Date.now();
  memory.set(session.id, { session: structuredClone(session), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  if (redis) {
    try {
      await redis.set(sessionKey(session.id), session, { ex: SESSION_TTL_SECONDS });
      await redis.zadd(ACTIVE_KEY, { score: session.updatedAt, member: session.id });
      return;
    } catch (error) {
      console.warn('Redis unavailable; saving session in memory.', error);
    }
  }
}

export async function getSession(id: string) {
  cleanupMemory();
  const cached = memory.get(id)?.session;
  if (cached) return normalizeSession(structuredClone(cached));

  if (redis) {
    try {
      const session = await redis.get<DemoSession>(sessionKey(id));
      if (!session) return null;
      const normalized = normalizeSession(session);
      memory.set(id, { session: structuredClone(normalized), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
      return normalized;
    } catch (error) {
      console.warn('Redis unavailable; reading session from memory.', error);
    }
  }
  return null;
}

export async function getOrCreateDefaultSession() {
  const existing = await getSession(DEFAULT_SESSION_ID);
  if (existing) return existing;
  const session = createSessionWithId(DEFAULT_SESSION_ID);
  await saveSession(session);
  return session;
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (redis) {
    try {
      const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
      await redis.zremrangebyscore(ACTIVE_KEY, 0, cutoff);
      const ids = await redis.zrange<string[]>(ACTIVE_KEY, 0, -1, { rev: true });
      const sessions = await Promise.all(ids.map((id) => getSession(id)));
      return sessions.filter(Boolean).map((session) => summarize(session as DemoSession));
    } catch (error) {
      console.warn('Redis unavailable; listing in-memory sessions.', error);
    }
  }
  cleanupMemory();
  return [...memory.values()]
    .map((entry) => summarize(entry.session))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateSession(id: string, updater: (session: DemoSession) => void | Promise<void>) {
  const session = await getSession(id);
  if (!session) return null;
  await updater(session);
  await saveSession(session);
  return session;
}

export function summarize(session: DemoSession): SessionSummary {
  return {
    id: session.id,
    label: session.label,
    locationName: `${session.site.name}, ${session.site.region}`,
    health: session.grid.health,
    participantCount: session.datacenters.length,
    updatedAt: session.updatedAt,
  };
}

function sessionKey(id: string) {
  return `session:${id}:state`;
}

function getUpstashHost() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

function cleanupMemory() {
  const now = Date.now();
  for (const [id, entry] of memory.entries()) {
    if (entry.expiresAt < now) memory.delete(id);
  }
}
