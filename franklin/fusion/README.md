# franklin.fusion

Sensor fusion + transformer health scoring. Inputs come from Upstash Redis
(written by the Pi firmware in `raspi-firmware/` and by the SAM-Audio audio
pipeline). Outputs go back into Upstash so the viewer / API can render
fleet health.

## Tiers

```
   raw 2-Hz Si7021                 SAM-Audio "popping" target.wav
        ↓                                     ↓
   thermal_features                  audio_pop.detect_pops
   humidity_features                  → pop_count, pop_amp, intervals
        ↓                                     ↓
        ─────── joint_features ───────────────
                       ↓
              score.fuse(features, persist)
            → health, state, flags, components
                       ↓
                zone.aggregate
            → min_health, freq_band_factor,
              zone_resilience
```

## Algo summary (per device, every 30 s)

1. Read latest telemetry list + audio-feature list from Upstash.
2. Extract ~25 numeric features across thermal / humidity / audio / joint.
3. Compute health ∈ [0, 1] = 1 − Σ(weight × component_penalty).
4. Run state machine with dwell-time inertia (NORMAL / STRESSED / EMERGENCY / RECOVERING).
5. Match named failure-mode patterns (THERMAL_RUNAWAY, INSULATION_RISK, PARTIAL_DISCHARGE,
   TAP_CHANGER_WEAR, CORRELATED_FAULT).
6. Persist score; emit `events` entry on state transition.

Weights default to:
| component | weight | what it captures |
|---|---|---|
| thermal   | 0.30 | temp delta + warming rate |
| audio     | 0.30 | pop rate above ambient |
| humidity  | 0.15 | dew-point margin + z-score |
| joint     | 0.15 | thermo-audio correlation, dew-audio alignment |
| stability | 0.10 | Pi's "stable" flag complement |

## Resilience score (zone)

```
zone_resilience = 0.5 × min_health
                + 0.3 × (1 − emergency_fraction)
                + 0.2 × exp(−transitions_per_hour / 8)
```

Inspired by Barati's "real-time resiliency assessment via complexity metric":
- *min_health* — worst single asset bounds the zone
- *emergency_fraction* — fraction of assets in EMERGENCY
- *freq_band_factor* — penalty for state-flapping (the literal "frequency"
  of state transitions, hence "resilient frequency")

## Running locally with mock data

```bash
cd franklin
.venv/bin/python -m fusion.mock seed --minutes 10        # backfill history
.venv/bin/python -m fusion.runner once                   # score everyone
.venv/bin/python -m fusion.runner score pi-load3         # verbose single device
.venv/bin/python -m fusion.mock stream &                 # keep pushing samples
.venv/bin/python -m fusion.runner loop                   # score every 30s
```

Mock archetypes:
- `pi-load1` HEALTHY  — flat temp, no pops
- `pi-load2` STRESSED — temp drifts +3 °C, ~0.3 pops/s
- `pi-load3` FAILING  — temp +7 °C, dew margin shrinks, ~1.5 pops/s

## When the Pi is real

Pi firmware writes:
- `LPUSH telemetry` (legacy global list, kept for back-compat)
- `SET telemetry:latest:<DEVICE_ID>`

The fusion runner reads from `device:<id>:tele` instead, so the Pi
should also `LPUSH device:<id>:tele …; LTRIM device:<id>:tele 0 1999;
SADD devices <id>; SADD zone:<zone>:devices <id>`. We add this in
`raspi-firmware/main.py` as part of this round.

## Audio pipeline (separate worker)

Each clip uploaded by the Pi (or by the viewer's upload button) is run
through SAM-Audio with prompt `"popping"`, then `audio_pop.detect_pops`
turns the isolated WAV into a pop-feature snapshot, which gets pushed
to `device:<id>:audio`.
