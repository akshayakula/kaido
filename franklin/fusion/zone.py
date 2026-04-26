"""Tier-3 zone aggregation + resilience score.

Aggregates per-asset scores into one zone score and builds a Barati-style
"resilient frequency" metric: how often the assets *transition* between
states per hour. Higher transition rate = less resilient — the system is
flapping at the edge.

zone_resilience = clamp01(
    min_health * 0.5
  + (1 - emergency_fraction) * 0.3
  + frequency_band_factor * 0.2
)

…where:
- min_health        = lowest single-asset health in the zone
- emergency_fraction= fraction of assets in EMERGENCY state
- frequency_band_factor = a transition-rate penalty (0..1, smaller = more flapping)
"""
from __future__ import annotations

import math
import time
from typing import Sequence


def _frequency_band_factor(transitions_per_hour: float) -> float:
    """Penalize state-transition flapping. Empirically:
       0/hr → 1.0 (rock solid), 6/hr → 0.5, 20/hr → 0.0."""
    return float(math.exp(-transitions_per_hour / 8.0))


def aggregate(scores: Sequence[dict]) -> dict:
    if not scores:
        return {
            "ts": time.time(), "device_count": 0,
            "min_health": float("nan"), "mean_health": float("nan"),
            "emergency_fraction": 0.0, "stressed_fraction": 0.0,
            "freq_band_factor": 1.0, "zone_resilience": float("nan"),
            "states": {},
        }

    healths = [s["health"] for s in scores if "health" in s]
    states = [s.get("state", "NORMAL") for s in scores]
    states_count = {x: states.count(x) for x in set(states)}
    n = len(scores)

    emerg_frac = states.count("EMERGENCY") / n
    stress_frac = (states.count("STRESSED") + states.count("EMERGENCY")) / n
    transitions = sum(s.get("transitions_24h", 0) for s in scores)
    transitions_per_hour = transitions / max(1, n) / 24.0
    fbf = _frequency_band_factor(transitions_per_hour)

    min_h = min(healths) if healths else float("nan")
    mean_h = sum(healths) / len(healths) if healths else float("nan")

    resilience = max(0.0, min(1.0,
        0.5 * min_h
        + 0.3 * (1.0 - emerg_frac)
        + 0.2 * fbf
    )) if healths else float("nan")

    return {
        "ts": time.time(),
        "device_count": n,
        "min_health": round(min_h, 4) if not math.isnan(min_h) else None,
        "mean_health": round(mean_h, 4) if not math.isnan(mean_h) else None,
        "emergency_fraction": round(emerg_frac, 4),
        "stressed_fraction": round(stress_frac, 4),
        "transitions_per_hour": round(transitions_per_hour, 3),
        "freq_band_factor": round(fbf, 4),
        "zone_resilience": round(resilience, 4) if not math.isnan(resilience) else None,
        "states": states_count,
    }
