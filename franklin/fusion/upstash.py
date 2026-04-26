"""Minimal Upstash Redis REST client + key conventions for franklin.

Key schema
----------
device:<id>:tele       LIST of N latest telemetry samples (LPUSH + LTRIM)
device:<id>:latest     SET single latest telemetry payload (back-compat)
device:<id>:audio      LIST of N latest audio-feature snapshots
device:<id>:score      SET latest fused score envelope
device:<id>:meta       SET device metadata (zone, lat/lon, name)
devices                SET of all known device ids
zone:<zone>:devices    SET of devices in zone
zone:<zone>:score      SET zone resilience score
events                 LIST of resilience events (state transitions, alerts)

The Pi firmware (raspi-firmware/main.py) currently writes:
  LPUSH telemetry          + LTRIM telemetry 0 999
  SET   telemetry:latest:<DEVICE_ID>

We preserve that and add the per-device richer keys on top.
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"),
            override=True)


class Upstash:
    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 5.0):
        self.url = (url or os.environ["UPSTASH_REDIS_REST_URL"]).rstrip("/")
        self.token = token or os.environ["UPSTASH_REDIS_REST_TOKEN"]
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({"Authorization": f"Bearer {self.token}"})

    # --- low-level: pipeline a list of redis cmds ---
    def pipeline(self, cmds: list[list]) -> list:
        if not cmds:
            return []
        r = self._session.post(f"{self.url}/pipeline", json=cmds, timeout=self.timeout)
        r.raise_for_status()
        body = r.json()
        # Upstash pipeline returns [{"result": ...} or {"error": ...}, ...]
        return [item.get("result", item.get("error")) for item in body]

    def cmd(self, *args) -> Any:
        return self.pipeline([list(args)])[0]

    # --- typed wrappers used by fusion ---
    def get_json(self, key: str) -> Any | None:
        v = self.cmd("GET", key)
        return json.loads(v) if isinstance(v, str) else None

    def set_json(self, key: str, value: Any, ex: int | None = None) -> None:
        v = json.dumps(value, separators=(",", ":"))
        if ex:
            self.cmd("SET", key, v, "EX", str(ex))
        else:
            self.cmd("SET", key, v)

    def lpush_json(self, key: str, value: Any, trim_to: int | None = None) -> None:
        v = json.dumps(value, separators=(",", ":"))
        cmds = [["LPUSH", key, v]]
        if trim_to:
            cmds.append(["LTRIM", key, "0", str(trim_to - 1)])
        self.pipeline(cmds)

    def lrange_json(self, key: str, start: int = 0, stop: int = -1) -> list[Any]:
        raw = self.cmd("LRANGE", key, str(start), str(stop)) or []
        out = []
        for item in raw:
            try:
                out.append(json.loads(item))
            except Exception:
                continue
        return out

    def smembers(self, key: str) -> set[str]:
        v = self.cmd("SMEMBERS", key) or []
        return set(v)

    def sadd(self, key: str, *members: str) -> None:
        if not members:
            return
        self.cmd("SADD", key, *members)


# --- key helpers (single source of truth) ---
def k_tele(dev: str) -> str:        return f"device:{dev}:tele"
def k_latest(dev: str) -> str:      return f"telemetry:latest:{dev}"   # back-compat with Pi
def k_audio(dev: str) -> str:       return f"device:{dev}:audio"
def k_score(dev: str) -> str:       return f"device:{dev}:score"
def k_meta(dev: str) -> str:        return f"device:{dev}:meta"
def k_zone_devs(z: str) -> str:     return f"zone:{z}:devices"
def k_zone_score(z: str) -> str:    return f"zone:{z}:score"
DEVICES_KEY = "devices"
EVENTS_KEY = "events"
