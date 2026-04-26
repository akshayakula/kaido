import { NextResponse } from 'next/server';
import { tickSession } from '@/lib/simulation';
import { addOpenAINegotiationEvent } from '@/lib/openai-agent';
import { updateSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(_: Request, { params }: { params: { sessionId: string } }) {
  const session = await updateSession(params.sessionId, async (draft) => {
    tickSession(draft);
    if (draft.datacenters.length > 0 && draft.tick % 8 === 0 && draft.grid.health !== 'normal') {
      await addOpenAINegotiationEvent(draft, { kind: 'grid_tick' });
    }
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
