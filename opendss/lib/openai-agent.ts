import { appendAgentEvent } from './simulation';
import { scenarioBrief, scenarioLabel } from './scenarios';
import type { DataCenterAgent, DemoSession, RequestType } from './types';

type Trigger =
  | { kind: 'inference_request'; datacenter: DataCenterAgent; requestType: RequestType }
  | { kind: 'grid_tick' }
  | { kind: 'scenario_change' }
  | { kind: 'datacenter_chat'; datacenter: DataCenterAgent; message: string }
  | { kind: 'operator_chat'; message: string };

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const fallbackByTrigger: Record<Trigger['kind'], string> = {
  inference_request: 'Data-center agent requests added inference capacity; grid agent asks scheduler to price load against feeder margin.',
  grid_tick: 'Grid agent reviews OpenDSS state and asks flexible schedulers for relief offers where latency budgets allow.',
  scenario_change: 'Grid agent updates the national-security posture and asks data centers to re-price GPU work against mission-critical grid constraints.',
  datacenter_chat: 'Grid agent acknowledges the request and asks the scheduler to balance queue growth against feeder reserve.',
  operator_chat: 'Grid agent broadcasts the operator instruction and requests updated relief offers from participating data centers.',
};

export async function addOpenAINegotiationEvent(session: DemoSession, trigger: Trigger) {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    appendAgentEvent(session, 'ai-agent', 'demo', 'AI_DISABLED', 'NVIDIA NIM key is not configured; using deterministic negotiation messages.');
    return;
  }

  try {
    const text = await generateNegotiationText(session, trigger, apiKey);
    appendAgentEvent(session, aiFrom(trigger), aiTo(trigger), 'AI_NEGOTIATION', text);
  } catch (error) {
    appendAgentEvent(session, 'ai-agent', 'demo', 'AI_FALLBACK', fallbackByTrigger[trigger.kind]);
    console.warn('[nvidia nim negotiation failed]', error);
  }
}

export async function addChatTurn(session: DemoSession, trigger: Extract<Trigger, { kind: 'datacenter_chat' | 'operator_chat' }>) {
  if (trigger.kind === 'datacenter_chat') {
    appendAgentEvent(session, trigger.datacenter.name, 'grid-agent', 'CHAT', trigger.message);
  } else {
    appendAgentEvent(session, 'operator', 'grid-agent', 'CHAT', trigger.message);
  }
  await addOpenAINegotiationEvent(session, trigger);
}

function aiFrom(trigger: Trigger) {
  if (trigger.kind === 'inference_request' || trigger.kind === 'datacenter_chat') return trigger.datacenter.name;
  return 'grid-agent';
}

function aiTo(trigger: Trigger) {
  if (trigger.kind === 'inference_request' || trigger.kind === 'datacenter_chat') return 'grid-agent';
  return 'data-center-agents';
}

async function generateNegotiationText(session: DemoSession, trigger: Trigger, apiKey: string) {
  const model = process.env.NVIDIA_NIM_MODEL || 'mistralai/mistral-nemotron';
  const baseUrl = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const datacenters = session.datacenters.map((dc) => ({
    name: dc.name,
    queueDepth: dc.queueDepth,
    gpuUsePct: Math.round(dc.actualUtilization * 100),
    schedulerCapPct: Math.round(dc.schedulerCap * 100),
    latencyMs: dc.latencyMs,
    batterySocPct: Math.round(dc.batterySoc * 100),
    batterySupportKw: Math.round(dc.batterySupportKw),
    priority: dc.priority.toFixed(2),
    slurm: dc.slurm,
  }));

  const triggerSummary =
    trigger.kind === 'inference_request'
      ? `${trigger.datacenter.name} received ${trigger.requestType.replaceAll('_', ' ')} demand.`
      : trigger.kind === 'datacenter_chat'
        ? `${trigger.datacenter.name} says to the grid agent: "${trigger.message}"`
        : trigger.kind === 'operator_chat'
          ? `Operator instruction to grid agent: "${trigger.message}"`
      : trigger.kind.replaceAll('_', ' ');

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You write terse, realistic agent-to-agent negotiation messages for a defensive electric-grid/data-center national-security demo. Return one sentence under 38 words. Mention the concrete tradeoff between grid constraints and GPU scheduling. Do not include markdown.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            trigger: triggerSummary,
            site: session.site,
            scenario: {
              key: session.scenario,
              label: scenarioLabel(session.scenario),
              brief: scenarioBrief(session.scenario),
            },
            grid: session.grid,
            datacenters,
          }),
        },
      ],
      temperature: 0.6,
      top_p: 0.7,
      max_tokens: 120,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`NVIDIA NIM ${response.status}: ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as OpenAIResponse;
  return extractText(json) || fallbackByTrigger[trigger.kind];
}

function extractText(response: OpenAIResponse) {
  return clean(response.choices?.[0]?.message?.content ?? '');
}

function clean(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 260);
}
