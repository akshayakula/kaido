import { NextRequest, NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// SSE proxy — pipe the Flask event stream straight through to the browser.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ jid: string }> }) {
  const { jid } = await ctx.params;
  try {
    const upstream = await fetch(
      `${FRANKLIN_SERVER_URL}/api/jobs/${encodeURIComponent(jid)}/events`,
      { cache: 'no-store' }
    );
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: upstream.status || 502 });
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
