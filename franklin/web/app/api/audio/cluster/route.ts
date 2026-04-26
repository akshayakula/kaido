import { NextResponse } from 'next/server';
import { FRANKLIN_SERVER_URL, franklinAuthHeaders } from '@/lib/franklin-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const r = await fetch(`${FRANKLIN_SERVER_URL}/api/cluster`, {
      cache: 'no-store',
      headers: franklinAuthHeaders(),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (err) {
    return NextResponse.json({ error: String(err), online: false }, { status: 502 });
  }
}
