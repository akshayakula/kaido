import { Redis } from '@upstash/redis';
import { createSessionWithId, normalizeSession } from './simulation';
import type { AgentEvent, DataCenterAgent, DemoSession, GridState, SessionSummary } from './types';

const SESSION_TTL_SECONDS = 60 * 60 * 4;
const ACTIVE_KEY = 'sessions:active';
const EVENTS_CAP = 500;
const TICK_LOCK_SECONDS = 5;
export const DEFAULT_SESSION_ID = 'default';

const metaKey = (id: string) => `session:${id}:meta`;
const gridKey = (id: string) => `session:${id}:grid`;
const dcsKey = (id: string) => `session:${id}:dcs`;
const eventsKey = (id: string) => `session:${id}:events`;
const tickLockKey = (id: string) => `session:${id}:tick:lock`;
const legacyKey = (id: string) => `session:${id}:state`;

type MetaBlob = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  tick: number;
  running: boolean;
  scenario: DemoSession['scenario'];
  site: DemoSession['site'];
};

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
    console.warn('[session-store] failed to init Upstash client:', err);
    redis = null;
  }
}

export type SessionStoreHealth = {
  configured: boolean;
  mode: 'upstash' | 'unconfigured' | 'unreachable';
  ok: boolean;
  host: string | null;
  ping?: string;
  roundTrip?: boolean;
  activeSessions?: number;
  error?: string;
};

function splitMeta(session: DemoSession): MetaBlob {
  return {
    id: session.id,
    label: session.label,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tick: session.tick,
    running: session.running,
    scenario: session.scenario,
    site: session.site,
  };
}

function assemble(meta: MetaBlob, grid: GridState | null, dcs: DataCenterAgent[], events: AgentEvent[]): DemoSession {
  return normalizeSession({
    ...meta,
    grid: grid ?? ({ } as GridState),
    datacenters: dcs,
    events,
  });
}

export async function getSession(id: string): Promise<DemoSession | null> {
  if (!redis) return null;

  const pipe = redis.pipeline();
  pipe.get<MetaBlob>(metaKey(id));
  pipe.get<GridState>(gridKey(id));
  pipe.hgetall<Record<string, DataCenterAgent>>(dcsKey(id));
  pipe.lrange<AgentEvent>(eventsKey(id), 0, -1);
  const [meta, grid, dcsHash, events] = (await pipe.exec()) as [
    MetaBlob | null,
    GridState | null,
    Record<string, DataCenterAgent> | null,
    AgentEvent[] | null,
  ];

  if (meta) {
    const dcs = dcsHash ? Object.values(dcsHash) : [];
    return assemble(meta, grid, dcs, events ?? []);
  }

  // One-shot migration from legacy `session:{id}:state` blob.
  const legacy = await redis.get<DemoSession>(legacyKey(id));
  if (!legacy) return null;
  const normalized = normalizeSession(legacy);
  await commitSession(id, normalized, {
    meta: true,
    grid: true,
    dcIdsToWrite: normalized.datacenters.map((dc) => dc.id),
    eventsToAppend: normalized.events,
    bumpActive: true,
  });
  await redis.del(legacyKey(id));
  return normalized;
}

export async function getDefaultSession(): Promise<DemoSession | null> {
  return getSession(DEFAULT_SESSION_ID);
}

// Returns 1 if the field existed and was overwritten, 0 if it was absent (no write).
const HSET_IF_EXISTS_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;

export type CommitIntent = {
  /** Write meta blob (any meta field changed: tick, scenario, running, updatedAt, label, site). */
  meta?: boolean;
  /** Write grid blob. */
  grid?: boolean;
  /** DC ids whose hash field should be written. Use HSET-if-exists semantics: deleted DCs stay deleted. */
  dcIdsToWrite?: string[];
  /** DC ids that are brand-new (use plain HSET — they don't exist yet). */
  dcIdsToCreate?: string[];
  /** Events to RPUSH in order. */
  eventsToAppend?: AgentEvent[];
  /** Update sessions:active sorted set with current updatedAt. Default true if `meta` is true. */
  bumpActive?: boolean;
};

export async function commitSession(id: string, session: DemoSession, intent: CommitIntent): Promise<void> {
  if (!redis) {
    throw new Error('Upstash Redis not configured: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN');
  }
  session.updatedAt = Date.now();

  const ops: Promise<unknown>[] = [];
  const dcsHashKey = dcsKey(id);

  if (intent.meta) {
    ops.push(redis.set(metaKey(id), splitMeta(session), { ex: SESSION_TTL_SECONDS }));
  }
  if (intent.grid) {
    ops.push(redis.set(gridKey(id), session.grid, { ex: SESSION_TTL_SECONDS }));
  }
  if (intent.dcIdsToCreate?.length) {
    for (const dcId of intent.dcIdsToCreate) {
      const dc = session.datacenters.find((d) => d.id === dcId);
      if (!dc) continue;
      ops.push(redis.hset(dcsHashKey, { [dcId]: dc }));
    }
    ops.push(redis.expire(dcsHashKey, SESSION_TTL_SECONDS));
  }
  if (intent.dcIdsToWrite?.length) {
    for (const dcId of intent.dcIdsToWrite) {
      const dc = session.datacenters.find((d) => d.id === dcId);
      if (!dc) continue;
      ops.push(
        redis.eval(HSET_IF_EXISTS_LUA, [dcsHashKey], [dcId, JSON.stringify(dc)]),
      );
    }
  }
  if (intent.eventsToAppend?.length) {
    const eKey = eventsKey(id);
    ops.push(redis.rpush(eKey, ...intent.eventsToAppend));
    ops.push(redis.ltrim(eKey, -EVENTS_CAP, -1));
    ops.push(redis.expire(eKey, SESSION_TTL_SECONDS));
  }
  const wantBump = intent.bumpActive ?? Boolean(intent.meta);
  if (wantBump) {
    ops.push(redis.zadd(ACTIVE_KEY, { score: session.updatedAt, member: id }));
  }

  await Promise.all(ops);
}

export async function removeDc(id: string, dcId: string): Promise<void> {
  if (!redis) return;
  await redis.hdel(dcsKey(id), dcId);
}

export async function withTickLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!redis) return { ran: false };
  const acquired = await redis.set(tickLockKey(id), '1', { nx: true, ex: TICK_LOCK_SECONDS });
  if (acquired !== 'OK') return { ran: false };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await redis.del(tickLockKey(id)).catch(() => undefined);
  }
}

export async function createDefaultSession(): Promise<DemoSession> {
  const session = createSessionWithId(DEFAULT_SESSION_ID);
  await commitSession(DEFAULT_SESSION_ID, session, {
    meta: true,
    grid: true,
    dcIdsToCreate: session.datacenters.map((dc) => dc.id),
    eventsToAppend: session.events,
  });
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

export async function listSessions(): Promise<SessionSummary[]> {
  if (!redis) return [];
  const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
  await redis.zremrangebyscore(ACTIVE_KEY, 0, cutoff);
  const ids = await redis.zrange<string[]>(ACTIVE_KEY, 0, -1, { rev: true });
  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  return sessions.filter(Boolean).map((session) => summarize(session as DemoSession));
}

export async function getSessionStoreHealth(): Promise<SessionStoreHealth> {
  const host = (() => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    if (!url) return null;
    try { return new URL(url).hostname; } catch { return 'invalid-url'; }
  })();
  if (!redis) return { configured: false, mode: 'unconfigured', ok: false, host };
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
      mode: 'unreachable',
      ok: false,
      host,
      error: error instanceof Error ? error.message : 'Unknown Upstash error',
    };
  }
}
