'use client';

import { useEffect, useMemo, useState } from 'react';
import { GridMap } from '@/components/GridMap';
import type { DataCenterAgent, DemoSession, Scenario } from '@/lib/types';
import { summarizeKw } from '@/lib/simulation';

const DEFAULT_SESSION_ID = 'default';

const scenarios: { value: Scenario; label: string }[] = [
  { value: 'nominal', label: 'Nominal' },
  { value: 'heatwave', label: 'Heatwave cooling surge' },
  { value: 'feeder_constraint', label: 'Feeder constraint' },
  { value: 'renewable_drop', label: 'Renewable drop' },
  { value: 'demand_spike', label: 'Demand spike' },
];

export default function DashboardPage() {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [chatMessage, setChatMessage] = useState('');

  useEffect(() => {
    refresh(DEFAULT_SESSION_ID);
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    const interval = window.setInterval(async () => {
      const response = await fetch(`/api/sessions/${session.id}/tick`, { method: 'POST' });
      if (response.ok) {
        const data = (await response.json()) as { session: DemoSession };
        setSession(data.session);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [session?.id]);

  const joinUrl = useMemo(() => {
    if (!session) return '';
    return `${window.location.origin}/join`;
  }, [session]);

  async function refresh(id: string) {
    const response = await fetch(`/api/sessions/${id}/state`);
    if (!response.ok) return;
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function changeScenario(scenario: Scenario) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/scenario`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    const data = (await response.json()) as { session: DemoSession };
    setSession(data.session);
  }

  async function sendOperatorMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !chatMessage.trim()) return;
    const message = chatMessage;
    setChatMessage('');
    const response = await fetch(`/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  async function overrideDataCenter(
    datacenterId: string,
    override: { schedulerCap?: number; batterySupportKw?: number; instruction: string }
  ) {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}/datacenters/${datacenterId}/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(override),
    });
    if (response.ok) {
      const data = (await response.json()) as { session: DemoSession };
      setSession(data.session);
    }
  }

  const drawLevel = session ? getDrawLevel(session) : 'waiting';
  const voltageTone =
    !session ? 'waiting' : session.grid.health === 'normal' ? 'steady' : session.grid.health === 'stressed' ? 'strained' : 'critical';
  const solverTone = session?.grid.solver === 'opendss' ? 'OpenDSS solve' : session ? 'approximate' : 'waiting';
  const dssPreview = session ? buildDssPreview(session) : null;

  return (
    <main className="shell dashboard">
      <header className="hero">
        <div>
          <p className="eyebrow">OpenDSS Agent Demo</p>
          <h1>Grid agent negotiates with live data-center agents</h1>
        </div>
        <div className="hero-actions">
          <a className="secondary-link" href="/join">Join page</a>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="map-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Grid site</p>
              <h2>{session ? `${session.site.name} · ${session.site.region}` : 'No session yet'}</h2>
            </div>
            {session && (
              <select value={session.scenario} onChange={(event) => changeScenario(event.target.value as Scenario)}>
                {scenarios.map((scenario) => <option key={scenario.value} value={scenario.value}>{scenario.label}</option>)}
              </select>
            )}
          </div>
          <div className="map-wrap"><GridMap session={session} /></div>
        </div>

        <aside className="side-stack">
          <section className="status-card" data-health={session?.grid.health ?? 'normal'}>
            <span>Grid status</span>
            <b>{session?.grid.health.toUpperCase() ?? 'WAITING'}</b>
            <small>{session ? 'Default shared session' : 'Loading default session'}</small>
          </section>
          <section className="metrics">
            <Metric label="Grid health" value={voltageTone} />
            <Metric label="Relative draw" value={drawLevel} />
            <Metric label="Readout" value={solverTone} />
            <Metric label="Data centers" value={session ? String(session.datacenters.length) : '-'} />
          </section>
          <section className="join-card">
            <p className="eyebrow">Participant entry</p>
            <h2>Users go to the website and join the shared grid</h2>
            <input readOnly value={joinUrl || 'Loading join link'} />
          </section>
        </aside>
      </section>

      <section className="lower-grid">
        <section className="panel">
          <div className="panel-head compact">
            <div>
              <p className="eyebrow">Data-center agents</p>
              <h2>GPU scheduler state</h2>
            </div>
          </div>
          <div className="agent-list">
            {session?.datacenters.length ? session.datacenters.map((dc) => (
              <article className="agent-row" key={dc.id}>
                <div>
                  <b>{dc.name}</b>
                  <span>{Math.round(summarizeKw(dc, session.scenario))} kW · {dc.slurm?.runningJobs ?? 0} running · {dc.slurm?.pendingJobs ?? 0} pending</span>
                </div>
                <div className="bar"><i style={{ width: `${Math.round(dc.actualUtilization * 100)}%` }} /></div>
                <small>{dc.slurm?.state ?? 'normal'} · {dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount)}/{dc.gpuCount} GPUs · cap {Math.round(dc.schedulerCap * 100)}%</small>
                <div className="slurm-strip">
                  <span>held {dc.slurm?.heldJobs ?? 0}</span>
                  <span>done {dc.slurm?.completedJobs ?? 0}</span>
                  <span>backfill {dc.slurm?.backfillWindowMinutes ?? 0}m</span>
                  <span>preempt {dc.slurm?.preemptions ?? 0}</span>
                </div>
                <div className="override-buttons">
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        schedulerCap: Math.max(0.32, dc.schedulerCap - 0.1),
                        instruction: `Manual override: reduce scheduler cap to ${Math.round(Math.max(0.32, dc.schedulerCap - 0.1) * 100)}%.`,
                      })
                    }
                  >
                    Cap down
                  </button>
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        schedulerCap: Math.min(0.96, dc.schedulerCap + 0.1),
                        instruction: `Manual override: restore scheduler cap to ${Math.round(Math.min(0.96, dc.schedulerCap + 0.1) * 100)}%.`,
                      })
                    }
                  >
                    Cap up
                  </button>
                  <button
                    onClick={() =>
                      overrideDataCenter(dc.id, {
                        batterySupportKw: Math.min(220, dc.batterySupportKw + 50),
                        instruction: `Manual override: commit ${Math.round(Math.min(220, dc.batterySupportKw + 50))} kW battery support.`,
                      })
                    }
                  >
                    +Battery
                  </button>
                </div>
              </article>
            )) : <div className="empty">No data centers have joined yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head compact">
            <div>
              <p className="eyebrow">A2A negotiation</p>
              <h2>Live agent messages</h2>
            </div>
          </div>
          <div className="event-list">
            {session?.events.map((event) => (
              <article key={event.id} className="event">
                <div><b>{event.type}</b><span>{new Date(event.at).toLocaleTimeString()}</span></div>
                <p>{event.from} {'->'} {event.to}</p>
                <small>{event.body}</small>
              </article>
            )) ?? <div className="empty">Waiting for a session.</div>}
          </div>
          <form className="chat-form" onSubmit={sendOperatorMessage}>
            <input
              value={chatMessage}
              onChange={(event) => setChatMessage(event.target.value)}
              placeholder="Broadcast an instruction to the grid agent"
              disabled={!session}
            />
            <button disabled={!session || !chatMessage.trim()}>Send</button>
          </form>
        </section>
      </section>

      <section className="panel dss-panel">
        <div className="panel-head compact">
          <div>
            <p className="eyebrow">OpenDSS system</p>
            <h2>Actual circuit being solved</h2>
          </div>
          <span className="solver-badge">{session?.grid.solver === 'opendss' ? 'Live OpenDSS' : 'Approx fallback'}</span>
        </div>
        {dssPreview ? (
          <>
            <div className="dss-facts">
              <span><b>Scenario</b>{scenarioLabel(dssPreview.scenario)}</span>
              <span><b>Source</b>{dssPreview.config.sourcePu.toFixed(3)} pu</span>
              <span><b>Transformer</b>{dssPreview.config.substationKva.toLocaleString()} kVA</span>
              <span><b>Feeder limit</b>{dssPreview.config.lineNormamps} A</span>
              <span><b>Total load</b>{Math.round(dssPreview.feederKw).toLocaleString()} kW</span>
            </div>
            <pre className="dss-commands" aria-label="OpenDSS command list">
              {dssPreview.commands.map((command, index) => `${String(index + 1).padStart(2, '0')}. ${command}`).join('\n')}
            </pre>
          </>
        ) : (
          <div className="empty">Waiting for the default session.</div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><b>{value}</b></div>;
}

function getDrawLevel(session: DemoSession) {
  if (!session.datacenters.length) return 'idle';
  const averageDraw =
    session.datacenters.reduce((sum, dc) => {
      const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
      return sum + Math.max(dc.actualUtilization, allocated / Math.max(1, dc.gpuCount));
    }, 0) / session.datacenters.length;
  if (averageDraw > 0.68) return 'heavy';
  if (averageDraw > 0.36) return 'moderate';
  return 'light';
}

type DssConfig = {
  sourcePu: number;
  substationKva: number;
  lineNormamps: number;
  cooling: number;
};

function getScenarioConfig(scenario: Scenario): DssConfig {
  const configs: Record<Scenario, DssConfig> = {
    nominal: { sourcePu: 1.02, substationKva: 8500, lineNormamps: 430, cooling: 0.28 },
    heatwave: { sourcePu: 1, substationKva: 7600, lineNormamps: 390, cooling: 0.44 },
    feeder_constraint: { sourcePu: 0.985, substationKva: 6500, lineNormamps: 320, cooling: 0.32 },
    renewable_drop: { sourcePu: 0.992, substationKva: 7000, lineNormamps: 360, cooling: 0.3 },
    demand_spike: { sourcePu: 1, substationKva: 7800, lineNormamps: 380, cooling: 0.36 },
  };
  return configs[scenario];
}

function buildDssPreview(session: DemoSession) {
  const config = getScenarioConfig(session.scenario);
  const commands = [
    'Clear',
    `New Circuit.AgentGrid basekv=12.47 pu=${config.sourcePu} phases=3 bus1=sourcebus angle=0 MVAsc3=200000 MVAsc1=210000`,
    `New Transformer.Substation phases=3 windings=2 buses=(sourcebus,subbus) conns=(wye,wye) kvs=(12.47,12.47) kvas=(${config.substationKva},${config.substationKva}) %rs=(0.2,0.2) xhl=1.25`,
    `New Linecode.Feeder nphases=3 r1=0.26 x1=0.34 r0=0.52 x0=1.08 units=km normamps=${config.lineNormamps}`,
    'New Line.Backbone bus1=subbus bus2=bus0 phases=3 linecode=Feeder length=0.35 units=km',
  ];
  let feederKw = 0;

  session.datacenters.forEach((dc, index) => {
    const loadNumber = index + 1;
    const bus = `dc${loadNumber}bus`;
    const lengthKm = 0.45 + (loadNumber % 4) * 0.18;
    const kw = datacenterKw(dc, config.cooling);
    const kvar = kw * 0.33;
    feederKw += kw;
    commands.push(`New Line.DC${loadNumber} bus1=bus0 bus2=${bus} phases=3 linecode=Feeder length=${lengthKm.toFixed(3)} units=km`);
    commands.push(
      `New Load.Load${loadNumber} bus1=${bus} phases=3 conn=wye kv=12.47 kw=${kw.toFixed(3)} kvar=${kvar.toFixed(3)} model=1`
    );
  });

  if (!session.datacenters.length) {
    feederKw = 80;
    commands.push('New Load.StationService bus1=bus0 phases=3 conn=wye kv=12.47 kw=80 kvar=25 model=1');
  }

  commands.push('Set Voltagebases=[12.47]', 'CalcVoltageBases', 'Set maxcontroliter=50', 'Solve');
  return { commands, config, feederKw, scenario: session.scenario };
}

function datacenterKw(dc: DataCenterAgent, coolingFactor: number) {
  const allocated = dc.slurm?.allocatedGpus ?? Math.round(dc.actualUtilization * dc.gpuCount);
  const util = Math.max(dc.actualUtilization, allocated / Math.max(1, dc.gpuCount));
  const computeKw = dc.gpuCount * dc.gpuKw * util;
  return Math.max(0, dc.baseKw + computeKw + computeKw * coolingFactor - dc.batterySupportKw);
}

function scenarioLabel(scenario: Scenario) {
  return scenario.replaceAll('_', ' ');
}
