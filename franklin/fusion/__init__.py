"""franklin.fusion — sensor fusion + transformer health scoring.

Modules
-------
upstash    Tiny REST client for Upstash Redis (read Pi telemetry, write scores).
features   Per-modality feature extraction (thermal, humidity, audio, joint).
audio_pop  Pop-event detection on a SAM-Audio "popping" target.wav.
score      Tier-2 per-asset health scoring + state machine (Barati-style).
zone       Tier-3 zone aggregation + resilience metric.
runner     Main loop: read raw → compute → write back. CLI entry points.
mock       Synthetic device generator (healthy / stressed / failing).
"""
