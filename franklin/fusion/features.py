"""Feature extraction from raw sensor + audio histories.

All functions return a dict keyed by feature name so they can be merged into
one envelope. Conservative: never crashes on short histories — returns NaNs
or sensible defaults so downstream scoring degrades gracefully.

Conventions
-----------
- `tele` is a list of telemetry payloads, NEWEST FIRST (matches LPUSH/LRANGE).
  Each: {ts, device, temp_c, humidity, baseline_c, delta_c, ...}
- `audio` is a list of audio-feature snapshots, NEWEST FIRST.
  Each: {ts, device, pop_count, pop_amp_p95, pop_intensity_db, ...}
- All times are unix-seconds (float).
"""
from __future__ import annotations

import math
import statistics
from typing import Any, Sequence

NAN = float("nan")


def _values(history: Sequence[dict], key: str) -> list[float]:
    out = []
    for r in history:
        v = r.get(key)
        if v is None:
            continue
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _mean(xs: Sequence[float], default: float = NAN) -> float:
    return sum(xs) / len(xs) if xs else default


def _stddev(xs: Sequence[float], default: float = NAN) -> float:
    return statistics.pstdev(xs) if len(xs) >= 2 else default


def _zscore(x: float, mean: float, sd: float) -> float:
    if math.isnan(mean) or math.isnan(sd) or sd == 0:
        return 0.0
    return (x - mean) / sd


def _slope(xs: Sequence[float], dt: float) -> float:
    """Simple two-point slope from first to last sample (xs is newest-first)."""
    if len(xs) < 2 or dt <= 0:
        return 0.0
    return (xs[0] - xs[-1]) / (dt * (len(xs) - 1))


# ----------------------------------------------------------------------
# Thermal
# ----------------------------------------------------------------------
def thermal_features(tele: Sequence[dict], window_s: float = 300.0) -> dict[str, float]:
    if not tele:
        return {"temp_c": NAN, "temp_baseline": NAN, "temp_delta": NAN,
                "temp_delta_rate": 0.0, "temp_zscore": 0.0, "temp_stable": 0.0}
    latest = tele[0]
    temp_c = float(latest.get("temp_c", NAN))
    baseline = latest.get("baseline_c")
    if baseline is None:
        # fall back to long-window mean
        baseline = _mean(_values(tele, "temp_c"))
    baseline = float(baseline)

    window = [r for r in tele if (latest["ts"] - r["ts"]) <= window_s]
    temps = _values(window, "temp_c")
    mean = _mean(temps); sd = _stddev(temps)
    return {
        "temp_c": temp_c,
        "temp_baseline": baseline,
        "temp_delta": temp_c - baseline,
        "temp_delta_rate": _slope(temps, dt=2.0),                # °C/s
        "temp_zscore": _zscore(temp_c, mean, sd),
        "temp_stable": float(sd < 0.15) if not math.isnan(sd) else 0.0,
        "temp_window_n": float(len(temps)),
    }


# ----------------------------------------------------------------------
# Humidity
# ----------------------------------------------------------------------
def humidity_features(tele: Sequence[dict], window_s: float = 600.0) -> dict[str, float]:
    if not tele:
        return {"humidity": NAN, "humidity_zscore": 0.0, "humidity_slope": 0.0,
                "dew_point_c": NAN, "dew_point_margin": NAN}
    latest = tele[0]
    h = float(latest.get("humidity", NAN))
    t = float(latest.get("temp_c", NAN))

    # Magnus approximation of dew point. Useful for insulation breakdown:
    # if dew point is close to surface temp, condensation risk is high.
    if math.isnan(h) or math.isnan(t) or h <= 0:
        dew = NAN
    else:
        a, b = 17.625, 243.04
        γ = math.log(max(h, 1e-3) / 100.0) + (a * t) / (b + t)
        dew = (b * γ) / (a - γ)

    window = [r for r in tele if (latest["ts"] - r["ts"]) <= window_s]
    hs = _values(window, "humidity")
    mean = _mean(hs); sd = _stddev(hs)

    return {
        "humidity": h,
        "humidity_zscore": _zscore(h, mean, sd),
        "humidity_slope": _slope(hs, dt=2.0),
        "dew_point_c": dew,
        "dew_point_margin": (t - dew) if not math.isnan(dew) else NAN,
    }


