import { NextRequest, NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const r = await fetch(`${FRANKLIN_SERVER_URL}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
