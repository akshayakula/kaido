# Upstash session-store split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `session:{id}:state` Upstash blob into per-field keys (meta / grid / dcs hash / events list) so concurrent ticks, deletes, and chats can't clobber each other, and stop writing on read paths.

**Architecture:** Routes still mutate an in-memory `DemoSession` draft (so existing simulation/openai-agent code is untouched). At the end of each route, `commitSession(id, draft, intent)` writes only the affected keys via targeted helpers. Per-DC writes use a Lua `HSET-if-exists` so a DC deleted mid-tick stays deleted. Tick gets a 5s `SET NX` lock. Reads pipeline four Upstash ops and never write.

**Tech Stack:** Next.js 14 App Router, `@upstash/redis` ^1.35.3 (supports `eval` for Lua).

**Spec:** `franklin/web/docs/superpowers/specs/2026-04-26-upstash-session-split-design.md`

**Working directory for all paths below:** `franklin/web/`

---

## File structure

**Modify:**
- `lib/session-store.ts` — full rewrite. Public surface: `getSession`, `getDefaultSession`, `createDefaultSession`, `commitSession`, `withTickLock`, `removeDc`, `getSessionStoreHealth`, `listSessions`, `summarize`, `DEFAULT_SESSION_ID`, `SessionStoreHealth`. **Removed:** `saveSession`, `updateSession`, `getOrCreateDefaultSession`.
- `app/api/sessions/route.ts` — read-only GET; explicit POST.
- `app/api/sessions/[sessionId]/tick/route.ts` — wrap in `withTickLock`, swap to `commitSession`.
- `app/api/sessions/[sessionId]/scenario/route.ts` — `commitSession`.
- `app/api/sessions/[sessionId]/chat/route.ts` — `commitSession`.
- `app/api/sessions/[sessionId]/datacenters/route.ts` — `commitSession` with `createdDcIds`.
- `app/api/sessions/[sessionId]/datacenters/[datacenterId]/route.ts` — `removeDc` + `commitSession`.
- `app/api/sessions/[sessionId]/datacenters/[datacenterId]/chat/route.ts` — `commitSession` with single `dcIds: [id]`.
- `app/api/sessions/[sessionId]/datacenters/[datacenterId]/override/route.ts` — same.
- `app/api/sessions/[sessionId]/datacenters/[datacenterId]/request/route.ts` — same.
- `app/join/JoinClient.tsx` — tolerate `{ session: null }` with auto-bootstrap.
- `app/dashboard/page.tsx` — same.

**Create:**
- `scripts/verify-session-split.mjs` — node script that exercises the race conditions against the configured Upstash and prints PASS/FAIL.

**No changes:** `lib/simulation.ts`, `lib/openai-agent.ts`, `lib/types.ts`, `app/api/sessions/[sessionId]/state/route.ts` (its current 404 behavior is already correct).

---

## Task 1: Rewrite `lib/session-store.ts` — read-only helpers + key layout constants

**Files:**
- Modify: `lib/session-store.ts` (full rewrite)

- [ ] **Step 1: Replace the file with the new module skeleton**

Replace the entire contents of `lib/session-store.ts` with:

```ts
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
```

- [ ] **Step 2: Add `getSession` (read-only, pipelined, with legacy migration)**

Append to `lib/session-store.ts`:

```ts
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
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | head -30`
Expected: errors only about missing `commitSession` (added in Task 2). No syntax errors in the file itself.

- [ ] **Step 4: Commit**

```bash
git add franklin/web/lib/session-store.ts
git commit -m "franklin/web: session-store — key layout constants + read-only getSession"
```

---

## Task 2: Add `commitSession`, `withTickLock`, `createDefaultSession`, `removeDc`

**Files:**
- Modify: `lib/session-store.ts`

- [ ] **Step 1: Add the Lua script for `HSET-if-exists` and the writer helpers**

Append to `lib/session-store.ts`:

```ts
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
```

- [ ] **Step 2: Add `summarize`, `listSessions`, `getSessionStoreHealth`**

Append to `lib/session-store.ts`:

```ts
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
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | grep "session-store" | head -10`
Expected: no errors mentioning `lib/session-store.ts`. (Errors elsewhere — in routes that still import `updateSession` — are expected and fixed in Task 3+.)

