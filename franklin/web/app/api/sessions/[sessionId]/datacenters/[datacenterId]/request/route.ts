import { NextResponse } from 'next/server';
import { applyInferenceRequest } from '@/lib/simulation';
import { addOpenAINegotiationEvent } from '@/lib/openai-agent';
import { updateSession } from '@/lib/session-store';
import type { DataCenterAgent } from '@/lib/types';
import type { RequestType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const requestTypes = new Set<RequestType>([
  'standard_inference',
  'priority_inference',
  'batch_inference',
  'urgent_burst',
]);

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; datacenterId: string } }
) {
  const body = (await request.json().catch(() => null)) as { requestType?: RequestType } | null;
  if (!body?.requestType || !requestTypes.has(body.requestType)) {
    return NextResponse.json({ error: 'Invalid request type' }, { status: 400 });
  }

  let datacenter: DataCenterAgent | null = null;
  const session = await updateSession(params.sessionId, async (draft) => {
    datacenter = applyInferenceRequest(draft, params.datacenterId, body.requestType!);
    if (datacenter) {
      await addOpenAINegotiationEvent(draft, {
        kind: 'inference_request',
        datacenter,
        requestType: body.requestType!,
      });
    }
  });
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!datacenter) return NextResponse.json({ error: 'Data center not found' }, { status: 404 });
  return NextResponse.json({ session });
}
