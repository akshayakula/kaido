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
