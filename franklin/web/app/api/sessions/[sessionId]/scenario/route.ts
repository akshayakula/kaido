import { NextResponse } from 'next/server';
import { appendPowerFlowResult, setScenario } from '@/lib/simulation';
import { addOpenAINegotiationEvent } from '@/lib/openai-agent';
import { solveWithOpenDss } from '@/lib/opendss/runner';
import { updateSession } from '@/lib/session-store';
import type { Scenario } from '@/lib/types';

export const dynamic = 'force-dynamic';

const scenarios = new Set<Scenario>(['nominal', 'heatwave', 'feeder_constraint', 'renewable_drop', 'demand_spike']);

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => null)) as { scenario?: Scenario } | null;
  if (!body?.scenario || !scenarios.has(body.scenario)) {
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  }
  const session = await updateSession(params.sessionId, async (draft) => {
    setScenario(draft, body.scenario!);
    draft.grid = await solveWithOpenDss(draft, draft.grid);
    appendPowerFlowResult(draft);
    await addOpenAINegotiationEvent(draft, { kind: 'scenario_change' });
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
