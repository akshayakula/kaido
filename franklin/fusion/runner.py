"""Main fusion loop. Reads telemetry from Upstash, computes scores, writes back.

Usage:
    .venv/bin/python -m fusion.runner once       # one pass over all devices
    .venv/bin/python -m fusion.runner loop       # forever, every TICK_S
    .venv/bin/python -m fusion.runner score <id> # single device, verbose
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from typing import Any

from . import features as feats
from . import score as scorer
from . import zone as zone_mod
from .upstash import (DEVICES_KEY, EVENTS_KEY, Upstash,
                      k_audio, k_meta, k_score, k_tele, k_zone_devs, k_zone_score)

TICK_S = 30
TELEMETRY_WINDOW = 200    # samples of raw sensor history to read each tick
AUDIO_WINDOW = 30         # audio snapshots
MAX_EVENTS = 500


def _persist_load(u: Upstash, dev: str) -> scorer.StatePersist:
    prev = u.get_json(k_score(dev)) or {}
    return scorer.StatePersist(
        state=prev.get("state", "NORMAL"),
        last_changed_ts=prev.get("last_changed_ts", time.time()),
        transitions_24h=int(prev.get("transitions_24h", 0)),
        last_health=float(prev.get("health", 1.0)),
    )


def _persist_save(u: Upstash, dev: str, fused: dict, persist: scorer.StatePersist) -> None:
    payload = dict(fused)
    payload["last_changed_ts"] = persist.last_changed_ts
    u.set_json(k_score(dev), payload)


def _emit_event(u: Upstash, evt: dict) -> None:
    u.lpush_json(EVENTS_KEY, evt, trim_to=MAX_EVENTS)


def score_device(u: Upstash, dev: str, verbose: bool = False) -> dict:
    tele = u.lrange_json(k_tele(dev), 0, TELEMETRY_WINDOW - 1)
    audio = u.lrange_json(k_audio(dev), 0, AUDIO_WINDOW - 1)

    if not tele:
        # caller can interpret as OFFLINE
        if verbose:
            print(f"  {dev}: no telemetry, skipping")
        return {"device": dev, "state": "OFFLINE", "health": None}

    f: dict[str, Any] = {}
    f.update(feats.thermal_features(tele))
    f.update(feats.humidity_features(tele))
    f.update(feats.audio_features(audio))
    f.update(feats.joint_features(tele, audio))

    persist = _persist_load(u, dev)
    prev_state = persist.state
    fused = scorer.fuse(f, persist)
    fused["device"] = dev

    _persist_save(u, dev, fused, persist)
    if persist.state != prev_state:
        _emit_event(u, {
            "ts": fused["ts"], "device": dev,
            "kind": "state_transition",
            "from": prev_state, "to": persist.state,
            "health": fused["health"], "flags": fused["flags"],
        })

    if verbose:
        print(json.dumps(fused, indent=2, default=str))
    return fused


def list_devices(u: Upstash) -> list[str]:
    return sorted(u.smembers(DEVICES_KEY))


def score_all(u: Upstash, verbose: bool = False) -> list[dict]:
    devs = list_devices(u)
    if verbose:
        print(f"scoring {len(devs)} devices …")
    out = []
    for dev in devs:
        try:
            out.append(score_device(u, dev, verbose=verbose))
        except Exception as e:
            print(f"  {dev}: error {e}", file=sys.stderr)
    return out


def aggregate_zones(u: Upstash, scores: list[dict]) -> dict[str, dict]:
    by_zone: dict[str, list[dict]] = defaultdict(list)
    for s in scores:
        meta = u.get_json(k_meta(s["device"])) or {}
        zone = meta.get("zone") or "unknown"
        by_zone[zone].append(s)
    out = {}
    for zone, scs in by_zone.items():
        agg = zone_mod.aggregate(scs)
        u.set_json(k_zone_score(zone), agg)
        out[zone] = agg
    return out


def loop(u: Upstash) -> None:
    print(f"franklin.fusion runner — tick={TICK_S}s")
    while True:
        t0 = time.time()
        try:
            scs = score_all(u)
            zs = aggregate_zones(u, scs)
            print(f"[{time.strftime('%H:%M:%S')}] {len(scs)} devices, {len(zs)} zones")
        except Exception as e:
            print(f"loop error: {e}", file=sys.stderr)
        elapsed = time.time() - t0
        time.sleep(max(0.0, TICK_S - elapsed))


def main():
    ap = argparse.ArgumentParser(prog="fusion.runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("once", help="single pass over all devices")
    sub.add_parser("loop", help="run forever every 30s")
    p_score = sub.add_parser("score", help="score a single device verbosely")
    p_score.add_argument("device")
    args = ap.parse_args()

    u = Upstash()
    if args.cmd == "once":
        scs = score_all(u, verbose=True)
        zs = aggregate_zones(u, scs)
        print(f"\nzones:\n{json.dumps(zs, indent=2, default=str)}")
    elif args.cmd == "loop":
        loop(u)
    elif args.cmd == "score":
        score_device(u, args.device, verbose=True)


if __name__ == "__main__":
    main()
