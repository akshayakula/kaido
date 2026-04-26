import { NextRequest, NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Proxy work/<...> static files (audio outputs) through Next.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const rel = path.map(encodeURIComponent).join('/');
  try {
    const upstream = await fetch(`${FRANKLIN_SERVER_URL}/work/${rel}`, { cache: 'no-store' });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: upstream.status || 502 });
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
