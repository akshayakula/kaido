import { NextResponse } from 'next/server';
import { listDevices } from '@/lib/sensor-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const devices = await listDevices();
  return NextResponse.json(devices);
}
