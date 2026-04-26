import type {
  AgentEvent,
  DataCenterAgent,
  DemoSession,
  GridSite,
  GridState,
  RequestType,
  Scenario,
} from './types';
import { scenarioBrief, scenarioLabel } from './scenarios';

const SITES: GridSite[] = [
  { name: 'Reno Compute Corridor', region: 'Nevada, US', lat: 39.5296, lng: -119.8138 },
  { name: 'Dublin Docklands Cluster', region: 'Ireland', lat: 53.3498, lng: -6.2603 },
  { name: 'Singapore West Grid', region: 'Singapore', lat: 1.3521, lng: 103.8198 },
  { name: 'Northern Virginia Fabric', region: 'Virginia, US', lat: 39.0438, lng: -77.4874 },
  { name: 'Frankfurt Edge Zone', region: 'Germany', lat: 50.1109, lng: 8.6821 },
  { name: 'Tokyo Bay Inference Mesh', region: 'Japan', lat: 35.6762, lng: 139.6503 },
];

const scenarioPressure: Record<Scenario, { capacityKw: number; voltageSag: number; cooling: number }> = {
  nominal: { capacityKw: 6200, voltageSag: 0, cooling: 0.28 },
  heatwave: { capacityKw: 5900, voltageSag: 0.012, cooling: 0.44 },
  feeder_constraint: { capacityKw: 4700, voltageSag: 0.025, cooling: 0.32 },
  renewable_drop: { capacityKw: 5400, voltageSag: 0.017, cooling: 0.3 },
  demand_spike: { capacityKw: 6000, voltageSag: 0.008, cooling: 0.36 },
};

const requestProfiles: Record<RequestType, { queue: number; utilization: number; jobs: number; label: string; partition: 'inference' | 'batch' | 'priority' }> = {
  standard_inference: { queue: 120, utilization: 0.08, jobs: 5, label: 'standard inference', partition: 'inference' },
  priority_inference: { queue: 180, utilization: 0.12, jobs: 6, label: 'priority inference', partition: 'priority' },
  batch_inference: { queue: 260, utilization: 0.16, jobs: 10, label: 'batch inference', partition: 'batch' },
  urgent_burst: { queue: 420, utilization: 0.24, jobs: 14, label: 'urgent burst', partition: 'priority' },
};

export function createSession(): DemoSession {
  const id = crypto.randomUUID().slice(0, 8);
  return createSessionWithId(id);
}

