import { NextResponse } from 'next/server';
import { addEvent, appendPowerFlowResult, applyGridAgentAllocation } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { commitSession, getSession, newEventsSince, removeDc, snapshotEventIds } from '@/lib/session-store';

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
  const beforeEventIds = snapshotEventIds(session);

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
    eventsToAppend: newEventsSince(session, beforeEventIds),
  });
  return NextResponse.json({ session, removed: removedName });
}
