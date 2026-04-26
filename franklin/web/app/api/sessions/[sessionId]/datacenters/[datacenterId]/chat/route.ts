import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { commitSession, getSession, newEventsSince, snapshotEventIds } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const datacenter = session.datacenters.find((d) => d.id === params.datacenterId);
  if (!datacenter) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  const beforeEventIds = snapshotEventIds(session);

  await addChatTurn(session, { kind: 'datacenter_chat', datacenter, message });

  await commitSession(params.sessionId, session, {
    meta: true,
    dcIdsToWrite: [datacenter.id],
    eventsToAppend: newEventsSince(session, beforeEventIds),
  });
  return NextResponse.json({ session });
}
