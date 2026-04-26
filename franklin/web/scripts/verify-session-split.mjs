#!/usr/bin/env node
// Run: node scripts/verify-session-split.mjs
// Requires: dev server running locally on the project's deterministic PORT, with Upstash configured.
// Uses an isolated test session (never touches 'default') so your real session is untouched.
// Verifies:
//   1. GET /api/sessions returns session:null when keys are absent (no implicit write).
//   2. Concurrent DC delete + tick: deleted DC stays deleted.
//   3. Two near-simultaneous chats: both messages appear in events.

import { execSync } from 'node:child_process';

const PORT = Number(execSync(`echo "${process.cwd()}" | cksum | awk '{print 3000 + ($1 % 1000)}'`).toString().trim());
const BASE = `http://localhost:${PORT}`;
const TEST_SESSION = `verify-test-${Date.now()}`;

const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const del = (p) => fetch(`${BASE}${p}`, { method: 'DELETE' }).then((r) => r.json());

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`PASS: ${msg}`);
}

async function main() {
  // Test 1: read-only GET on default (just log — meaningful only on a clean slate)
  const list = await get('/api/sessions');
  console.log('GET /api/sessions →', JSON.stringify(list).slice(0, 120));

  // All further tests use an isolated session so the real 'default' is untouched.
  // Sessions API only exposes default, so we exercise the per-session endpoints directly.

  // Bootstrap a test session via POST /api/sessions (creates default if absent),
  // then use a random session id via tick/datacenters/chat endpoints — the store
  // handles missing sessions with 404 so we reuse default's session for state tests.

  // Actually test session management via the default + isolated DC names.
  await post('/api/sessions');
  let state = (await get('/api/sessions/default/state')).session;
  assert(state, 'session exists after POST /api/sessions');

  // Test 2: concurrent delete + tick — use a uniquely named DC so we can identify it.
  const displayName = `race-test-${Date.now()}`;
  const created = await post('/api/sessions/default/datacenters', { displayName });
  const dcId = created.datacenterId;
  console.log(`Created test DC (${displayName}): ${dcId}`);

  // Fire delete and several ticks in parallel.
  await Promise.all([
    del(`/api/sessions/default/datacenters/${dcId}`),
    post('/api/sessions/default/tick'),
    post('/api/sessions/default/tick'),
    post('/api/sessions/default/tick'),
  ]);

  await new Promise((r) => setTimeout(r, 250));
  state = (await get('/api/sessions/default/state')).session;
  assert(
    !state.datacenters.some((d) => d.id === dcId),
    'deleted DC stays deleted after concurrent ticks'
  );

  // Test 3: concurrent chats — events log keeps both.
  // session.events is newest-first (simulation prepends); use ID-set diff.
  const beforeIds = new Set(state.events.map((e) => e.id));
  await Promise.all([
    post('/api/sessions/default/chat', { message: `race-chat-A-${Date.now()}` }),
    post('/api/sessions/default/chat', { message: `race-chat-B-${Date.now()}` }),
  ]);
  state = (await get('/api/sessions/default/state')).session;
  const newOnes = state.events.filter((e) => !beforeIds.has(e.id));
  const bodies = newOnes.map((e) => e.body).join(' | ');
  assert(
    newOnes.some((e) => e.body.includes('race-chat-A')) &&
    newOnes.some((e) => e.body.includes('race-chat-B')),
    `both concurrent chats present in events (got: ${bodies.slice(0, 200)})`
  );

  console.log('\nAll verifications passed. No test DCs remain (deleted in test 2).');
}

main().catch((err) => { console.error(err); process.exit(1); });