- [ ] **Step 4: Commit**

```bash
git add franklin/web/lib/session-store.ts
git commit -m "franklin/web: session-store — commitSession, tick lock, removeDc, createDefaultSession"
```

---

## Task 3: Migrate `POST /api/sessions/[sessionId]/tick` route

**Files:**
- Modify: `app/api/sessions/[sessionId]/tick/route.ts`

- [ ] **Step 1: Replace the route with the new pattern**

Replace `app/api/sessions/[sessionId]/tick/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { appendPowerFlowResult, tickSession } from '@/lib/simulation';
import { addOpenAINegotiationEvent, runGridAllocatorToolCall } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, withTickLock } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(_: Request, { params }: { params: { sessionId: string } }) {
  const outcome = await withTickLock(params.sessionId, async () => {
    const session = await getSession(params.sessionId);
    if (!session) return null;
    const eventsBefore = session.events.length;

    tickSession(session);
    session.grid = await solveWithOpenDss(session, session.grid);
    appendPowerFlowResult(session);
    if (session.datacenters.length > 0 && session.tick % 8 === 0 && session.grid.health !== 'normal') {
      await addOpenAINegotiationEvent(session, { kind: 'grid_tick' });
      await runGridAllocatorToolCall(session, { kind: 'grid_tick' });
    }

    await commitSession(params.sessionId, session, {
      meta: true,
      grid: true,
      dcIdsToWrite: session.datacenters.map((dc) => dc.id),
      eventsToAppend: session.events.slice(eventsBefore),
    });
    return session;
  });

  if (!outcome.ran) {
    // Lock held by another tick — return current state without re-simulating.
    const current = await getSession(params.sessionId);
    if (!current) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    return NextResponse.json({ session: current });
  }
  if (outcome.result === null) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session: outcome.result });
}
```

- [ ] **Step 2: Verify TypeScript compiles for this file**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | grep "tick/route" | head -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add franklin/web/app/api/sessions/\[sessionId\]/tick/route.ts
git commit -m "franklin/web: tick route uses commitSession + withTickLock"
```

---

## Task 4: Migrate scenario, chat, datacenters create routes

**Files:**
- Modify: `app/api/sessions/[sessionId]/scenario/route.ts`
- Modify: `app/api/sessions/[sessionId]/chat/route.ts`
- Modify: `app/api/sessions/[sessionId]/datacenters/route.ts`

- [ ] **Step 1: Rewrite scenario route**

Replace `app/api/sessions/[sessionId]/scenario/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, setScenario } from '@/lib/simulation';
import { addOpenAINegotiationEvent, runGridAllocatorToolCall } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession } from '@/lib/session-store';
import type { Scenario } from '@/lib/types';

export const dynamic = 'force-dynamic';

