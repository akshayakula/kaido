"""Pop-event detection on a SAM-Audio "popping" target.wav.

Run AFTER SAM-Audio isolates the popping prompt for a clip; this module
turns that audio back into discrete events with timestamps + amplitudes.

Algorithm
---------
1. Compute short-time RMS envelope (10 ms hop).
2. Find peaks above adaptive threshold = max(median + k·MAD, abs_floor).
3. Merge peaks closer than min_interval (default 50 ms — collapses double-counts).
4. Emit (t_seconds, amp_db) for each event.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np


def _rms_envelope(signal: np.ndarray, sr: int, hop_ms: float = 10.0,
                  win_ms: float = 25.0) -> tuple[np.ndarray, np.ndarray]:
    hop = max(1, int(sr * hop_ms / 1000))
    win = max(hop, int(sr * win_ms / 1000))
    n_frames = max(0, (len(signal) - win) // hop + 1)
    if n_frames <= 0:
        return np.empty(0), np.empty(0)
    frames = np.lib.stride_tricks.as_strided(
        signal, shape=(n_frames, win),
        strides=(signal.strides[0] * hop, signal.strides[0]),
    )
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    times = np.arange(n_frames) * hop / sr + win / (2 * sr)
    return times, rms


def _amp_to_db(x: np.ndarray | float) -> np.ndarray | float:
    return 20.0 * np.log10(np.maximum(x, 1e-10))


def detect_pops(wav_path: str | Path,
                k_mad: float = 4.0,
                abs_floor_db: float = -45.0,
                min_interval_s: float = 0.05) -> dict:
    """Returns {pop_count, events, pop_amp_p95, pop_intensity_db, pop_inter_interval_med, ...}."""
    import soundfile as sf  # local import keeps top-level cheap

    wav, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    duration = len(wav) / sr if sr else 0.0

    times, rms = _rms_envelope(wav, sr)
    if len(rms) == 0:
        return _empty(duration)

    rms_db = _amp_to_db(rms)
    median = float(np.median(rms_db))
    mad = float(np.median(np.abs(rms_db - median))) or 1.0
    threshold = max(median + k_mad * mad, abs_floor_db)

    above = np.where(rms_db > threshold)[0]
    if len(above) == 0:
        return _empty(duration)

    # Merge contiguous frames into peak events
    events_idx: list[int] = []
    cur_start = above[0]
    cur_max = above[0]
    for i in above[1:]:
        if i == cur_max + 1:
            cur_max = i
        else:
            events_idx.append(int((cur_start + cur_max) // 2))
            cur_start = i; cur_max = i
    events_idx.append(int((cur_start + cur_max) // 2))

    # Min-interval merge (collapse close peaks)
    merged: list[int] = []
    last_t = -1e9
    for idx in events_idx:
        t = float(times[idx])
        if t - last_t < min_interval_s:
            # keep whichever is louder
            if rms_db[idx] > rms_db[merged[-1]]:
                merged[-1] = idx
            continue
        merged.append(idx)
        last_t = t

    events = [{"t": float(times[i]), "db": float(rms_db[i])} for i in merged]
    amps = np.array([e["db"] for e in events]) if events else np.array([])
    intervals = np.diff([e["t"] for e in events]) if len(events) >= 2 else np.array([])

    return {
        "pop_count": len(events),
        "events": events,
        "pop_amp_p95": float(np.percentile(amps, 95)) if len(amps) else float(median),
        "pop_intensity_db": float(np.mean(amps)) if len(amps) else float(median),
        "pop_inter_interval_med": float(np.median(intervals)) if len(intervals) else 0.0,
        "noise_floor_db": float(median),
        "threshold_db": float(threshold),
        "clip_seconds": duration,
    }


def _empty(duration: float) -> dict:
    return {
        "pop_count": 0, "events": [],
        "pop_amp_p95": -120.0, "pop_intensity_db": -120.0,
        "pop_inter_interval_med": 0.0,
        "noise_floor_db": -120.0, "threshold_db": -120.0,
        "clip_seconds": duration,
    }


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    args = ap.parse_args()
    print(json.dumps(detect_pops(args.wav), indent=2))
