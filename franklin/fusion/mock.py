"""Push synthetic device telemetry + audio features into Upstash for testing.

Three archetypes:

  pi-load1   HEALTHY     temp ±0.3 °C around 24 °C, humidity ~45 %, pop_rate 0
  pi-load2   STRESSED    temp drifts +3 °C over time, humidity rising, pop_rate 0.3 /s
  pi-load3   FAILING     temp +6 °C, dew margin shrinking, pop_rate 1.5 /s, occasional bursts

Run:
    .venv/bin/python -m fusion.mock seed   # one batch of historic samples
    .venv/bin/python -m fusion.mock stream # keep pushing 1 sample / 2 s
"""
from __future__ import annotations

import argparse
import math
import random
import time
from typing import Any

from .upstash import (DEVICES_KEY, Upstash, k_audio, k_latest, k_meta, k_tele,
                      k_zone_devs)


# ----------------------------------------------------------------------
# Archetypes
# ----------------------------------------------------------------------
def _healthy(t: float, base: float = 24.0) -> dict:
    temp = base + random.gauss(0, 0.15)
    return {
        "temp_c": temp, "humidity": 45.0 + random.gauss(0, 0.5),
        "baseline_c": base, "delta_c": temp - base,
    }


def _stressed(t: float, base: float = 24.0, age_s: float = 0.0) -> dict:
    drift = min(3.0, age_s / 120.0)        # ramp +3 °C over 4 min
    temp = base + drift + random.gauss(0, 0.4)
    return {
        "temp_c": temp, "humidity": 60.0 + drift + random.gauss(0, 0.7),
        "baseline_c": base, "delta_c": temp - base,
    }


def _failing(t: float, base: float = 24.0, age_s: float = 0.0) -> dict:
    drift = min(7.0, age_s / 60.0)         # +7 °C over 7 min
    burst = 2.0 if random.random() < 0.05 else 0.0
    temp = base + drift + burst + random.gauss(0, 0.6)
    return {
        "temp_c": temp,
        "humidity": min(95.0, 70.0 + drift * 1.3 + random.gauss(0, 1.5)),
        "baseline_c": base, "delta_c": temp - base,
    }


def _audio_for(profile: str, t: float) -> dict:
    if profile == "healthy":
        n = 0
    elif profile == "stressed":
        n = max(0, int(random.gauss(8, 3)))   # ~8 pops in 30s ~ 0.27/s
    else:  # failing
        n = max(0, int(random.gauss(45, 8)))  # ~45 pops in 30s ~ 1.5/s
    intervals = sorted([random.uniform(0, 30.0) for _ in range(n)])
    inter = [intervals[i+1] - intervals[i] for i in range(len(intervals) - 1)]
    return {
        "ts": t,
        "pop_count": n,
        "pop_amp_p95": -25.0 + random.gauss(0, 2) if n else -120.0,
        "pop_intensity_db": -35.0 + random.gauss(0, 2) if n else -120.0,
        "pop_inter_interval_med": (sorted(inter)[len(inter)//2] if inter else 0.0),
        "noise_floor_db": -55.0,
        "threshold_db": -45.0,
        "clip_seconds": 30.0,
    }


PROFILES = {
    "pi-load1": ("healthy",  "DOM"),
    "pi-load2": ("stressed", "DOM"),
    "pi-load3": ("failing",  "DOM"),
}


# ----------------------------------------------------------------------
# Push
# ----------------------------------------------------------------------
def _gen_telemetry(profile: str, ts: float, age_s: float) -> dict:
    if profile == "healthy":   sample = _healthy(ts)
    elif profile == "stressed":sample = _stressed(ts, age_s=age_s)
    else:                      sample = _failing(ts, age_s=age_s)
    sample.update(ts=ts, device=None)  # device set per-call
    return sample


def seed(u: Upstash, minutes: int = 10) -> None:
    """Backfill ~minutes of history for each device."""
    print(f"seeding {minutes} min of history for {len(PROFILES)} devices …")
    now = time.time()
    n = minutes * 30  # 1 sample every 2s
    for dev, (profile, zone) in PROFILES.items():
        u.sadd(DEVICES_KEY, dev)
        u.sadd(k_zone_devs(zone), dev)
        u.set_json(k_meta(dev), {"zone": zone, "name": dev, "profile": profile})

        for i in range(n, 0, -1):
            ts = now - i * 2.0
            age = (n - i) * 2.0
            payload = _gen_telemetry(profile, ts, age)
            payload["device"] = dev
            u.lpush_json(k_tele(dev), payload, trim_to=2000)
            u.set_json(k_latest(dev), payload)

        # ~minutes/0.5 audio snapshots (one per 30 s)
        for i in range((minutes * 60) // 30, 0, -1):
            ts = now - i * 30.0
            payload = _audio_for(profile, ts)
            payload["device"] = dev
            u.lpush_json(k_audio(dev), payload, trim_to=200)
        print(f"  {dev}: {profile} in zone {zone}")


def stream(u: Upstash, dt: float = 2.0) -> None:
    """Forever-push fresh samples for each device."""
    print(f"streaming for {list(PROFILES)} every {dt}s")
    start = time.time()
    audio_step = 0.0
    while True:
        now = time.time()
        for dev, (profile, _) in PROFILES.items():
            tele = _gen_telemetry(profile, now, age_s=now - start)
            tele["device"] = dev
            u.lpush_json(k_tele(dev), tele, trim_to=2000)
            u.set_json(k_latest(dev), tele)
        if now - audio_step >= 30.0:
            audio_step = now
            for dev, (profile, _) in PROFILES.items():
                snap = _audio_for(profile, now)
                snap["device"] = dev
                u.lpush_json(k_audio(dev), snap, trim_to=200)
            print(f"[{time.strftime('%H:%M:%S')}] audio snapshots pushed")
        time.sleep(dt)


def main():
    ap = argparse.ArgumentParser(prog="fusion.mock")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_seed = sub.add_parser("seed")
    p_seed.add_argument("--minutes", type=int, default=10)
    sub.add_parser("stream")
    args = ap.parse_args()

    u = Upstash()
    if args.cmd == "seed":
        seed(u, minutes=args.minutes)
    elif args.cmd == "stream":
        stream(u)


if __name__ == "__main__":
    main()
