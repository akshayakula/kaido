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

  const eventsBefore = session.events.length;
  const found = Boolean(applyManualOverride(session, params.datacenterId, {
    schedulerCap: body.schedulerCap,
    batterySupportKw: body.batterySupportKw,
    instruction: body.instruction?.trim().slice(0, 240),
  }));
  if (!found) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });

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
