import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { commitSession, getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const eventsBefore = session.events.length;

  await addChatTurn(session, { kind: 'operator_chat', message });

  await commitSession(params.sessionId, session, {
    meta: true,
    eventsToAppend: session.events.slice(eventsBefore),
  });
  return NextResponse.json({ session });
}
