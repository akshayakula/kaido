import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, applyInferenceRequest } from '@/lib/simulation';
import { addOpenAINegotiationEvent } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, newEventsSince, snapshotEventIds } from '@/lib/session-store';
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
  const beforeEventIds = snapshotEventIds(session);

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
    eventsToAppend: newEventsSince(session, beforeEventIds),
  });
  return NextResponse.json({ session });
}
