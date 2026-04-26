"""Canonical SAM-Audio prompts for transformer-fault audio analysis.

SAM-Audio expects lowercase noun/verb-phrase prompts (per the official README).
Each prompt is paired with the fault class it's intended to surface.

Usage:
    from fault_prompts import HEALTH, FAULTS, ALL_PROMPTS
"""

# Sounds we expect from a healthy transformer — the baseline.
# These are what we want to keep / characterize, not flag.
HEALTH = [
    ("transformer hum",      "core_magnetostriction"),
    ("electrical hum",       "core_magnetostriction"),
    ("low frequency drone",  "core_120hz_harmonic"),
    ("60 hz hum",            "core_fundamental"),
    ("cooling fan",          "fan_normal"),
]

# Fault / degradation indicators — what we're listening *for*.
# Mapping inspired by IEEE C57.127 (acoustic emissions) + utility O&M practice.
FAULTS = [
    # Partial discharge / arcing — the highest-priority signal
    ("popping",              "partial_discharge"),
    ("electrical pop",       "partial_discharge"),
    ("crackling",            "partial_discharge_corona"),
    ("arcing",               "arcing"),
    ("electrical zap",       "arcing"),
    ("zap",                  "arcing"),
    ("snapping",             "spark_gap"),

    # Mechanical wear
    ("clicking",             "tap_changer_mechanical"),
    ("clunking",             "tap_changer_wear"),
    ("rattling",             "loose_lamination"),
    ("buzzing",              "loose_winding_or_corona"),

    # Cooling / oil system
    ("pump cavitation",      "oil_pump_cavitation"),
    ("water dripping",       "oil_leak"),
    ("hissing",              "gas_leak_or_bushing_failure"),

    # Environmental noise to subtract
    ("wind",                 "ambient_subtract"),
    ("traffic",              "ambient_subtract"),
    ("birds",                "ambient_subtract"),
    ("speech",               "ambient_subtract"),
]

# Convenience: all prompts as a flat list of strings.
ALL_PROMPTS = [p for p, _ in HEALTH] + [p for p, _ in FAULTS]


def prompts_for(category: str) -> list[str]:
    """Return prompts for a category like 'partial_discharge' or 'arcing'."""
    return [p for p, c in (HEALTH + FAULTS) if c == category]
