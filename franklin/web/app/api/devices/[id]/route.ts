import { NextResponse } from 'next/server';
import {
  getDeviceAudio, getDeviceLatest, getDeviceMeta, getDeviceScore, getDeviceTelemetry,
} from '@/lib/sensor-store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const [meta, score, latest, telemetry, audio] = await Promise.all([
    getDeviceMeta(id),
    getDeviceScore(id),
    getDeviceLatest(id),
    getDeviceTelemetry(id, 200),
    getDeviceAudio(id, 40),
  ]);
  return NextResponse.json({ device: id, meta, score, latest, telemetry, audio });
}