const scenarios = new Set<Scenario>(['nominal', 'heatwave', 'feeder_constraint', 'renewable_drop', 'demand_spike']);

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => null)) as { scenario?: Scenario } | null;
  if (!body?.scenario || !scenarios.has(body.scenario)) {
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  }
  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  setScenario(session, body.scenario);
  applyGridAgentAllocation(session);
  session.grid = await solveWithOpenDss(session, session.grid);
  appendPowerFlowResult(session);
  await addOpenAINegotiationEvent(session, { kind: 'scenario_change' });
  await runGridAllocatorToolCall(session, { kind: 'scenario_change' });

  await commitSession(params.sessionId, session, {
    meta: true,
    grid: true,
    dcIdsToWrite: session.datacenters.map((dc) => dc.id),
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
```

- [ ] **Step 2: Rewrite chat route**

Replace `app/api/sessions/[sessionId]/chat/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { commitSession, getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  await addChatTurn(session, { kind: 'operator_chat', message });

  await commitSession(params.sessionId, session, {
    meta: true,
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
```

- [ ] **Step 3: Rewrite datacenters create route**

Replace `app/api/sessions/[sessionId]/datacenters/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, createDataCenter } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => ({}))) as { displayName?: string };
  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  const dc = createDataCenter(session, body.displayName);
  applyGridAgentAllocation(session);
  session.grid = await solveWithOpenDss(session, session.grid);
  appendPowerFlowResult(session);

  const otherDcIds = session.datacenters.filter((d) => d.id !== dc.id).map((d) => d.id);
  await commitSession(params.sessionId, session, {
    meta: true,
    grid: true,
    dcIdsToCreate: [dc.id],
    dcIdsToWrite: otherDcIds,
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ sessionId: session.id, datacenterId: dc.id, session }, { status: 201 });
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | grep -E "(scenario|chat|datacenters)/route" | head -10`
Expected: no errors mentioning these three files.

- [ ] **Step 5: Commit**

```bash
git add franklin/web/app/api/sessions/\[sessionId\]/scenario/route.ts franklin/web/app/api/sessions/\[sessionId\]/chat/route.ts franklin/web/app/api/sessions/\[sessionId\]/datacenters/route.ts
git commit -m "franklin/web: scenario/chat/datacenter-create routes use commitSession"
```

---

## Task 5: Migrate per-DC routes (delete, chat, override, request)

**Files:**
- Modify: `app/api/sessions/[sessionId]/datacenters/[datacenterId]/route.ts`
- Modify: `app/api/sessions/[sessionId]/datacenters/[datacenterId]/chat/route.ts`
- Modify: `app/api/sessions/[sessionId]/datacenters/[datacenterId]/override/route.ts`
- Modify: `app/api/sessions/[sessionId]/datacenters/[datacenterId]/request/route.ts`

- [ ] **Step 1: Rewrite DC delete route**

Replace `app/api/sessions/[sessionId]/datacenters/[datacenterId]/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { addEvent, appendPowerFlowResult, applyGridAgentAllocation } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, removeDc } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const idx = session.datacenters.findIndex((dc) => dc.id === params.datacenterId);
  if (idx === -1) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });

  const removedName = session.datacenters[idx].name;
  const eventsBefore = session.events.length;

  // Drop from Upstash hash FIRST so a racing tick that reads after this point won't see the DC.
  await removeDc(params.sessionId, params.datacenterId);

  session.datacenters.splice(idx, 1);
  addEvent(session, 'operator', 'grid-agent', 'MANUAL_OVERRIDE', `Removed ${removedName} from the grid (operator action).`);
  applyGridAgentAllocation(session);
  session.grid = await solveWithOpenDss(session, session.grid);
  appendPowerFlowResult(session);

  await commitSession(params.sessionId, session, {
    meta: true,
    grid: true,
    dcIdsToWrite: session.datacenters.map((dc) => dc.id),
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session, removed: removedName });
}
```

- [ ] **Step 2: Rewrite DC chat route**

Replace `app/api/sessions/[sessionId]/datacenters/[datacenterId]/chat/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { commitSession, getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const datacenter = session.datacenters.find((d) => d.id === params.datacenterId);
  if (!datacenter) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  await addChatTurn(session, { kind: 'datacenter_chat', datacenter, message });

  await commitSession(params.sessionId, session, {
    meta: true,
    dcIdsToWrite: [datacenter.id],
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
```

- [ ] **Step 3: Rewrite DC override route**

Replace `app/api/sessions/[sessionId]/datacenters/[datacenterId]/override/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, applyManualOverride } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

type OverrideBody = {
  schedulerCap?: number;
  batterySupportKw?: number;
  instruction?: string;
};

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as OverrideBody | null;
  if (!body || (typeof body.schedulerCap !== 'number' && typeof body.batterySupportKw !== 'number')) {
    return NextResponse.json({ error: 'Override requires schedulerCap or batterySupportKw' }, { status: 400 });
  }

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const found = Boolean(applyManualOverride(session, params.datacenterId, {
    schedulerCap: body.schedulerCap,
    batterySupportKw: body.batterySupportKw,
    instruction: body.instruction?.trim().slice(0, 240),
  }));
  if (!found) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });

  const eventsBefore = session.events.length;
  applyGridAgentAllocation(session);
  session.grid = await solveWithOpenDss(session, session.grid);
  appendPowerFlowResult(session);

  await commitSession(params.sessionId, session, {
    meta: true,
    grid: true,
    dcIdsToWrite: session.datacenters.map((dc) => dc.id),
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
```

Note: `eventsBefore` is captured **after** `applyManualOverride` because that helper itself emits an event, but we still want to RPUSH it. Move the capture: put `const eventsBefore = session.events.length;` immediately after `getSession` and before `applyManualOverride`. Update the code block above accordingly when you write it.

- [ ] **Step 4: Rewrite DC request route**

Replace `app/api/sessions/[sessionId]/datacenters/[datacenterId]/request/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, applyInferenceRequest } from '@/lib/simulation';
import { addOpenAINegotiationEvent } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession } from '@/lib/session-store';
import type { RequestType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const requestTypes = new Set<RequestType>([
  'standard_inference',
  'priority_inference',
  'batch_inference',
  'urgent_burst',
]);

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as { requestType?: RequestType } | null;
  if (!body?.requestType || !requestTypes.has(body.requestType)) {
    return NextResponse.json({ error: 'Invalid request type' }, { status: 400 });
  }

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  const datacenter = applyInferenceRequest(session, params.datacenterId, body.requestType);
  if (!datacenter) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  applyGridAgentAllocation(session);
  session.grid = await solveWithOpenDss(session, session.grid);
  appendPowerFlowResult(session);
  await addOpenAINegotiationEvent(session, { kind: 'inference_request', datacenter, requestType: body.requestType });

  await commitSession(params.sessionId, session, {
    meta: true,
    grid: true,
    dcIdsToWrite: session.datacenters.map((dc) => dc.id),
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | grep "datacenters/\[datacenterId\]" | head -10`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add franklin/web/app/api/sessions/\[sessionId\]/datacenters/
git commit -m "franklin/web: per-DC routes use commitSession; delete drops Upstash field first"
```

---

## Task 6: Migrate `GET /api/sessions` and `POST /api/sessions` to read-only / explicit-create

**Files:**
- Modify: `app/api/sessions/route.ts`

- [ ] **Step 1: Replace the route**

Replace `app/api/sessions/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { createDefaultSession, getDefaultSession, summarize } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getDefaultSession();
  if (!session) return NextResponse.json({ sessions: [], session: null });
  return NextResponse.json({ sessions: [summarize(session)], session });
}

export async function POST() {
  const existing = await getDefaultSession();
  const session = existing ?? (await createDefaultSession());
  return NextResponse.json({ session, summary: summarize(session) }, { status: existing ? 200 : 201 });
}
```

- [ ] **Step 2: Verify the whole project compiles**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors. (If anything still imports `updateSession`, `saveSession`, or `getOrCreateDefaultSession`, fix it now — those exports are gone.)

- [ ] **Step 3: Commit**

```bash
git add franklin/web/app/api/sessions/route.ts
git commit -m "franklin/web: GET /api/sessions is read-only; POST creates explicitly"
```

---

## Task 7: UI tolerates `session: null` from `GET /api/sessions`

**Files:**
- Modify: `app/join/JoinClient.tsx`
- Modify: `app/dashboard/page.tsx`

- [ ] **Step 1: Read both files to find the current fetch logic**

Run: `cd franklin/web && sed -n '1,80p' app/join/JoinClient.tsx`

Note the current `fetch('/api/sessions')` call near line 20. It currently assumes `data.session` exists.

Run: `cd franklin/web && sed -n '1,60p' app/dashboard/page.tsx`

Note the dashboard's session-loading effect.

- [ ] **Step 2: Add a small bootstrap helper to `app/join/JoinClient.tsx`**

In the `useEffect` that calls `fetch('/api/sessions')`:

- If `data.session` is `null`, immediately `POST /api/sessions` and use the response.
- During this brief window, render a "Preparing session…" placeholder (whatever the current loading state shows is fine — the existing loading UI should already be in place).

Concretely, change the effect body from:

```ts
fetch('/api/sessions')
  .then((r) => r.json())
  .then((data) => { /* use data.session */ });
```

to:

```ts
(async () => {
  let res = await fetch('/api/sessions').then((r) => r.json());
  if (!res.session) {
    res = await fetch('/api/sessions', { method: 'POST' }).then((r) => r.json());
  }
  // existing handler with res.session / res.sessions
})();
```

Preserve the existing handler logic verbatim — only the data acquisition changes.

- [ ] **Step 3: Apply the same pattern to `app/dashboard/page.tsx`**

Wherever the dashboard initially fetches `/api/sessions` (or `/api/sessions/${id}/state`), wrap with the same null-then-POST bootstrap. If the dashboard only fetches `/api/sessions/${id}/state` and gets a 404 today, change the 404 handler to POST `/api/sessions` and retry the state fetch — mirror the existing pattern in `app/session/[sessionId]/datacenter/DataCenterClient.tsx:124–128`.

- [ ] **Step 4: Verify project compiles and the join page renders**

Run: `cd franklin/web && npx tsc --noEmit 2>&1 | head -10`
Expected: no errors.

Then:

```bash
PORT=$(echo "$PWD" | cksum | awk '{print 3000 + ($1 % 1000)}')
cd franklin/web && npx next dev -p $PORT
```

In another terminal, manually delete the Upstash keys for the default session (or use a fresh Upstash instance), then:

```bash
curl -s http://localhost:$PORT/api/sessions | head -1
```
Expected: `{"sessions":[],"session":null}` — no writes to Upstash (verify in dashboard).

Visit `http://localhost:$PORT/join` in a browser. Expected: page loads, briefly shows the loading state, then shows the join UI populated with the freshly-bootstrapped session.

- [ ] **Step 5: Commit**

```bash
git add franklin/web/app/join/JoinClient.tsx franklin/web/app/dashboard/page.tsx
git commit -m "franklin/web: join + dashboard bootstrap session on null/404 from GET /api/sessions"
```

---

## Task 8: Verification script for race conditions

**Files:**
- Create: `scripts/verify-session-split.mjs`

- [ ] **Step 1: Write the script**

Create `franklin/web/scripts/verify-session-split.mjs`:

```js
#!/usr/bin/env node
// Run: node scripts/verify-session-split.mjs
// Requires: dev server running locally on the project's deterministic PORT, with Upstash configured.
// Verifies:
//   1. GET /api/sessions returns session:null when keys are absent (no implicit write).
//   2. Concurrent DC delete + tick: deleted DC stays deleted.
//   3. Two near-simultaneous chats: both messages appear in events.

import { execSync } from 'node:child_process';

const PORT = Number(execSync(`echo "${process.cwd()}" | cksum | awk '{print 3000 + ($1 % 1000)}'`).toString().trim());
const BASE = `http://localhost:${PORT}`;

const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: body === undefined ? 'POST' : 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const del = (p) => fetch(`${BASE}${p}`, { method: 'DELETE' }).then((r) => r.json());

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`PASS: ${msg}`);
}

async function main() {
  // Test 1: read-only GET
  // (NOTE: this test only meaningful if you've manually wiped the keys — otherwise just check that no error occurs.)
  const list = await get('/api/sessions');
  console.log('GET /api/sessions →', JSON.stringify(list).slice(0, 120));

  // Ensure a session exists for the next tests
  await post('/api/sessions');
  let state = (await get('/api/sessions/default/state')).session;
  assert(state, 'session exists after POST /api/sessions');

  // Test 2: concurrent delete + tick
  // Add a DC, then race delete vs. tick
  const created = await post('/api/sessions/default/datacenters', { displayName: 'race-test' });
  const dcId = created.datacenterId;
  console.log(`Created race-test DC: ${dcId}`);

  // Fire delete and several ticks in parallel
  await Promise.all([
    del(`/api/sessions/default/datacenters/${dcId}`),
    post('/api/sessions/default/tick'),
    post('/api/sessions/default/tick'),
    post('/api/sessions/default/tick'),
  ]);

  // Allow any in-flight to settle
  await new Promise((r) => setTimeout(r, 250));
  state = (await get('/api/sessions/default/state')).session;
  const stillThere = state.datacenters.some((d) => d.id === dcId);
  assert(!stillThere, 'deleted DC stays deleted after concurrent ticks');

  // Test 3: concurrent chats — events log keeps both
  const before = state.events.length;
  await Promise.all([
    post('/api/sessions/default/chat', { message: 'race-chat-A' }),
    post('/api/sessions/default/chat', { message: 'race-chat-B' }),
  ]);
  state = (await get('/api/sessions/default/state')).session;
  const bodies = state.events.slice(before).map((e) => e.body).join(' | ');
  assert(bodies.includes('race-chat-A') && bodies.includes('race-chat-B'),
    `both concurrent chats present in events (got: ${bodies})`);

  console.log('\nAll verifications passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the script against a live dev server**

In one terminal:

```bash
cd franklin/web
PORT=$(echo "$PWD" | cksum | awk '{print 3000 + ($1 % 1000)}')
npx next dev -p $PORT
```

In another:

```bash
cd franklin/web
node scripts/verify-session-split.mjs
```

Expected output (last lines):
```
PASS: deleted DC stays deleted after concurrent ticks
PASS: both concurrent chats present in events (got: ... | race-chat-A | ... | race-chat-B | ...)

All verifications passed.
```

If the deletion test fails: the Lua `HSET-if-exists` script is not effective. Inspect `lib/session-store.ts:HSET_IF_EXISTS_LUA` and confirm `redis.eval` is being called with `[dcsKey]` as keys and `[dcId, JSON.stringify(dc)]` as args.

If the chat test fails: `RPUSH` is not being used or `eventsBefore` slicing is dropping events. Re-inspect the chat route.

- [ ] **Step 3: Commit**

```bash
git add franklin/web/scripts/verify-session-split.mjs
git commit -m "franklin/web: scripts/verify-session-split.mjs — exercise delete-vs-tick + concurrent chat"
```

---

## Task 9: End-to-end smoke + cleanup of legacy key in production

**Files:**
- (No code changes — operational verification + cleanup)

- [ ] **Step 1: Manual e2e in a browser**

With the dev server still running:
1. Open `http://localhost:$PORT/dashboard`
2. Confirm the session loads (no error toast on cold open).
3. Add a DC, immediately delete it while the page ticks. Confirm it does not reappear.
4. Open `http://localhost:$PORT/grid` and confirm the grid panel still updates.
5. Open the join page in a private window — confirm the participant flow still works.

- [ ] **Step 2: Confirm Upstash dashboard shows the new key shape**

In the Upstash console for the configured database, list keys matching `session:default:*`. Expect to see `session:default:meta`, `session:default:grid`, `session:default:dcs`, `session:default:events`. The old `session:default:state` should be absent (deleted by the migration in `getSession`). If present, run `getSession` once via any GET route and recheck.

- [ ] **Step 3: Clean-up note**

Open `lib/session-store.ts` and confirm the migration block in `getSession` has a comment marking it for removal. Leave it in place for at least one production deploy cycle, then delete in a follow-up commit.

- [ ] **Step 4: Final commit (if anything was tweaked) or close out**

If any small fixes were needed during e2e:

```bash
git add -p
git commit -m "franklin/web: post-verification fixups"
```

Otherwise, the branch is ready to merge.

---

## Self-review (completed)

**Spec coverage:**
- Key layout — Task 1
- Race resolution (Lua HSET-if-exists, tick lock, RPUSH atomic) — Tasks 2, 3, 5
- Reassembly via pipeline — Task 1
- Read paths return null gracefully — Tasks 6, 7
- Writer API — Tasks 1, 2
- Per-route changes — Tasks 3, 4, 5, 6
- Migration of legacy key — Task 1 (inside `getSession`)
- Acceptance criteria — Task 8 verification script + Task 9 e2e

**Placeholder scan:** none.

**Type consistency:** `commitSession`, `getSession`, `removeDc`, `withTickLock`, `getDefaultSession`, `createDefaultSession`, `CommitIntent` consistent across tasks. `dcIdsToCreate` vs `dcIdsToWrite` distinction is preserved. `MetaBlob` is internal; not exported.

**Open considerations the implementer may notice:**
- Task 5 Step 3 (override route) has a note about `eventsBefore` placement — the code block as written captures it after `applyManualOverride`, but it should be captured before. The note flags this and tells the implementer to fix it inline. Verify this is right before commit.
