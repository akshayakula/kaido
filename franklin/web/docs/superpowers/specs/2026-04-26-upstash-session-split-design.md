# Upstash session-store: split blob into per-field keys

**Date:** 2026-04-26
**Status:** Approved, ready for implementation plan
**Scope:** `franklin/web` only

## Problem

`lib/session-store.ts` stores the entire `DemoSession` (metadata, grid, datacenters, events) in a single Upstash key (`session:{id}:state`). Every API route mutates via `updateSession(id, fn)` — a read-modify-write of the whole blob with no concurrency control.

Observed symptoms:

1. **Stale-write clobber.** A UI tick (~1s cadence) racing with a DC delete or chat message can overwrite the latest state — deleted DCs reappear, chat turns vanish.
2. **Implicit session creation on read.** `getOrCreateDefaultSession()` is called from `GET /api/sessions`, so any cold read with no existing session silently writes a fresh default. The user wants no writes to Upstash on read paths.

## Solution

Split the blob into per-field Upstash keys whose write patterns don't overlap. Each route mutates only the keys it needs. Per-DC mutations use `HSET-if-exists` (Lua) so that concurrent ticks cannot resurrect a deleted DC. Read paths never write.

### Key layout

| Key | Type | Holds | Writers |
|---|---|---|---|
| `session:{id}:meta` | string (JSON) | `{id, label, createdAt, updatedAt, site, scenario, running, tick}` | scenario change, tick (tick+updatedAt), DC create/delete (updatedAt) |
| `session:{id}:grid` | string (JSON) | `GridState` | tick, scenario change, DC create/delete |
| `session:{id}:dcs` | hash | field=`dcId`, value=JSON of `DataCenterAgent` | DC create (HSET), delete (HDEL), tick (HSET-if-exists per DC), chat/override/request (HSET-if-exists) |
| `session:{id}:events` | list | append-only `AgentEvent` JSON | every event-emitting action (RPUSH + LTRIM cap 500) |
| `session:{id}:tick:lock` | string (NX EX 5) | tick mutex | tick route only |
| `sessions:active` | sorted set | `{sessionId → updatedAt}` | unchanged |

TTL: every key gets `EXPIRE` set to the existing `SESSION_TTL_SECONDS = 4h` on every write that touches it.

### Race resolution

- **Tick ↔ DC delete.** Delete = `HDEL session:{id}:dcs {dcId}`. Tick writes each DC via Lua: `if redis.call('HEXISTS', K, F) == 1 then redis.call('HSET', K, F, V) end`. A DC deleted mid-tick stays deleted.
- **Tick ↔ tick.** `SET session:{id}:tick:lock 1 NX EX 5`. If not acquired, the tick route returns the current state without re-running. Stale lock auto-expires after 5s.
- **Concurrent event appends.** `RPUSH` is atomic. Order = arrival order at Redis. After RPUSH, `LTRIM 0 -501` to cap at 500 events.
- **Tick ↔ DC chat/override on same DC.** Both call `updateDcIfExists`, which is read-modify-write inside Lua (atomic per DC). Writers merge into the latest field values rather than substituting a stale snapshot. (Lua script signature: take dcId, take a JSON patch, merge over current hash field, HSET-if-exists.)

### Reassembly for reads

`getSession(id)` returns the full `DemoSession` shape — same wire format the UI consumes today — assembled by one Upstash pipeline:

```
GET session:{id}:meta
GET session:{id}:grid
HGETALL session:{id}:dcs
LRANGE session:{id}:events 0 -1
```

If `meta` is missing → return `null`. No write side effects.

### Read paths return null gracefully

- `GET /api/sessions` → `{ sessions: [], session: null }` when no session exists. (Currently this implicitly creates one.)
- `GET /api/sessions/{id}/state` → already returns 404 when missing; behavior unchanged.
- All UI fetchers tolerate `session: null` / 404 by POSTing `/api/sessions` to create the default, then re-reading. `DataCenterClient.tsx:124–128` already has this pattern; extend it to the join page (`JoinClient.tsx:20`) and dashboard so the user sees a brief "creating session…" state instead of a broken UI. No alarming error toasts on the `null` case.

