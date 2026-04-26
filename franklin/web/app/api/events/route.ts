import { NextResponse } from 'next/server';
import { listEvents } from '@/lib/sensor-store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit') ?? '100', 10), 500);
  return NextResponse.json(await listEvents(limit));
}
