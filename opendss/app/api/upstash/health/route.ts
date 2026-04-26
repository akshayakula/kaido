import { NextResponse } from 'next/server';
import { getSessionStoreHealth } from '@/lib/session-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await getSessionStoreHealth();
  return NextResponse.json(health, { status: health.configured && !health.ok ? 503 : 200 });
}
