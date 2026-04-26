import { NextResponse } from 'next/server';
import { appendPowerFlowResult, applyGridAgentAllocation, applyManualOverride } from '@/lib/simulation';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { updateSession } from '@/lib/session-store';

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

  let found = false;
  const session = await updateSession(params.sessionId, async (draft) => {
    found = Boolean(
      applyManualOverride(draft, params.datacenterId, {
        schedulerCap: body.schedulerCap,
        batterySupportKw: body.batterySupportKw,
        instruction: body.instruction?.trim().slice(0, 240),
      })
    );
    if (found) {
      applyGridAgentAllocation(draft);
      draft.grid = await solveWithOpenDss(draft, draft.grid);
      appendPowerFlowResult(draft);
    }
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!found) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  return NextResponse.json({ session });
}
