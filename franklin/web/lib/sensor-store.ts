/**
 * Typed read-only client for the sensor + audio fusion schema in Upstash.
 *
 * Schema mirrors `franklin/fusion/upstash.py`:
 *   device:<id>:tele      LIST  telemetry samples (newest first)
 *   device:<id>:audio     LIST  audio-feature snapshots
 *   device:<id>:score     STRING JSON envelope from fusion runner
 *   device:<id>:meta      STRING JSON device metadata
 *   telemetry:latest:<id> STRING JSON latest single telemetry payload
 *   devices               SET   all known device ids
 *   zone:<z>:devices      SET   devices in zone
 *   zone:<z>:score        STRING JSON zone resilience score
 *   events                LIST  state-transition / alert events
 */
import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

export function redis(): Redis | null {
  if (_redis) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  _redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return _redis;
}

export type DeviceState = 'NORMAL' | 'STRESSED' | 'EMERGENCY' | 'RECOVERING' | 'OFFLINE';

export type DeviceMeta = {
  device: string;
  name?: string;
  zone?: string;
  profile?: string;
  registered_at?: number;
};

export type TelemetrySample = {
  ts: number;
  device: string;
  zone?: string;
  temp_c: number;
  humidity: number;
  baseline_c?: number | null;
  delta_c?: number | null;
  stable?: boolean | null;
  stddev_c?: number | null;
};

export type AudioSnapshot = {
  ts: number;
  device: string;
  pop_count: number;
  pop_amp_p95?: number;
  pop_intensity_db?: number;
  pop_inter_interval_med?: number;
  noise_floor_db?: number;
  threshold_db?: number;
  clip_seconds?: number;
};

export type DeviceScore = {
  ts: number;
  device: string;
  state: DeviceState;
  health: number;
  components: {
    thermal: number;
    humidity: number;
    audio: number;
    joint: number;
    stability: number;
  };
  flags: string[];
  transitions_24h: number;
  features: Record<string, number>;
};

export type ZoneScore = {
  ts: number;
  device_count: number;
  min_health: number | null;
  mean_health: number | null;
  emergency_fraction: number;
  stressed_fraction: number;
  transitions_per_hour: number;
  freq_band_factor: number;
  zone_resilience: number | null;
  states: Record<string, number>;
};

export type EventRow = {
  ts: number;
  device: string;
  kind: string;
  from?: string;
  to?: string;
  health?: number;
  flags?: string[];
};

const j = <T,>(v: unknown): T | null => {
  if (!v) return null;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  return null;
};

export async function listDeviceIds(): Promise<string[]> {
  const r = redis(); if (!r) return [];
  const ids = await r.smembers('devices');
  return Array.isArray(ids) ? ids.sort() : [];
}

export async function getDeviceMeta(id: string) {
  const r = redis(); if (!r) return null;
  return j<DeviceMeta>(await r.get(`device:${id}:meta`));
}

export async function getDeviceScore(id: string) {
  const r = redis(); if (!r) return null;
  return j<DeviceScore>(await r.get(`device:${id}:score`));
}

export async function getDeviceLatest(id: string) {
  const r = redis(); if (!r) return null;
  return j<TelemetrySample>(await r.get(`telemetry:latest:${id}`));
}

export async function getDeviceTelemetry(id: string, limit = 200) {
  const r = redis(); if (!r) return [];
  const raw = (await r.lrange(`device:${id}:tele`, 0, limit - 1)) ?? [];
  return raw.map((x) => j<TelemetrySample>(x)).filter((x): x is TelemetrySample => !!x);
}

export async function getDeviceAudio(id: string, limit = 40) {
  const r = redis(); if (!r) return [];
  const raw = (await r.lrange(`device:${id}:audio`, 0, limit - 1)) ?? [];
  return raw.map((x) => j<AudioSnapshot>(x)).filter((x): x is AudioSnapshot => !!x);
}

export async function listZones() {
  const r = redis(); if (!r) return {};
  const out: Record<string, ZoneScore> = {};
  let cursor = '0';
  const matched: string[] = [];
  do {
    const [next, batch] = (await r.scan(cursor, { match: 'zone:*:score', count: 100 })) as [string, string[]];
    matched.push(...batch);
    cursor = next;
  } while (cursor !== '0' && matched.length < 500);
  for (const k of matched) {
    const score = j<ZoneScore>(await r.get(k));
    if (!score) continue;
    const zone = k.split(':')[1];
    out[zone] = score;
  }
  return out;
}

export async function listEvents(limit = 100) {
  const r = redis(); if (!r) return [];
  const raw = (await r.lrange('events', 0, limit - 1)) ?? [];
  return raw.map((x) => j<EventRow>(x)).filter((x): x is EventRow => !!x);
}

export type DeviceListItem = {
  device: string;
  zone: string | null;
  profile: string | null;
  state: DeviceState;
  health: number | null;
  components: DeviceScore['components'] | null;
  flags: string[];
  transitions_24h: number | null;
  latest_telemetry: TelemetrySample | null;
  features: Record<string, number> | null;
};

export async function listDevices(): Promise<DeviceListItem[]> {
  const ids = await listDeviceIds();
  const items = await Promise.all(
    ids.map(async (device) => {
      const [meta, score, tele] = await Promise.all([
        getDeviceMeta(device),
        getDeviceScore(device),
        getDeviceLatest(device),
      ]);
      return {
        device,
        zone: meta?.zone ?? null,
        profile: meta?.profile ?? null,
        state: (score?.state as DeviceState | undefined) ?? 'OFFLINE',
        health: score?.health ?? null,
        components: score?.components ?? null,
        flags: score?.flags ?? [],
        transitions_24h: score?.transitions_24h ?? null,
        latest_telemetry: tele,
        features: score?.features ?? null,
      } satisfies DeviceListItem;
    }),
  );
  return items;
}
