import type { Scenario } from './types';

export const scenarioOptions: { value: Scenario; label: string; brief: string }[] = [
  {
    value: 'nominal',
    label: 'Readiness posture',
    brief: 'Normal grid operations with reserve held for critical loads.',
  },
  {
    value: 'heatwave',
    label: 'Continuity load surge',
    brief: 'Mission facilities and data centers increase cooling and inference demand.',
  },
  {
    value: 'feeder_constraint',
    label: 'Corridor interdiction',
    brief: 'A constrained feeder corridor forces local agents to shed flexible GPU load.',
  },
  {
    value: 'renewable_drop',
    label: 'Generation shortfall',
    brief: 'A sudden supply loss reduces margin and requires reserve-aware scheduling.',
  },
  {
    value: 'demand_spike',
    label: 'Cyber response compute spike',
    brief: 'Incident-response workloads create a burst of priority inference demand.',
  },
];

export function scenarioLabel(scenario: Scenario) {
  return scenarioOptions.find((option) => option.value === scenario)?.label ?? scenario.replaceAll('_', ' ');
}

export function scenarioBrief(scenario: Scenario) {
  return scenarioOptions.find((option) => option.value === scenario)?.brief ?? 'Scenario context unavailable.';
}
