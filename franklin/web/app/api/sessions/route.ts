import { NextResponse } from 'next/server';
import { createDefaultSession, getDefaultSession, summarize } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getDefaultSession();
  if (!session) return NextResponse.json({ sessions: [], session: null });
  return NextResponse.json({ sessions: [summarize(session)], session });
}

export async function POST() {
  const existing = await getDefaultSession();
  const session = existing ?? (await createDefaultSession());
  return NextResponse.json({ session, summary: summarize(session) }, { status: existing ? 200 : 201 });
}
