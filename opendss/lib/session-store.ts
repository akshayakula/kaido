import { Redis } from '@upstash/redis';
import { createSessionWithId, normalizeSession } from './simulation';
import type { DemoSession, SessionSummary } from './types';

const SESSION_TTL_SECONDS = 60 * 60 * 4;
const ACTIVE_KEY = 'sessions:active';
export const DEFAULT_SESSION_ID = 'default';
const memory = new Map<string, { session: DemoSession; expiresAt: number }>();

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export async function saveSession(session: DemoSession) {
  session.updatedAt = Date.now();
  if (redis) {
    await redis.set(sessionKey(session.id), session, { ex: SESSION_TTL_SECONDS });
    await redis.zadd(ACTIVE_KEY, { score: session.updatedAt, member: session.id });
    return;
  }
  memory.set(session.id, { session: structuredClone(session), expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
}

export async function getSession(id: string) {
  if (redis) {
    const session = await redis.get<DemoSession>(sessionKey(id));
    return session ? normalizeSession(session) : null;
  }
  cleanupMemory();
  return memory.get(id)?.session ? normalizeSession(structuredClone(memory.get(id)!.session)) : null;
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
    const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
    await redis.zremrangebyscore(ACTIVE_KEY, 0, cutoff);
    const ids = await redis.zrange<string[]>(ACTIVE_KEY, 0, -1, { rev: true });
    const sessions = await Promise.all(ids.map((id) => getSession(id)));
    return sessions.filter(Boolean).map((session) => summarize(session as DemoSession));
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

function cleanupMemory() {
  const now = Date.now();
  for (const [id, entry] of memory.entries()) {
    if (entry.expiresAt < now) memory.delete(id);
  }
}
