import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, createDataCenter } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, newEventsSince, snapshotEventIds } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => ({}))) as { displayName?: string };
  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const beforeEventIds = snapshotEventIds(session);

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
    eventsToAppend: newEventsSince(session, beforeEventIds),
  });
  return NextResponse.json({ sessionId: session.id, datacenterId: dc.id, session }, { status: 201 });
}
