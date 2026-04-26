/**
 * Thin client for gridstatus.io with rotating API keys + Upstash-backed
 * response cache. Free-plan keys cap at 250 requests/month, so we cache
 * aggressively (default 5 min for time-series, 1 hour for catalogs).
 */
import { redis } from './sensor-store';

const BASE = 'https://api.gridstatus.io/v1';

function keys(): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const k = process.env[`GRIDSTATUS_API_KEY_${i}`];
    if (k && k.trim()) out.push(k.trim());
  }
  if (process.env.GRIDSTATUS_API_KEY) out.push(process.env.GRIDSTATUS_API_KEY);
  return out;
}

async function fetchOne(path: string, params: Record<string, string>, key: string) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const r = await fetch(url, { headers: { 'x-api-key': key } });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() };
}

export type GridstatusFetchOptions = {
  cacheKey?: string;
  cacheTtlSeconds?: number;
};

/**
 * Fetch a gridstatus path with response caching in Upstash.
 * Rotates through GRIDSTATUS_API_KEY_1..8 on quota errors (429 / monthly cap).
 */
export async function gridstatusFetch<T = unknown>(
  path: string,
  params: Record<string, string> = {},
  opts: GridstatusFetchOptions = {},
): Promise<{ data: T; cached: boolean; key?: string }> {
  const r = redis();
  const cacheKey = opts.cacheKey ?? `gs:cache:${path}:${JSON.stringify(params)}`;
  const ttl = opts.cacheTtlSeconds ?? 300;

  // Cache hit
  if (r) {
    const cached = await r.get(cacheKey);
    if (cached) {
      const value = typeof cached === 'string' ? JSON.parse(cached) : (cached as T);
      return { data: value as T, cached: true };
    }
  }

  const apiKeys = keys();
  if (!apiKeys.length) throw new Error('No GRIDSTATUS_API_KEY_* configured');

  let lastErr: string | null = null;
  for (const k of apiKeys) {
    const res = await fetchOne(path, params, k);
    if (res.ok) {
      if (r) await r.set(cacheKey, JSON.stringify(res.body), { ex: ttl });
      return { data: res.body as T, cached: false, key: k.slice(0, 8) + '…' };
    }
    if (res.status === 429 || res.status === 402 || res.status === 403) {
      lastErr = `key ${k.slice(0, 8)}… → ${res.status}`;
      continue;
    }
    throw new Error(`gridstatus ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  }
  throw new Error(`all gridstatus keys exhausted: ${lastErr}`);
}

// -------- typed helpers --------

export type DomLoadSample = {
  interval_start_utc: string;
  interval_end_utc: string;
  zone: string;
  load_area: string;
  mw: number;
  is_verified: boolean;
};

export async function getLatestDomLoad(): Promise<DomLoadSample | null> {
  // pjm_load_metered_hourly publishes ~24-30 hours behind real-time, so
  // the freshest available row is at "yesterday minus a few". Use a wide
  // window to guarantee at least one DOM row and let the client-side
  // filter pick the latest.
  const end = new Date(Date.now() - 12 * 3600 * 1000);
  const start = new Date(end.getTime() - 36 * 3600 * 1000);
  const { data } = await gridstatusFetch<{ data: DomLoadSample[] }>(
    '/datasets/pjm_load_metered_hourly/query',
    {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      'filter[zone]': 'DOM',
      limit: '5000',
    },
    { cacheKey: 'gs:dom_load:latest', cacheTtlSeconds: 1800 },
  );
  const dom = (data?.data ?? []).filter((r) => r.zone === 'DOM');
  if (!dom.length) return null;
  dom.sort((a, b) => Date.parse(b.interval_start_utc) - Date.parse(a.interval_start_utc));
  return dom[0];
}

export type FuelMixSample = {
  time_utc: string;
  [fuel: string]: string | number;
};

export async function getLatestPjmFuelMix(): Promise<FuelMixSample | null> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  const { data } = await gridstatusFetch<{ data: FuelMixSample[] }>(
    '/datasets/pjm_fuel_mix/query',
    {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      limit: '50',
    },
    { cacheKey: 'gs:pjm_fuel_mix:latest', cacheTtlSeconds: 300 },
  );
  const rows = data?.data ?? [];
  if (!rows.length) return null;
  rows.sort((a, b) => Date.parse(String(b.time_utc)) - Date.parse(String(a.time_utc)));
  return rows[0];
}
