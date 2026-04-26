export type GridHealth = 'normal' | 'stressed' | 'emergency';

export type Scenario = 'nominal' | 'heatwave' | 'feeder_constraint' | 'renewable_drop' | 'demand_spike';

export type RequestType =
  | 'standard_inference'
  | 'priority_inference'
  | 'batch_inference'
  | 'urgent_burst';

export type AgentEvent = {
  id: string;
  at: number;
  from: string;
  to: string;
  type: string;
  body: string;
};

export type GridSite = {
  name: string;
  lat: number;
  lng: number;
  region: string;
};

export type GridState = {
  health: GridHealth;
  voltageMin: number;
  lineLoadingMax: number;
  reserveKw: number;
  lossesKw: number;
  frequencyHz: number;
  violations: string[];
  solver?: 'opendss' | 'approximate';
  feederKw?: number;
  transformerLoading?: number;
  lineLoadings?: GridLineLoading[];
  datacenterLoads?: GridDataCenterLoad[];
  /** Firm capacity the grid can serve this scenario (kW). Single source of truth. */
  totalCapacityKw?: number;
  /** Headroom budget the agent can hand out (kW). */
  agentBudgetKw?: number;
};

export type GridLineLoading = {
  name: string;
  loading: number;
  amps: number;
};

export type GridDataCenterLoad = {
  id?: string;
  name: string;
  bus: string;
  kw: number;
  kvar: number;
  requestedKw?: number;
  allocatedKw?: number;
  deferredKw?: number;
  allocatedUtilization?: number;
  line: string;
  lineLoading?: number;
  lineAmps?: number;
};

export type GridAllocation = {
  requestedKw: number;
  allocatedKw: number;
  deferredKw: number;
  requestedUtilization: number;
  allocatedUtilization: number;
  batteryDispatchKw: number;
  constraint: 'none' | 'voltage' | 'line' | 'transformer' | 'reserve';
  reason: string;
  /** Fraction of grid totalCapacityKw allocated to this DC (0-1). */
  fraction?: number;
  /** Source of the allocation: deterministic fallback or LLM tool-call. */
  source?: 'deterministic' | 'llm';
};

export type SlurmScheduler = {
  state: 'normal' | 'throttled' | 'manual_override' | 'draining';
  partition: 'inference' | 'batch' | 'priority';
  pendingJobs: number;
  runningJobs: number;
  completedJobs: number;
  heldJobs: number;
  allocatedGpus: number;
  targetGpus: number;
  maxGpus: number;
  backfillWindowMinutes: number;
  preemptions: number;
  reason: string;
};

export type DataCenterAgent = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  joinedAt: number;
  gpuCount: number;
  gpuKw: number;
  baseKw: number;
  queueDepth: number;
  desiredUtilization: number;
  actualUtilization: number;
  schedulerCap: number;
  latencyMs: number;
  batteryKwh: number;
  batterySoc: number;
  batterySupportKw: number;
  priority: number;
  lastInstruction: string;
  slurm: SlurmScheduler;
  gridAllocation?: GridAllocation;
};

export type DemoSession = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  tick: number;
  running: boolean;
  scenario: Scenario;
  site: GridSite;
  grid: GridState;
  datacenters: DataCenterAgent[];
  events: AgentEvent[];
};

export type SessionSummary = {
  id: string;
  label: string;
  locationName: string;
  health: GridHealth;
  participantCount: number;
  updatedAt: number;
};
