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
