import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/sensor-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Queue an inbound command for the Pi at cmd:<device>. The firmware
// GETDELs this key on every loop tick (every SAMPLE_INTERVAL_S, ~2 s).
//
// Previously this proxied through the Flask franklin server, which also
// fired SIGUSR1 over ssh to wake the Pi immediately. On Netlify the
// Flask URL isn't reachable, so we now write straight to Upstash. We
// lose the SIGUSR1 latency optimization (~100 ms → up to 2 s for the Pi
// to notice), which is fine for production.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = redis();
  if (!r) {
    return NextResponse.json(
      { error: 'Upstash credentials not configured (UPSTASH_REDIS_REST_URL + _TOKEN)' },
      { status: 503 },
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!type) {
    return NextResponse.json({ error: 'type required' }, { status: 400 });
  }
  const payload = { ...body, type, ts: Date.now() / 1000 };
  // 30s expiry: if the Pi is offline the command shouldn't sit forever.
  await r.set(`cmd:${id}`, JSON.stringify(payload), { ex: 30 });
  return NextResponse.json({ queued: payload });
}