### Writer API in `lib/session-store.ts`

Replace `updateSession` with targeted helpers. Each helper updates only its key(s) and refreshes TTL.

- `getSession(id) → DemoSession | null` — pipelined read, no writes.
- `getMeta(id)`, `setMeta(id, patch)` — partial JSON merge on meta.
- `setGrid(id, grid)` — overwrite grid blob.
- `createDc(id, dc)` — `HSET session:{id}:dcs dcId json`.
- `removeDc(id, dcId)` — `HDEL session:{id}:dcs dcId`.
- `updateDcIfExists(id, dcId, patch | (current) => patched)` — Lua merge; no-op if field is gone.
- `appendEvents(id, events[])` — RPUSH each, then LTRIM.
- `withTickLock(id, fn)` — wrap a tick; resolves to `{ ran: false, session }` if lock held.
- `createDefaultSession()` — explicit creator. Used by `POST /api/sessions` only.
- `getDefaultSession()` — pure read.

`saveSession(session)` is removed. Callers must use the targeted helpers. `updateSession(id, mutator)` is removed; routes are rewritten to call the targeted helpers directly. Each route becomes a few lines and clearly states what it touches.

### Per-route changes

| Route | Old | New |
|---|---|---|
| `GET /api/sessions` | `getOrCreateDefaultSession()` (writes!) | `getDefaultSession()` (read-only) |
| `POST /api/sessions` | `getOrCreateDefaultSession()` | `getDefaultSession() ?? createDefaultSession()` |
| `GET /api/sessions/{id}/state` | unchanged | unchanged |
| `POST /api/sessions/{id}/tick` | `updateSession(...)` whole-blob | `withTickLock` → read → simulate → `setMeta(tick) + setGrid + updateDcIfExists each + appendEvents` |
| `POST /api/sessions/{id}/scenario` | whole-blob | read → simulate → `setMeta(scenario) + setGrid + updateDcIfExists each + appendEvents` |
| `POST /api/sessions/{id}/datacenters` | whole-blob | read → create → `createDc + setGrid + appendEvents + bumpMeta` |
| `DELETE /api/sessions/{id}/datacenters/{dcId}` | whole-blob | `removeDc + setGrid + appendEvents + bumpMeta` |
| `POST /api/sessions/{id}/datacenters/{dcId}/chat` | whole-blob | `updateDcIfExists + appendEvents` |
| `POST /api/sessions/{id}/datacenters/{dcId}/override` | whole-blob | `updateDcIfExists + appendEvents` |
| `POST /api/sessions/{id}/datacenters/{dcId}/request` | whole-blob | `updateDcIfExists + appendEvents` |

Each route still returns the assembled `DemoSession` (one final `getSession` call at the end) so the wire format is preserved.

### Migration of existing keys

On first `getSession(id)` after deploy, if the new `meta` key is absent but the old `session:{id}:state` key exists, deserialize the old blob and SET the new keys (one-time, idempotent). Then DEL the old key. No code path is added that relies on the old key for ongoing writes.

A short comment marks the migration block. It can be deleted after a few days once production keys have rolled over.

### Removed / preserved

- `getSessionStoreHealth()` keeps its self-test write (separate `session-store-health:*` key with 60s TTL) — it's a health probe, not a read path.
- `summarize()` still works; rebuilt from meta + dc count + grid health.
- `listSessions()` continues to use `sessions:active` sorted set; reads each session via the new pipelined `getSession`.

## Out of scope

- Audit log of every Upstash op.
- Schema versioning beyond the one-shot migration.
- Field-level diffing to skip no-op writes.
- Any changes outside `franklin/web/` (no Netlify Function changes — Next.js routes on Netlify already are the functions).

## Acceptance

- Deleting a DC and immediately ticking does not resurrect the DC (verifiable by spamming delete + tick concurrently).
- Two near-simultaneous chat messages both appear in the events log.
- A cold deploy with no existing Upstash keys: `GET /api/sessions` returns `{ session: null }` with no writes to Upstash (verifiable in Upstash dashboard).
- Wire format from `GET /api/sessions/{id}/state` unchanged; existing UI keeps working.
- Existing `session:{id}:state` blob in production is migrated transparently on first read.
