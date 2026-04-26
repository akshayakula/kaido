import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, setScenario } from '@/lib/simulation';
import { addOpenAINegotiationEvent, runGridAllocatorToolCall } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, newEventsSince, snapshotEventIds } from '@/lib/session-store';
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
  const beforeEventIds = snapshotEventIds(session);

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
    eventsToAppend: newEventsSince(session, beforeEventIds),
  });
  return NextResponse.json({ session });
}