export function createSessionWithId(id: string): DemoSession {
  const site = SITES[Math.floor(Math.random() * SITES.length)];
  const session: DemoSession = {
    id,
    label: id === 'default' ? 'Default grid demo' : `Grid demo ${id.toUpperCase()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tick: 0,
    running: true,
    scenario: 'heatwave',
    site,
    grid: {
      health: 'normal',
      voltageMin: 0.99,
      lineLoadingMax: 0.62,
      reserveKw: 2600,
      lossesKw: 94,
      frequencyHz: 60,
      violations: [],
    },
    datacenters: [],
    events: [],
  };
  addEvent(session, 'grid-agent', 'opendss', 'SOLVE_READY', `Seeded synthetic feeder at ${site.name}.`);
  return session;
}

export function createDataCenter(session: DemoSession, displayName?: string): DataCenterAgent {
  const n = session.datacenters.length + 1;
  const angle = (Math.PI * 2 * n) / 7;
  const spread = 0.58 + (n % 3) * 0.16;
  const dc: DataCenterAgent = {
    id: crypto.randomUUID().slice(0, 10),
    name: displayName?.trim() || `Data Center ${String(n).padStart(2, '0')}`,
    lat: session.site.lat + Math.sin(angle) * spread,
    lng: session.site.lng + Math.cos(angle) * spread,
    joinedAt: Date.now(),
    gpuCount: 96 + (n % 5) * 48,
    gpuKw: 0.72 + (n % 3) * 0.04,
    baseKw: 420 + (n % 4) * 90,
    queueDepth: 90 + n * 35,
    desiredUtilization: 0.38 + (n % 4) * 0.05,
    actualUtilization: 0.32 + (n % 3) * 0.04,
    schedulerCap: 0.86,
    latencyMs: 38,
    batteryKwh: 480 + (n % 4) * 120,
    batterySoc: 0.72,
    batterySupportKw: 0,
    priority: 0.45 + (n % 5) * 0.1,
    lastInstruction: 'Admitted to grid negotiation loop.',
    slurm: createDefaultSlurm(96 + (n % 5) * 48, n),
  };
  session.datacenters.push(dc);
  addEvent(session, dc.name, 'grid-agent', 'JOIN_GRID', `${dc.name} joined as an autonomous data-center agent.`);
  touch(session);
  return dc;
}

export function normalizeSession(session: DemoSession) {
  session.datacenters.forEach((dc, index) => {
    dc.slurm ??= createDefaultSlurm(dc.gpuCount, index + 1);
    dc.slurm.maxGpus = dc.gpuCount;
    dc.slurm.pendingJobs ??= 0;
    dc.slurm.runningJobs ??= 0;
    dc.slurm.completedJobs ??= 0;
    dc.slurm.heldJobs ??= 0;
    dc.slurm.allocatedGpus ??= Math.round(dc.actualUtilization * dc.gpuCount);
    dc.slurm.targetGpus ??= Math.round(dc.desiredUtilization * dc.gpuCount);
    dc.slurm.backfillWindowMinutes ??= 12;
    dc.slurm.preemptions ??= 0;
    dc.slurm.state ??= 'normal';
    dc.slurm.partition ??= 'inference';
    dc.slurm.reason ??= 'Migrated existing session to mock Slurm scheduler state.';
    dc.gridAllocation ??= createAllocation(dc, session.scenario, dc.actualUtilization, 'none', 'Existing session allocation initialized.');
  });
  return session;
}

export function applyInferenceRequest(session: DemoSession, datacenterId: string, type: RequestType) {
  const dc = session.datacenters.find((item) => item.id === datacenterId);
  const profile = requestProfiles[type];
  if (!dc || !profile) return null;
  dc.queueDepth += profile.queue;
  dc.desiredUtilization = clamp(dc.desiredUtilization + profile.utilization, 0.2, 1.2);
  dc.slurm.pendingJobs += profile.jobs;
  dc.slurm.partition = profile.partition;
  dc.slurm.targetGpus = clamp(dc.slurm.targetGpus + profile.jobs * 3, 0, dc.gpuCount);
  dc.slurm.reason = `Queued ${profile.jobs} ${profile.partition} jobs from participant demand.`;
  dc.lastInstruction = `Received ${profile.label} demand from participant.`;
  addEvent(session, dc.name, 'slurm', 'SBATCH', `Submitted ${profile.jobs} ${profile.partition} jobs; Slurm target is ${Math.round(dc.slurm.targetGpus)} GPUs.`);
  touch(session);
  return dc;
}

export function applyManualOverride(
  session: DemoSession,
  datacenterId: string,
  override: { schedulerCap?: number; batterySupportKw?: number; instruction?: string }
) {
  const dc = session.datacenters.find((item) => item.id === datacenterId);
  if (!dc) return null;

  if (typeof override.schedulerCap === 'number') {
    dc.schedulerCap = clamp(override.schedulerCap, 0.28, 0.96);
    dc.slurm.state = 'manual_override';
    dc.slurm.reason = `Operator set scheduler cap to ${Math.round(dc.schedulerCap * 100)}%.`;
  }
  if (typeof override.batterySupportKw === 'number') {
    dc.batterySupportKw = clamp(override.batterySupportKw, 0, 220);
  }

  dc.lastInstruction =
    override.instruction ||
    `Manual override: cap ${Math.round(dc.schedulerCap * 100)}%, battery ${Math.round(dc.batterySupportKw)} kW.`;
  addEvent(session, 'operator', dc.name, 'MANUAL_OVERRIDE', dc.lastInstruction);
  session.grid = solveGridStep(session);
  touch(session);
  return dc;
}

export function setScenario(session: DemoSession, scenario: Scenario) {
  session.scenario = scenario;
  addEvent(session, 'operator', 'grid-agent', 'SCENARIO_CHANGE', `Scenario changed to ${scenarioLabel(scenario)}: ${scenarioBrief(scenario)}`);
  tickSession(session);
}

export function tickSession(session: DemoSession) {
  session.tick += 1;
  session.datacenters.forEach((dc, index) => updateDataCenterDemand(session, dc, index));

  const firstSolve = solveGridStep(session);
  session.grid = firstSolve;
  applyGridAgentNegotiation(session);
  applyGridAgentAllocation(session);
  session.grid = solveGridStep(session);
  touch(session);
}

export function appendPowerFlowResult(session: DemoSession) {
  const source = session.grid.solver === 'opendss' ? 'opendss' : 'grid-estimator';
  const feeder = typeof session.grid.feederKw === 'number' ? `, feeder ${Math.round(session.grid.feederKw)} kW` : '';
  const transformer =
    typeof session.grid.transformerLoading === 'number'
      ? `, transformer ${Math.round(session.grid.transformerLoading * 100)}%`
      : '';
  const deferredKw = session.datacenters.reduce((sum, dc) => sum + (dc.gridAllocation?.deferredKw ?? 0), 0);
  const allocation = deferredKw > 1 ? `, agent deferred ${Math.round(deferredKw)} kW` : ', agent cleared requested allocation';
  addEvent(
    session,
    source,
    'grid-agent',
    'POWER_FLOW_RESULT',
    `Solved ${session.datacenters.length} data centers: voltage ${session.grid.voltageMin.toFixed(3)} pu, line loading ${Math.round(
      session.grid.lineLoadingMax * 100
    )}%, reserve ${Math.round(session.grid.reserveKw)} kW${feeder}${transformer}${allocation}.`
  );
  touch(session);
}

export function solveGridStep(session: DemoSession): GridState {
  const pressure = scenarioPressure[session.scenario];
  const totalKw = session.datacenters.reduce((sum, dc) => sum + kwForDataCenter(dc, pressure.cooling), 0);
  const batterySupportKw = session.datacenters.reduce((sum, dc) => sum + dc.batterySupportKw, 0);
  const loadRatio = totalKw / pressure.capacityKw;
  const lineLoadingMax = clamp(loadRatio + session.datacenters.length * 0.012, 0.18, 1.32);
  const voltageMin = clamp(1.014 - lineLoadingMax * 0.06 - pressure.voltageSag + batterySupportKw / 52000, 0.9, 1.025);
  const reserveKw = Math.max(0, pressure.capacityKw * 0.94 - totalKw);
  const lossesKw = totalKw * (0.025 + lineLoadingMax * 0.022);
  const violations = [];
  if (voltageMin < 0.955) violations.push('low_voltage');
  if (lineLoadingMax > 0.94) violations.push('line_overload');

  return {
    health: violations.length ? 'emergency' : voltageMin < 0.974 || lineLoadingMax > 0.82 ? 'stressed' : 'normal',
    voltageMin,
    lineLoadingMax,
    reserveKw,
    lossesKw,
    frequencyHz: 60 - Math.max(0, lineLoadingMax - 0.8) * 0.1,
    violations,
  };
}

export function summarizeKw(dc: DataCenterAgent, scenario: Scenario) {
  return kwForDataCenter(dc, scenarioPressure[scenario].cooling);
}

function updateDataCenterDemand(session: DemoSession, dc: DataCenterAgent, index: number) {
  const wave = Math.sin((session.tick + index * 3) / 6) * 0.035;
  updateSlurmScheduler(session, dc);
  const slurmUtilization = dc.slurm.allocatedGpus / Math.max(1, dc.gpuCount);
  const allocationCap = dc.gridAllocation?.allocatedUtilization ?? dc.schedulerCap;
  const target = clamp(Math.max(dc.desiredUtilization + wave, slurmUtilization), 0.16, Math.min(dc.schedulerCap, allocationCap));
  dc.actualUtilization += (target - dc.actualUtilization) * 0.32;
  const served = Math.round(dc.slurm.runningJobs * 5 + dc.gpuCount * dc.actualUtilization * 0.16);
  const background = session.scenario === 'demand_spike' ? 36 : 14;
  dc.queueDepth = clamp(dc.queueDepth + background - served, 0, 4000);
  dc.desiredUtilization = clamp(dc.desiredUtilization - 0.025 + dc.queueDepth / 26000, 0.18, 1.1);
  dc.latencyMs = Math.round(32 + dc.queueDepth / 24 + Math.max(0, dc.desiredUtilization - dc.schedulerCap) * 210);

  if (dc.batterySupportKw > 0) {
    dc.batterySoc = clamp(dc.batterySoc - dc.batterySupportKw / dc.batteryKwh / 70, 0.08, 0.96);
  } else {
    dc.batterySoc = clamp(dc.batterySoc + 0.0025, 0.08, 0.96);
  }
}

function updateSlurmScheduler(session: DemoSession, dc: DataCenterAgent) {
  dc.slurm ??= createDefaultSlurm(dc.gpuCount, 1);
  const allocationCap = dc.gridAllocation?.allocatedUtilization ?? dc.schedulerCap;
  const capGpus = Math.floor(dc.gpuCount * Math.min(dc.schedulerCap, allocationCap));
  const gridConstrained = session.grid.health !== 'normal' || dc.schedulerCap < 0.72;
  const requestedGpus = Math.ceil(dc.desiredUtilization * dc.gpuCount);
  dc.slurm.maxGpus = dc.gpuCount;
  dc.slurm.targetGpus = clamp(Math.max(requestedGpus, dc.slurm.pendingJobs * 4), 0, dc.gpuCount);

  if (gridConstrained) {
    const held = Math.ceil(dc.slurm.pendingJobs * 0.18);
    dc.slurm.heldJobs = clamp(dc.slurm.heldJobs + held, 0, 999);
    dc.slurm.pendingJobs = clamp(dc.slurm.pendingJobs - Math.floor(held * 0.4), 0, 999);
    dc.slurm.state = dc.schedulerCap < 0.5 ? 'draining' : 'throttled';
    dc.slurm.reason = `Grid agent cap active; Slurm holds backfill and limits allocation to ${capGpus} GPUs.`;
  } else if (dc.slurm.state !== 'manual_override') {
    const released = Math.min(dc.slurm.heldJobs, 2);
    dc.slurm.heldJobs -= released;
    dc.slurm.pendingJobs += released;
    dc.slurm.state = 'normal';
    dc.slurm.reason = 'Backfill window open; scheduler admits queued inference jobs.';
  }

  const admitJobs = Math.min(dc.slurm.pendingJobs, Math.max(0, Math.floor((capGpus - dc.slurm.allocatedGpus) / 6) + 2));
  dc.slurm.pendingJobs -= admitJobs;
  dc.slurm.runningJobs += admitJobs;

  const finishedJobs = Math.min(dc.slurm.runningJobs, Math.max(1, Math.floor(dc.slurm.runningJobs * 0.16)));
  dc.slurm.runningJobs -= finishedJobs;
  dc.slurm.completedJobs += finishedJobs;

  if (gridConstrained && dc.slurm.runningJobs > 0 && session.tick % 5 === 0) {
    dc.slurm.preemptions += 1;
    dc.slurm.runningJobs = Math.max(0, dc.slurm.runningJobs - 1);
    dc.slurm.heldJobs += 1;
  }

  const desiredAllocation = dc.slurm.runningJobs * 6 + dc.slurm.pendingJobs * 1.4;
  dc.slurm.allocatedGpus = Math.round(clamp(desiredAllocation, 0, capGpus));
  dc.slurm.backfillWindowMinutes = gridConstrained ? 4 : clamp(12 + Math.round((1 - dc.actualUtilization) * 18), 6, 30);
}

function createDefaultSlurm(gpuCount: number, index: number) {
  return {
    state: 'normal' as const,
    partition: 'inference' as const,
    pendingJobs: 8 + index * 2,
    runningJobs: 4 + index,
    completedJobs: 0,
    heldJobs: 0,
    allocatedGpus: Math.min(gpuCount, 24 + index * 6),
    targetGpus: Math.min(gpuCount, 32 + index * 8),
    maxGpus: gpuCount,
    backfillWindowMinutes: 18,
    preemptions: 0,
    reason: 'Accepting inference jobs.',
  };
}

function applyGridAgentNegotiation(session: DemoSession) {
  const shouldRequestRelief = session.grid.lineLoadingMax > 0.84 || session.grid.voltageMin < 0.972;
  const canRestore = session.grid.lineLoadingMax < 0.75 && session.grid.voltageMin > 0.982;

  if (shouldRequestRelief) {
    addEvent(session, 'grid-agent', 'data-center-agents', 'REQUEST_RELIEF', 'Offer flexible GPU reductions and battery support.');
  }

  session.datacenters.forEach((dc) => {
    if (shouldRequestRelief) {
      const relief = dc.priority > 0.75 ? 0.035 : dc.priority > 0.55 ? 0.065 : 0.095;
      dc.schedulerCap = clamp(dc.schedulerCap - relief, 0.38, 0.94);
      dc.batterySupportKw = dc.batterySoc > 0.18 ? clamp(dc.batterySupportKw + 28, 0, 180) : 0;
      dc.slurm.state = dc.schedulerCap < 0.5 ? 'draining' : 'throttled';
      dc.slurm.reason = `Grid relief active; preemptable jobs are held and GPU allocation is capped at ${Math.round(dc.schedulerCap * 100)}%.`;
      dc.lastInstruction = `Negotiated relief: cap ${Math.round(dc.schedulerCap * 100)}%, battery ${Math.round(dc.batterySupportKw)} kW.`;
      addEvent(session, dc.name, 'grid-agent', 'RELIEF_OFFER', `${dc.name} offers ${Math.round((1 - dc.schedulerCap) * dc.gpuCount * dc.gpuKw)} kW flexible GPU relief.`);
    } else if (canRestore) {
      dc.schedulerCap = clamp(dc.schedulerCap + 0.035, 0.42, 0.9);
      dc.batterySupportKw = clamp(dc.batterySupportKw - 24, 0, 180);
      dc.slurm.state = 'normal';
      dc.slurm.reason = 'Grid restored; scheduler is releasing held jobs gradually.';
      dc.lastInstruction = 'Grid margin recovered; restoring scheduler capacity gradually.';
    } else {
      dc.batterySupportKw = clamp(dc.batterySupportKw - 8, 0, 180);
      dc.lastInstruction = 'Monitoring grid agent instructions.';
    }
  });
}

export function applyGridAgentAllocation(session: DemoSession) {
  const pressure = scenarioPressure[session.scenario];
  const transformerBudgetKw = pressure.capacityKw * 0.92;
  const reserveHoldKw = session.scenario === 'nominal' ? 620 : session.scenario === 'demand_spike' ? 980 : 820;
  const budgetKw = Math.max(0, transformerBudgetKw - reserveHoldKw);
  const constraint = allocationConstraint(session);
  const requests = session.datacenters.map((dc) => {
    const requestedUtilization = clamp(
      Math.max(dc.desiredUtilization, dc.actualUtilization, (dc.slurm?.targetGpus ?? 0) / Math.max(1, dc.gpuCount)),
      0.16,
      1
    );
    const floorUtilization = dc.priority > 0.75 ? 0.34 : dc.priority > 0.55 ? 0.26 : 0.18;
    const minUtilization = clamp(Math.min(requestedUtilization, floorUtilization), 0.12, 0.5);
    const requestedKw = kwForUtilization(dc, pressure.cooling, requestedUtilization);
    const minimumKw = kwForUtilization(dc, pressure.cooling, minUtilization);
    const flexibleKw = Math.max(0, requestedKw - minimumKw);
    const weight = 0.65 + dc.priority * 1.8 + (dc.slurm?.partition === 'priority' ? 0.65 : 0) + Math.min(0.5, dc.queueDepth / 8000);
    return { dc, requestedUtilization, minUtilization, requestedKw, minimumKw, flexibleKw, weight };
  });

  const totalRequested = requests.reduce((sum, item) => sum + item.requestedKw, 0);
  const totalMinimum = requests.reduce((sum, item) => sum + item.minimumKw, 0);
  let extraBudget = Math.max(0, budgetKw - totalMinimum);
  let totalWeight = requests.reduce((sum, item) => sum + (item.flexibleKw > 0 ? item.weight : 0), 0);
  const allocatedExtras = new Map<string, number>();

  for (const item of requests) {
    allocatedExtras.set(item.dc.id, 0);
  }

  for (let pass = 0; pass < requests.length && extraBudget > 0.1 && totalWeight > 0; pass += 1) {
    let usedThisPass = 0;
    for (const item of requests) {
      const already = allocatedExtras.get(item.dc.id) ?? 0;
      const remainingFlexible = Math.max(0, item.flexibleKw - already);
      if (remainingFlexible <= 0) continue;
      const share = Math.min(remainingFlexible, (extraBudget * item.weight) / totalWeight);
      allocatedExtras.set(item.dc.id, already + share);
      usedThisPass += share;
    }
    if (usedThisPass <= 0.1) break;
    extraBudget -= usedThisPass;
    totalWeight = requests.reduce((sum, item) => {
      const already = allocatedExtras.get(item.dc.id) ?? 0;
      return sum + (item.flexibleKw - already > 0.1 ? item.weight : 0);
    }, 0);
  }

  requests.forEach((item) => {
    const extra = totalRequested <= budgetKw ? item.flexibleKw : allocatedExtras.get(item.dc.id) ?? 0;
    const allocatedKw = Math.min(item.requestedKw, item.minimumKw + extra);
    const allocatedUtilization = utilizationForKw(item.dc, pressure.cooling, allocatedKw);
    const deferredKw = Math.max(0, item.requestedKw - allocatedKw);
    item.dc.gridAllocation = {
      requestedKw: item.requestedKw,
      allocatedKw,
      deferredKw,
      requestedUtilization: item.requestedUtilization,
      allocatedUtilization,
      batteryDispatchKw: item.dc.batterySupportKw,
      constraint: totalRequested <= budgetKw ? 'none' : constraint,
      reason:
        totalRequested <= budgetKw
          ? 'Grid agent cleared requested GPU load within reserve posture.'
          : `Grid agent allocated ${Math.round(allocatedKw)} kW of ${Math.round(item.requestedKw)} kW requested to hold ${Math.round(reserveHoldKw)} kW reserve.`,
    };
    item.dc.lastInstruction =
      deferredKw > 20
        ? `Grid allocation active: ${Math.round(allocatedKw)} kW cleared, ${Math.round(deferredKw)} kW deferred.`
        : 'Grid allocation cleared requested load.';
  });
}

function kwForDataCenter(dc: DataCenterAgent, coolingFactor: number) {
  if (dc.gridAllocation) return dc.gridAllocation.allocatedKw;
  return kwForUtilization(dc, coolingFactor, Math.max(dc.actualUtilization, dc.slurm.allocatedGpus / Math.max(1, dc.gpuCount)));
}

function kwForUtilization(dc: DataCenterAgent, coolingFactor: number, utilization: number) {
  const util = clamp(utilization, 0, 1.1);
  const computeKw = dc.gpuCount * dc.gpuKw * util;
  const coolingKw = computeKw * coolingFactor;
  return Math.max(0, dc.baseKw + computeKw + coolingKw - dc.batterySupportKw);
}

function utilizationForKw(dc: DataCenterAgent, coolingFactor: number, kw: number) {
  const computeKw = Math.max(0, (kw + dc.batterySupportKw - dc.baseKw) / (1 + coolingFactor));
  return clamp(computeKw / Math.max(1, dc.gpuCount * dc.gpuKw), 0.12, 1);
}

function createAllocation(
  dc: DataCenterAgent,
  scenario: Scenario,
  allocatedUtilization: number,
  constraint: 'none' | 'voltage' | 'line' | 'transformer' | 'reserve',
  reason: string
) {
  const cooling = scenarioPressure[scenario].cooling;
  const requestedUtilization = clamp(Math.max(dc.desiredUtilization, dc.actualUtilization), 0.16, 1);
  const requestedKw = kwForUtilization(dc, cooling, requestedUtilization);
  const allocatedKw = kwForUtilization(dc, cooling, allocatedUtilization);
  return {
    requestedKw,
    allocatedKw,
    deferredKw: Math.max(0, requestedKw - allocatedKw),
    requestedUtilization,
    allocatedUtilization,
    batteryDispatchKw: dc.batterySupportKw,
    constraint,
    reason,
  };
}

function allocationConstraint(session: DemoSession): 'none' | 'voltage' | 'line' | 'transformer' | 'reserve' {
  if (session.grid.violations.includes('low_voltage') || session.grid.voltageMin < 0.972) return 'voltage';
  if (session.grid.violations.includes('transformer_overload') || (session.grid.transformerLoading ?? 0) > 0.94) return 'transformer';
  if (session.grid.violations.includes('line_overload') || session.grid.lineLoadingMax > 0.84) return 'line';
  if (session.grid.reserveKw < 900) return 'reserve';
  return 'none';
}

function legacyKwForDataCenter(dc: DataCenterAgent, coolingFactor: number) {
  const slurmUtilization = dc.slurm.allocatedGpus / Math.max(1, dc.gpuCount);
  const computeKw = dc.gpuCount * dc.gpuKw * Math.max(dc.actualUtilization, slurmUtilization);
  const coolingKw = computeKw * coolingFactor;
  return dc.baseKw + computeKw + coolingKw - dc.batterySupportKw;
}

export function appendAgentEvent(session: DemoSession, from: string, to: string, type: string, body: string) {
  addEvent(session, from, to, type, body);
}

function addEvent(session: DemoSession, from: string, to: string, type: string, body: string) {
  const event: AgentEvent = {
    id: crypto.randomUUID().slice(0, 10),
    at: Date.now(),
    from,
    to,
    type,
    body,
  };
  session.events = [event, ...session.events].slice(0, 80);
}

function touch(session: DemoSession) {
  session.updatedAt = Date.now();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
