import { NextResponse } from 'next/server';
import { listZones } from '@/lib/sensor-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await listZones());
}