# ----------------------------------------------------------------------
# Audio (driven by SAM-Audio "popping" output)
# ----------------------------------------------------------------------
def audio_features(audio: Sequence[dict], window_s: float = 600.0) -> dict[str, float]:
    if not audio:
        return {"pop_rate": 0.0, "pop_intensity_db": -120.0, "pop_regularity": 0.0,
                "pop_count_recent": 0.0, "audio_window_n": 0.0}
    latest = audio[0]
    window = [r for r in audio if (latest["ts"] - r["ts"]) <= window_s]
    counts = _values(window, "pop_count")
    intensities = _values(window, "pop_intensity_db")
    intervals = _values(window, "pop_inter_interval_med")

    # Each window represents a fixed audio_seconds clip; rate = pops/clip.
    clip_seconds = float(latest.get("clip_seconds", 30.0))
    pop_rate = (sum(counts) / max(1, len(counts))) / max(1.0, clip_seconds)  # pops/s

    # Regularity: low stddev of inter-pop intervals → tap-changer-style mechanical
    # signature. High stddev → corona/PD-style stochastic.
    reg_sd = _stddev(intervals) if len(intervals) >= 2 else NAN
    pop_regularity = float(0.0 if math.isnan(reg_sd) else math.exp(-reg_sd))  # ∈ (0, 1]

    return {
        "pop_rate": pop_rate,
        "pop_intensity_db": _mean(intensities, default=-120.0),
        "pop_regularity": pop_regularity,
        "pop_count_recent": float(latest.get("pop_count", 0)),
        "audio_window_n": float(len(window)),
    }


# ----------------------------------------------------------------------
# Joint (cross-modality)
# ----------------------------------------------------------------------
def _zip_by_time(a: Sequence[dict], b: Sequence[dict], tol_s: float = 60.0) -> list[tuple[dict, dict]]:
    """Pair audio + tele samples whose timestamps are within tol_s. Newest first."""
    pairs = []
    for ar in a:
        # pick the closest tele sample
        best = None; best_d = float("inf")
        for tr in b:
            d = abs(ar["ts"] - tr["ts"])
            if d < best_d:
                best, best_d = tr, d
        if best is not None and best_d <= tol_s:
            pairs.append((ar, best))
    return pairs


def joint_features(tele: Sequence[dict], audio: Sequence[dict], window_s: float = 600.0) -> dict[str, float]:
    if not tele or not audio:
        return {"thermo_audio_corr": 0.0, "dew_audio_alignment": 0.0}

    latest_ts = tele[0]["ts"]
    paired = [
        (a, t) for (a, t) in _zip_by_time(audio, tele)
        if (latest_ts - a["ts"]) <= window_s
    ]
    if len(paired) < 4:
        return {"thermo_audio_corr": 0.0, "dew_audio_alignment": 0.0}

    pop_rates = [
        float(a.get("pop_count", 0)) / float(a.get("clip_seconds", 30.0))
        for a, _ in paired
    ]
    deltas = [
        float(t.get("delta_c") or (t.get("temp_c", 0) - t.get("baseline_c", t.get("temp_c", 0))))
        for _, t in paired
    ]

    # Pearson correlation between thermal stress and pop rate.
    n = len(paired)
    mp, md = _mean(pop_rates), _mean(deltas)
    num = sum((p - mp) * (d - md) for p, d in zip(pop_rates, deltas))
    sp = math.sqrt(sum((p - mp) ** 2 for p in pop_rates))
    sd = math.sqrt(sum((d - md) ** 2 for d in deltas))
    corr = num / (sp * sd) if sp > 0 and sd > 0 else 0.0

    # Dew-point alignment: how often pop spikes happen when dew margin is small.
    # Proxy: count windows where pop_rate > median AND dew_margin < median.
    dew_margins = []
    for _, t in paired:
        h = float(t.get("humidity", 50)); tc = float(t.get("temp_c", 20))
        a, b = 17.625, 243.04
        try:
            γ = math.log(max(h, 1e-3) / 100.0) + (a * tc) / (b + tc)
            dew = (b * γ) / (a - γ)
            dew_margins.append(tc - dew)
        except ValueError:
            dew_margins.append(NAN)

    valid = [(p, m) for p, m in zip(pop_rates, dew_margins) if not math.isnan(m)]
    if len(valid) >= 4:
        ps = sorted(p for p, _ in valid)
        ms = sorted(m for _, m in valid)
        p_med = ps[len(ps) // 2]; m_med = ms[len(ms) // 2]
        agree = sum(1 for p, m in valid if (p > p_med) == (m < m_med))
        alignment = (agree / len(valid)) * 2 - 1   # ∈ [-1, 1]
    else:
        alignment = 0.0

    return {
        "thermo_audio_corr": corr,
        "dew_audio_alignment": alignment,
    }
