#!/usr/bin/env python3
import json
import math
import sys
from typing import Any, Dict, List


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(code)


try:
    from opendssdirect import dss
except Exception as exc:  # pragma: no cover - exercised when dependency missing
    fail(f"opendssdirect.py is not installed: {exc}")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def scenario_config(scenario: str) -> Dict[str, float]:
    return {
        "nominal": {"source_pu": 1.02, "substation_kva": 8500, "line_normamps": 430},
        "heatwave": {"source_pu": 1.00, "substation_kva": 7600, "line_normamps": 390},
        "feeder_constraint": {"source_pu": 0.985, "substation_kva": 6500, "line_normamps": 320},
        "renewable_drop": {"source_pu": 0.992, "substation_kva": 7000, "line_normamps": 360},
        "demand_spike": {"source_pu": 1.00, "substation_kva": 7800, "line_normamps": 380},
    }.get(scenario, {"source_pu": 1.0, "substation_kva": 7600, "line_normamps": 380})


def datacenter_kw(dc: Dict[str, Any], cooling_factor: float) -> float:
    slurm = dc.get("slurm") or {}
    allocated = float(slurm.get("allocatedGpus") or round(float(dc.get("actualUtilization", 0)) * float(dc.get("gpuCount", 1))))
    gpu_count = max(1.0, float(dc.get("gpuCount", 1)))
    util = max(float(dc.get("actualUtilization", 0)), allocated / gpu_count)
    compute_kw = gpu_count * float(dc.get("gpuKw", 0.72)) * util
    cooling_kw = compute_kw * cooling_factor
    return max(0.0, float(dc.get("baseKw", 0)) + compute_kw + cooling_kw - float(dc.get("batterySupportKw", 0)))


def run(payload: Dict[str, Any]) -> Dict[str, Any]:
    datacenters: List[Dict[str, Any]] = payload.get("datacenters") or []
    scenario = payload.get("scenario", "nominal")
    config = scenario_config(scenario)
    cooling = payload.get("coolingFactor", 0.34)

    dss("Clear")
    dss(
        "New Circuit.AgentGrid "
        f"basekv=12.47 pu={config['source_pu']} phases=3 bus1=sourcebus angle=0 "
        "MVAsc3=200000 MVAsc1=210000"
    )
    dss(
        "New Transformer.Substation phases=3 windings=2 "
        "buses=(sourcebus,subbus) conns=(wye,wye) kvs=(12.47,12.47) "
        f"kvas=({config['substation_kva']},{config['substation_kva']}) %rs=(0.2,0.2) xhl=1.25"
    )
    dss(
        "New Linecode.Feeder nphases=3 r1=0.26 x1=0.34 r0=0.52 x0=1.08 "
        f"units=km normamps={config['line_normamps']}"
    )

    dss("New Line.Backbone bus1=subbus bus2=bus0 phases=3 linecode=Feeder length=0.35 units=km")

    feeder_kw = 0.0
    for idx, dc in enumerate(datacenters, start=1):
        bus = f"dc{idx}bus"
        length_km = 0.45 + (idx % 4) * 0.18
        line_name = f"DC{idx}"
        dss(f"New Line.{line_name} bus1=bus0 bus2={bus} phases=3 linecode=Feeder length={length_km:.3f} units=km")
        kw = datacenter_kw(dc, cooling)
        kvar = kw * 0.33
        feeder_kw += kw
        dss(f"New Load.Load{idx} bus1={bus} phases=3 conn=wye kv=12.47 kw={kw:.3f} kvar={kvar:.3f} model=1")

    # Add a small station service load so no-data-center sessions still solve.
    if not datacenters:
      dss("New Load.StationService bus1=bus0 phases=3 conn=wye kv=12.47 kw=80 kvar=25 model=1")
      feeder_kw = 80

    dss("Set Voltagebases=[12.47]")
    dss("CalcVoltageBases")
    dss("Set maxcontroliter=50")
    dss("Solve")

    if not dss.Solution.Converged():
        fail("OpenDSS solution did not converge")

    voltages = [float(v) for v in dss.Circuit.AllBusMagPu() if math.isfinite(float(v)) and float(v) > 0]
    voltage_min = min(voltages) if voltages else 1.0

    max_line_loading = 0.0
    line_loadings: List[Dict[str, Any]] = []
    for name in dss.Lines.AllNames():
        dss.Lines.Name(name)
        normamps = float(dss.Lines.NormAmps() or config["line_normamps"])
        currents = dss.CktElement.CurrentsMagAng()[0::2]
        max_current = max([float(c) for c in currents[:3]] or [0.0])
        loading = max_current / max(normamps, 1.0)
        max_line_loading = max(max_line_loading, loading)
        line_loadings.append({"name": name, "loading": loading, "amps": max_current})

    losses_kw = float(dss.Circuit.Losses()[0]) / 1000.0
    transformer_loading = feeder_kw / max(float(config["substation_kva"]) * 0.92, 1.0)
    reserve_kw = max(0.0, float(config["substation_kva"]) * 0.92 - feeder_kw)

    violations = []
    if voltage_min < 0.955:
        violations.append("low_voltage")
    if max_line_loading > 0.94:
        violations.append("line_overload")
    if transformer_loading > 0.94:
        violations.append("transformer_overload")

    if violations:
        health = "emergency"
    elif voltage_min < 0.974 or max_line_loading > 0.82 or transformer_loading > 0.82:
        health = "stressed"
    else:
        health = "normal"

    return {
        "ok": True,
        "grid": {
            "health": health,
            "voltageMin": clamp(voltage_min, 0.0, 1.2),
            "lineLoadingMax": max_line_loading,
            "reserveKw": reserve_kw,
            "lossesKw": max(0.0, losses_kw),
            "frequencyHz": 60.0 - max(0.0, max_line_loading - 0.8) * 0.1,
            "violations": violations,
            "solver": "opendss",
            "feederKw": feeder_kw,
            "transformerLoading": transformer_loading,
        },
        "lineLoadings": line_loadings,
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(run(payload)))
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
