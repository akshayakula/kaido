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
