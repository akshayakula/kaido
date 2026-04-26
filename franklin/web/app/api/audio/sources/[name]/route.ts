import { NextRequest, NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL, franklinAuthHeaders } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  try {
    const r = await fetch(`${FRANKLIN_SERVER_URL}/api/sources/${encodeURIComponent(name)}`, {
      method: 'DELETE',
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
