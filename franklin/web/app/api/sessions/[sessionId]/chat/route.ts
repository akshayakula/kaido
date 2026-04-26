import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { updateSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const session = await updateSession(params.sessionId, async (draft) => {
    await addChatTurn(draft, { kind: 'operator_chat', message });
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
