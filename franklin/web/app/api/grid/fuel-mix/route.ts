import { NextResponse } from 'next/server';
import { getLatestPjmFuelMix } from '@/lib/gridstatus';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sample = await getLatestPjmFuelMix();
    return NextResponse.json({ sample });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
