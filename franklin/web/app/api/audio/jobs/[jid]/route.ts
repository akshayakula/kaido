import { NextRequest, NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL, franklinAuthHeaders } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ jid: string }> }) {
  const { jid } = await ctx.params;
  const since = req.nextUrl.searchParams.get('since') ?? '0';
  try {
    const r = await fetch(`${FRANKLIN_SERVER_URL}/api/jobs/${encodeURIComponent(jid)}?since=${since}`, {
      cache: 'no-store',
      headers: franklinAuthHeaders(),
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
