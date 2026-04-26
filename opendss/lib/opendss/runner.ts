import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DemoSession, GridState } from '../types';

type SolverResponse = {
  ok: boolean;
  error?: string;
  grid?: GridState;
};

const scenarioCooling: Record<string, number> = {
  nominal: 0.28,
  heatwave: 0.44,
  feeder_constraint: 0.32,
  renewable_drop: 0.3,
  demand_spike: 0.36,
};

export async function solveWithOpenDss(session: DemoSession, fallback: GridState): Promise<GridState> {
  const python = process.env.OPENDSS_PYTHON || 'python3';
  const script = path.join(process.cwd(), 'opendss-engine', 'solve_grid.py');
  const payload = {
    scenario: session.scenario,
    coolingFactor: scenarioCooling[session.scenario] ?? 0.34,
    datacenters: session.datacenters,
  };

  try {
    const result = await runPythonSolver(python, script, payload);
    if (result.ok && result.grid) return result.grid;
    return {
      ...fallback,
      solver: 'approximate',
      violations: [...fallback.violations, result.error ? `opendss_unavailable:${result.error}` : 'opendss_unavailable'],
    };
  } catch (error) {
    return {
      ...fallback,
      solver: 'approximate',
      violations: [...fallback.violations, `opendss_unavailable:${error instanceof Error ? error.message : 'unknown'}`],
    };
  }
}

function runPythonSolver(python: string, script: string, payload: unknown): Promise<SolverResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      const text = stdout.trim();
      if (!text) {
        resolve({ ok: false, error: stderr.trim() || 'solver returned no output' });
        return;
      }
      try {
        resolve(JSON.parse(text) as SolverResponse);
      } catch (error) {
        reject(new Error(`invalid OpenDSS solver output: ${error instanceof Error ? error.message : 'unknown'}`));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
