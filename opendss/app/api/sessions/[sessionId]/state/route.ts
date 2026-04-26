import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: { sessionId: string } }) {
  const session = await getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
