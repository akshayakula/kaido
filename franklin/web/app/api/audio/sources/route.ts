import { NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const r = await fetch(`${FRANKLIN_SERVER_URL}/api/sources`, { cache: 'no-store' });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
