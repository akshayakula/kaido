import { NextResponse } from 'next/server';
import { getOrCreateDefaultSession, summarize } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getOrCreateDefaultSession();
  return NextResponse.json({ sessions: [summarize(session)], session });
}

export async function POST() {
  const session = await getOrCreateDefaultSession();
  return NextResponse.json({ session, summary: summarize(session) }, { status: 201 });
}
