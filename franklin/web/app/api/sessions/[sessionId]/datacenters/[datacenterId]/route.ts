import { NextResponse } from 'next/server';
import { addEvent, appendPowerFlowResult, applyGridAgentAllocation } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { updateSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  let removedName: string | null = null;
  const session = await updateSession(params.sessionId, async (draft) => {
    const idx = draft.datacenters.findIndex((dc) => dc.id === params.datacenterId);
    if (idx === -1) return;
    removedName = draft.datacenters[idx].name;
    draft.datacenters.splice(idx, 1);
    addEvent(
      draft,
      'operator',
      'grid-agent',
      'MANUAL_OVERRIDE',
      `Removed ${removedName} from the grid (operator action).`
    );
    applyGridAgentAllocation(draft);
    draft.grid = await solveWithOpenDss(draft, draft.grid);
    appendPowerFlowResult(draft);
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!removedName) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  return NextResponse.json({ session, removed: removedName });
}
