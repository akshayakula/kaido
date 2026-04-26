'use client';

import { useEffect, useRef, useState } from 'react';

const DEFAULT_PROMPTS = ['popping', 'transformer hum', 'arcing'];

type LogEntry = { t: number; kind: string; line: string };

type SourceListEntry = { name: string; files: string[] };

type DeviceAudioPanelProps = {
  device: string;
};

// Workspace name on the franklin server. Sanitized to match _safe_name() rules
// in franklin/server/app.py (alphanumerics + ._-).
function workspaceFor(device: string) {
  return device.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'device';
}

export function DeviceAudioPanel({ device }: DeviceAudioPanelProps) {
  const workspace = workspaceFor(device);
  const [prompts, setPrompts] = useState<string>(DEFAULT_PROMPTS.join('; '));
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'uploading' | 'running' | 'done' | 'error'>('idle');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<SourceListEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evtRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Load prior outputs (if any) when the panel mounts so the user sees what
  // was last produced for this workspace.
  useEffect(() => {
    let alive = true;
    fetch('/api/audio/sources')
      .then(r => r.json() as Promise<SourceListEntry[]>)
      .then(list => {
        if (!alive) return;
        const found = list.find(s => s.name === workspace) ?? null;
        setResults(found);
      })
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [workspace]);

  useEffect(() => {
    return () => { evtRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  async function refreshResults() {
    try {
      const list: SourceListEntry[] = await fetch('/api/audio/sources').then(r => r.json());
      setResults(list.find(s => s.name === workspace) ?? null);
    } catch {
      /* ignore */
    }
  }

  function streamJob(id: string) {
    setJobId(id);
    setLog([]);
    setState('running');
    evtRef.current?.close();
    const es = new EventSource(`/api/audio/jobs/${id}/events`);
    evtRef.current = es;
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setLog(prev => [...prev, entry]);
      } catch { /* ignore */ }
    };
    es.addEventListener('state', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { state: string };
        if (data.state === 'done') {
          setState('done');
          refreshResults();
        } else if (data.state === 'error') {
          setState('error');
        }
      } catch { /* ignore */ }
      es.close();
    });
    es.onerror = () => {
      // Browser will retry by default. If the job is already over the
      // 'state' event will have closed it.
    };
  }

  async function runOnExisting(workspaceName: string) {
    setError(null);
    const promptList = prompts.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
    if (promptList.length === 0) {
      setError('add at least one prompt');
      return;
    }
    setState('uploading');
    try {
      const r = await fetch('/api/audio/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: workspaceName, prompts: promptList }),
      });
      if (!r.ok) throw new Error(`run failed (${r.status}): ${await r.text()}`);
      const { jobId: id } = await r.json();
      streamJob(id);
    } catch (err) {
      setError(String(err));
      setState('error');
    }
  }

  async function uploadAndRun() {
    if (!file) {
      setError('choose a file first');
      return;
    }
    setError(null);
    setState('uploading');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', workspace);
      const up = await fetch('/api/audio/upload', { method: 'POST', body: fd });
      if (!up.ok) throw new Error(`upload failed (${up.status}): ${await up.text()}`);
      await runOnExisting(workspace);
    } catch (err) {
      setError(String(err));
      setState('error');
    }
  }

  async function runSampleChatter() {
    // The 'chatter' source already exists on the franklin server with input.mp3
    // sitting in work/chatter/. Just kick off a fresh run on it.
    await runOnExisting('chatter');
  }

  // Group output files by prompt suffix. SAM-Audio writes
  // target__<prompt>.wav and residual__<prompt>.wav into work/<workspace>/.
  const outputsByPrompt: Record<string, { target?: string; residual?: string }> = {};
  const resultWorkspace = state === 'done' || results?.name === 'chatter' ? results?.name : results?.name;
  for (const f of results?.files ?? []) {
    const m = f.match(/^(target|residual)__(.+)\.wav$/);
    if (!m) continue;
    const [, kind, prompt] = m;
    outputsByPrompt[prompt] ??= {};
    outputsByPrompt[prompt][kind as 'target' | 'residual'] = f;
  }
  const inputFile = (results?.files ?? []).find(f => f.startsWith('input.'));

  return (
    <div className="audio-panel">
      <div className="audio-panel__header">
        <span className="audio-panel__title">SAM-Audio · workspace <code>{workspace}</code></span>
        <span className={`audio-panel__state audio-panel__state--${state}`}>{state}</span>
      </div>

      <div className="audio-panel__row">
        <input
          className="audio-panel__prompts"
          value={prompts}
          onChange={e => setPrompts(e.target.value)}
          placeholder="prompts, semicolon-separated (popping; transformer hum; arcing)"
        />
      </div>

      <div className="audio-panel__row audio-panel__row--actions">
        <button
          type="button"
          className="audio-panel__btn audio-panel__btn--primary"
          onClick={runSampleChatter}
          disabled={state === 'uploading' || state === 'running'}
        >
          ▶ Use sample (chatter)
        </button>
        <label className="audio-panel__file">
          <input
            type="file"
            accept="audio/*"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
          <span>{file ? file.name : 'Choose audio file…'}</span>
        </label>
        <button
          type="button"
          className="audio-panel__btn"
          onClick={uploadAndRun}
          disabled={!file || state === 'uploading' || state === 'running'}
        >
          Upload + analyze
        </button>
      </div>

      {error && <div className="audio-panel__error">{error}</div>}

      {(state === 'running' || state === 'uploading' || log.length > 0) && (
        <div className="audio-panel__log" ref={logRef}>
          {log.length === 0
            ? <div className="audio-panel__log-line">starting…</div>
            : log.map((entry, i) => (
                <div key={i} className={`audio-panel__log-line audio-panel__log-line--${entry.kind}`}>
                  {entry.line}
                </div>
              ))}
        </div>
      )}

      {(Object.keys(outputsByPrompt).length > 0 || inputFile) && (
        <div className="audio-panel__results">
          <div className="audio-panel__results-title">Segmented audio</div>
          {inputFile && (
            <div className="audio-panel__result">
              <div className="audio-panel__result-label">input</div>
              <audio controls preload="none" src={`/api/audio/file/${encodeURIComponent(resultWorkspace || workspace)}/${encodeURIComponent(inputFile)}`} />
            </div>
          )}
          {Object.entries(outputsByPrompt).map(([prompt, files]) => {
            const display = prompt.replace(/_/g, ' ').replace(/-/g, ' ');
            return (
              <div key={prompt} className="audio-panel__result">
                <div className="audio-panel__result-label">{display}</div>
                {files.target && (
                  <div className="audio-panel__result-row">
                    <span className="audio-panel__result-tag">target</span>
                    <audio controls preload="none" src={`/api/audio/file/${encodeURIComponent(resultWorkspace || workspace)}/${encodeURIComponent(files.target)}`} />
                  </div>
                )}
                {files.residual && (
                  <div className="audio-panel__result-row">
                    <span className="audio-panel__result-tag">residual</span>
                    <audio controls preload="none" src={`/api/audio/file/${encodeURIComponent(resultWorkspace || workspace)}/${encodeURIComponent(files.residual)}`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
