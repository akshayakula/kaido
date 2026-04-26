import { appendAgentEvent, applyLlmAllocation } from './simulation';
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
  // Prefer OpenAI; fall back to legacy NVIDIA NIM if that's all that's set.
  const apiKey = process.env.OPENAI_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    appendAgentEvent(session, 'ai-agent', 'demo', 'AI_DISABLED', 'OPENAI_API_KEY is not configured; using deterministic negotiation messages.');
    return;
  }

  try {
    const text = await generateNegotiationText(session, trigger, apiKey);
    appendAgentEvent(session, aiFrom(trigger), aiTo(trigger), 'AI_NEGOTIATION', text);
  } catch (error) {
    appendAgentEvent(session, 'ai-agent', 'demo', 'AI_FALLBACK', fallbackByTrigger[trigger.kind]);
    console.warn('[ai negotiation failed]', error);
  }
}

export async function addChatTurn(session: DemoSession, trigger: Extract<Trigger, { kind: 'datacenter_chat' | 'operator_chat' }>) {
  if (trigger.kind === 'datacenter_chat') {
    appendAgentEvent(session, trigger.datacenter.name, 'grid-agent', 'CHAT', trigger.message);
  } else {
    appendAgentEvent(session, 'operator', 'grid-agent', 'CHAT', trigger.message);
  }
  // 1) Free-text negotiation message (existing behavior).
  await addOpenAINegotiationEvent(session, trigger);
  // 2) Tool-call allocator: grid agent reads recent chat + state, returns
  //    fractions of total grid power per DC.
  await runGridAllocatorToolCall(session, trigger);
}

type AllocationToolArgs = {
  rationale: string;
  allocations: Array<{ dcId: string; fraction: number; reason?: string }>;
};

/**
 * Calls the LLM with a forced tool definition that allocates a fraction of the
 * grid total to each data center. Applies the result via applyLlmAllocation
 * and emits a system event explaining what happened.
 */
