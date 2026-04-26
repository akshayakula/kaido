"""Tier-2 per-asset health score + state machine (Barati-style).

Health is a smooth scalar in [0, 1]:
    1.0  pristine
    0.7  stressed but functional
    0.4  emergency-level
    0.0  failed

State (categorical) is one of:
    NORMAL      all features within tolerance
    STRESSED    one or more features in mild excursion (1.5–3 σ or thresholds)
    EMERGENCY   any feature deeply abnormal OR multi-modal anomaly
    RECOVERING  prev was non-NORMAL and we just returned to tolerance
    OFFLINE     no recent samples (handled by caller, not here)

The state machine adds *inertia*: STRESSED won't flip back to NORMAL on a
single OK sample — must spend ≥ stable_dwell_s in tolerance first. This is
key for Barati's "frequency of state transitions" metric to be meaningful
(noisy sensors otherwise produce false transition counts).

Failure-mode flags
------------------
A short list of named patterns we recognize:

  THERMAL_RUNAWAY      sustained dT/dt > rate threshold
  INSULATION_RISK      dew-point margin shrinking AND humidity rising
  PARTIAL_DISCHARGE    pop_rate elevated AND high regularity (corona-like)
  TAP_CHANGER_WEAR     pop_rate elevated AND highly periodic intervals
  CORRELATED_FAULT     thermo_audio_corr > 0.6 AND temp_delta > 0
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

NAN = float("nan")


# Weights — tunable; sum should be ≤ 1 since we *subtract* from 1.0.
WEIGHTS = {
    "thermal":    0.30,
    "humidity":   0.15,
    "audio":      0.30,
    "joint":      0.15,
    "stability":  0.10,
}

STRESS_TEMP_DELTA   = 3.0     # °C above baseline → starts to count
EMERG_TEMP_DELTA    = 8.0     # °C above baseline → emergency
STRESS_RATE         = 0.10    # °C/s sustained warming
EMERG_RATE          = 0.30    # °C/s thermal runaway
DEW_MARGIN_STRESS   = 5.0     # °C — surface near dew point
DEW_MARGIN_EMERG    = 1.5
EXPECTED_POP_RATE   = 0.05    # pops/s baseline ambient (well below faulty)
STRESS_POP_RATE     = 0.30
EMERG_POP_RATE      = 1.50
HEALTH_NORMAL_MIN   = 0.85
HEALTH_STRESSED_MIN = 0.55


@dataclass
class StatePersist:
    """Persisted across ticks (stored in upstash device:<id>:score)."""
    state: str = "NORMAL"
    last_changed_ts: float = field(default_factory=time.time)
    transitions_24h: int = 0
    last_health: float = 1.0


def _smooth_penalty(x: float, soft: float, hard: float) -> float:
    """Smooth ramp from 0 (at soft) to 1 (at hard). x past hard saturates at 1."""
    if math.isnan(x):
        return 0.0
    if x <= soft:
        return 0.0
    if x >= hard:
        return 1.0
    return (x - soft) / (hard - soft)


def health_score(features: dict[str, float]) -> dict:
    """Compute a [0, 1] scalar + per-component breakdown."""
    f = features

    # Each component returns a penalty in [0, 1]; multiplied by its weight.
    thermal = max(
        _smooth_penalty(max(0.0, f.get("temp_delta", 0.0)),
                        STRESS_TEMP_DELTA, EMERG_TEMP_DELTA),
        _smooth_penalty(max(0.0, f.get("temp_delta_rate", 0.0)),
                        STRESS_RATE, EMERG_RATE),
    )

    dew = f.get("dew_point_margin", NAN)
    humidity = (
        _smooth_penalty(-dew + DEW_MARGIN_STRESS,  # smaller margin → bigger penalty
                        0.0, DEW_MARGIN_STRESS - DEW_MARGIN_EMERG)
        if not math.isnan(dew) else 0.0
    )
    humidity = max(humidity, _smooth_penalty(abs(f.get("humidity_zscore", 0.0)), 1.5, 3.5))

    audio = _smooth_penalty(f.get("pop_rate", 0.0), STRESS_POP_RATE, EMERG_POP_RATE)

    # Joint: penalty when thermal & audio rise together → corroborated fault
    corr = abs(f.get("thermo_audio_corr", 0.0))
    align = max(0.0, f.get("dew_audio_alignment", 0.0))
    joint = max(_smooth_penalty(corr, 0.5, 0.85), _smooth_penalty(align, 0.4, 0.85))

    # Stability: complement of the Pi's "stable" bit averaged across window.
    # Caller doesn't track that across windows yet; use temp_stable as proxy.
    stability = 1.0 - float(f.get("temp_stable", 1.0))

    components = {
        "thermal":   thermal,
        "humidity":  humidity,
        "audio":     audio,
        "joint":     joint,
        "stability": stability,
    }
    deduction = sum(WEIGHTS[k] * v for k, v in components.items())
    return {
        "health": max(0.0, 1.0 - deduction),
        "components": components,
        "weights": WEIGHTS,
    }


def detect_failure_modes(features: dict[str, float]) -> list[str]:
    flags: list[str] = []
    f = features

    if f.get("temp_delta_rate", 0.0) > STRESS_RATE and f.get("temp_delta", 0.0) > STRESS_TEMP_DELTA:
        flags.append("THERMAL_RUNAWAY")
    dew = f.get("dew_point_margin", NAN)
    if (not math.isnan(dew)) and dew < DEW_MARGIN_STRESS and f.get("humidity_slope", 0.0) > 0:
        flags.append("INSULATION_RISK")
    if f.get("pop_rate", 0.0) > STRESS_POP_RATE and f.get("pop_regularity", 0.0) < 0.4:
        flags.append("PARTIAL_DISCHARGE")
    if f.get("pop_rate", 0.0) > STRESS_POP_RATE and f.get("pop_regularity", 0.0) > 0.7:
        flags.append("TAP_CHANGER_WEAR")
    if abs(f.get("thermo_audio_corr", 0.0)) > 0.6 and f.get("temp_delta", 0.0) > 1.0:
        flags.append("CORRELATED_FAULT")
    return flags


def classify_state(health: float, features: dict[str, float], persist: StatePersist,
                   stable_dwell_s: float = 60.0) -> tuple[str, StatePersist]:
    f = features
    now = time.time()

    # Hard emergency triggers (regardless of smoothed health):
    hard_emerg = (
        f.get("temp_delta", 0.0) > EMERG_TEMP_DELTA
        or f.get("temp_delta_rate", 0.0) > EMERG_RATE
        or f.get("pop_rate", 0.0) > EMERG_POP_RATE
        or (
            (not math.isnan(f.get("dew_point_margin", NAN)))
            and f["dew_point_margin"] < DEW_MARGIN_EMERG
        )
    )
    if hard_emerg:
        new = "EMERGENCY"
    elif health < HEALTH_STRESSED_MIN:
        new = "STRESSED"
    elif health < HEALTH_NORMAL_MIN:
        new = "STRESSED"
    elif persist.state in ("STRESSED", "EMERGENCY"):
        # Require dwell-time at NORMAL-quality before clearing
        time_in_band = now - persist.last_changed_ts
        new = "RECOVERING" if time_in_band < stable_dwell_s else "NORMAL"
    elif persist.state == "RECOVERING":
        time_in_band = now - persist.last_changed_ts
        new = "RECOVERING" if time_in_band < stable_dwell_s else "NORMAL"
    else:
        new = "NORMAL"

    if new != persist.state:
        persist.state = new
        persist.last_changed_ts = now
        persist.transitions_24h += 1
    persist.last_health = health
    return new, persist


def fuse(features: dict[str, float], persist: StatePersist) -> dict[str, Any]:
    s = health_score(features)
    state, persist = classify_state(s["health"], features, persist)
    flags = detect_failure_modes(features)
    return {
        "ts": time.time(),
        "state": state,
        "health": round(s["health"], 4),
        "components": {k: round(v, 4) for k, v in s["components"].items()},
        "flags": flags,
        "transitions_24h": persist.transitions_24h,
        "features": {k: (round(v, 4) if isinstance(v, (int, float))
                         and not math.isnan(v) else v)
                     for k, v in features.items()},
    }
