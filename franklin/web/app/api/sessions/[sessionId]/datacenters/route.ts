import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, createDataCenter } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { updateSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => ({}))) as { displayName?: string };
  let datacenterId = '';
  const session = await updateSession(params.sessionId, async (draft) => {
    const dc = createDataCenter(draft, body.displayName);
    datacenterId = dc.id;
    applyGridAgentAllocation(draft);
    draft.grid = await solveWithOpenDss(draft, draft.grid);
    appendPowerFlowResult(draft);
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ sessionId: session.id, datacenterId, session }, { status: 201 });
}
