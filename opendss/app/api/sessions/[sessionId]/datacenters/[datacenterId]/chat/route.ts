import { NextResponse } from 'next/server';
import { addChatTurn } from '@/lib/openai-agent';
import { updateSession } from '@/lib/session-store';
import type { DataCenterAgent } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim().slice(0, 500);
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  let datacenter: DataCenterAgent | undefined;
  const session = await updateSession(params.sessionId, async (draft) => {
    datacenter = draft.datacenters.find((item) => item.id === params.datacenterId);
    if (datacenter) await addChatTurn(draft, { kind: 'datacenter_chat', datacenter, message });
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!datacenter) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  return NextResponse.json({ session });
}
