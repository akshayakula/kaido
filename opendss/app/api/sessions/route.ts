import { NextResponse } from 'next/server';
import { createSession } from '@/lib/simulation';
import { listSessions, saveSession, summarize } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST() {
  const session = createSession();
  await saveSession(session);
  return NextResponse.json({ session, summary: summarize(session) }, { status: 201 });
}