export async function runGridAllocatorToolCall(
  session: DemoSession,
  trigger: Trigger,
): Promise<void> {
  if (!session.datacenters.length) return;
  const apiKey = process.env.OPENAI_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return;

  const usingNvidia = !process.env.OPENAI_API_KEY && !!process.env.NVIDIA_NIM_API_KEY;
  const model =
    process.env.OPENAI_MODEL ||
    process.env.NVIDIA_NIM_MODEL ||
    (usingNvidia ? 'mistralai/mistral-nemotron' : 'gpt-4o-mini');
  const baseUrl =
    process.env.OPENAI_BASE_URL ||
    process.env.NVIDIA_NIM_BASE_URL ||
    (usingNvidia ? 'https://integrate.api.nvidia.com/v1' : 'https://api.openai.com/v1');

  const totalCapacityKw = session.grid.totalCapacityKw ?? 0;
  const recentChat = session.events
    .slice(0, 24)
    .filter((e) => e.type === 'CHAT' || e.type === 'AI_NEGOTIATION' || e.type === 'REQUEST_RELIEF' || e.type === 'RELIEF_OFFER')
    .map((e) => ({ at: e.at, from: e.from, to: e.to, type: e.type, body: e.body }));

  const dcs = session.datacenters.map((dc) => ({
    dcId: dc.id,
    name: dc.name,
    priority: Number(dc.priority.toFixed(2)),
    queueDepth: dc.queueDepth,
    desiredUtilizationPct: Math.round(dc.desiredUtilization * 100),
    actualUtilizationPct: Math.round(dc.actualUtilization * 100),
    schedulerCapPct: Math.round(dc.schedulerCap * 100),
    batterySocPct: Math.round(dc.batterySoc * 100),
    currentFraction: Number((dc.gridAllocation?.fraction ?? 0).toFixed(4)),
    requestedKw: Math.round(dc.gridAllocation?.requestedKw ?? 0),
  }));

  const tools = [
    {
      type: 'function',
      function: {
        name: 'set_dc_allocations',
        description:
          "Set each data center's share of total grid power as a fraction. " +
          'Sum of fractions must be ≤ 0.92 (the agent budget). Higher-priority DCs ' +
          'and DCs explicitly requesting more in chat should get larger fractions ' +
          'unless the grid is constrained, in which case shed flexible load first.',
        parameters: {
          type: 'object',
          required: ['rationale', 'allocations'],
          properties: {
            rationale: {
              type: 'string',
              description: 'One short sentence explaining the overall allocation decision.',
            },
            allocations: {
              type: 'array',
              items: {
                type: 'object',
                required: ['dcId', 'fraction'],
                properties: {
                  dcId: { type: 'string', description: 'Data center id from the input list.' },
                  fraction: {
                    type: 'number',
                    description: 'Fraction of total grid power (0.0-0.5) for this DC.',
                  },
                  reason: { type: 'string', description: 'Per-DC justification.' },
                },
              },
            },
          },
        },
      },
    },
  ];

  const triggerSummary =
    trigger.kind === 'datacenter_chat'
      ? `${trigger.datacenter.name} sent chat: "${trigger.message}"`
      : trigger.kind === 'operator_chat'
        ? `Operator sent chat: "${trigger.message}"`
        : trigger.kind;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are the grid agent. You allocate fractions of total grid power to each data center based on grid state, scenario, and recent A2A chat. ' +
              'You must call the set_dc_allocations tool exactly once. Sum of fractions ≤ 0.92.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              trigger: triggerSummary,
              scenario: {
                key: session.scenario,
                label: scenarioLabel(session.scenario),
                brief: scenarioBrief(session.scenario),
              },
              grid: {
                health: session.grid.health,
                voltageMin: session.grid.voltageMin,
                lineLoadingMax: session.grid.lineLoadingMax,
                reserveKw: Math.round(session.grid.reserveKw),
                totalCapacityKw: Math.round(totalCapacityKw),
                agentBudgetKw: Math.round(session.grid.agentBudgetKw ?? 0),
              },
              datacenters: dcs,
              recentChat,
            }),
          },
        ],
        temperature: 0.3,
        max_tokens: 600,
        tools,
        tool_choice: { type: 'function', function: { name: 'set_dc_allocations' } },
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AI provider ${response.status}: ${body.slice(0, 400)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{ function?: { arguments?: string } }>;
        };
      }>;
    };
    const argsRaw = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argsRaw) throw new Error('No tool call returned');
    const args = JSON.parse(argsRaw) as AllocationToolArgs;
    if (!args || !Array.isArray(args.allocations)) throw new Error('Malformed tool args');

    applyLlmAllocation(session, args.allocations, args.rationale ?? 'LLM allocator decision.');

    const summary = args.allocations
      .filter((a) => session.datacenters.some((d) => d.id === a.dcId))
      .map((a) => {
        const dc = session.datacenters.find((d) => d.id === a.dcId)!;
        return `${dc.name}: ${(a.fraction * 100).toFixed(1)}%`;
      })
      .join(' · ');
    appendAgentEvent(
      session,
      'grid-agent',
      'data-center-agents',
      'AI_ALLOCATION',
      `${args.rationale ?? 'Allocator decision'} → ${summary}`,
    );
  } catch (err) {
    appendAgentEvent(
      session,
      'ai-agent',
      'demo',
      'AI_FALLBACK',
      `Tool-call allocator unavailable; deterministic allocation kept. ${err instanceof Error ? err.message.slice(0, 160) : ''}`,
    );
  }
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
  // Use OpenAI by default. NVIDIA NIM kept as a back-compat path for
  // anyone still running with NVIDIA_NIM_* env vars.
  const usingNvidia = !process.env.OPENAI_API_KEY && !!process.env.NVIDIA_NIM_API_KEY;
  const model =
    process.env.OPENAI_MODEL ||
    process.env.NVIDIA_NIM_MODEL ||
    (usingNvidia ? 'mistralai/mistral-nemotron' : 'gpt-4o-mini');
  const baseUrl =
    process.env.OPENAI_BASE_URL ||
    process.env.NVIDIA_NIM_BASE_URL ||
    (usingNvidia ? 'https://integrate.api.nvidia.com/v1' : 'https://api.openai.com/v1');
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
    throw new Error(`AI provider ${response.status}: ${body.slice(0, 500)}`);
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
