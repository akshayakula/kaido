#!/usr/bin/env python3
# Load-monitor firmware: Si7021 → Upstash Redis + NeoPixel ring visualization.
import json
import os
import signal
import statistics
import sys
import time
from collections import deque

import requests
from smbus2 import SMBus, i2c_msg

import ring

SI7021_ADDR        = 0x40
SI7021_MEAS_TEMP   = 0xF3  # measure temperature, no hold master
SI7021_MEAS_HUM    = 0xF5  # measure humidity, no hold master
I2C_BUS            = 1

PI_NAME            = os.environ.get("PI_NAME", "pi-load")
DEVICE_ID          = os.environ.get("DEVICE_ID", "load1")
DEVICE_ZONE        = os.environ.get("DEVICE_ZONE", "DOM")
DEVICE_PROFILE     = os.environ.get("DEVICE_PROFILE", "unknown")
UPSTASH_URL        = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN      = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
TELEMETRY_KEY      = os.environ.get("TELEMETRY_KEY", "telemetry")
TELEMETRY_MAX      = int(os.environ.get("TELEMETRY_MAX", "1000"))
DEVICE_TELE_MAX    = int(os.environ.get("DEVICE_TELE_MAX", "2000"))

SAMPLE_INTERVAL_S  = float(os.environ.get("SAMPLE_INTERVAL_S", "2"))
BASELINE_SAMPLES   = int(os.environ.get("BASELINE_SAMPLES", "10"))
TEMP_THRESHOLD_C   = float(os.environ.get("TEMP_THRESHOLD_C", "2.5"))
STABLE_WINDOW_S    = float(os.environ.get("STABLE_WINDOW_S", "30"))
STABLE_STDDEV_C    = float(os.environ.get("STABLE_STDDEV_C", "0.15"))


def read_si7021(bus):
    """Returns (temp_c, humidity_pct). Raises OSError on I2C failure."""
    bus.write_byte(SI7021_ADDR, SI7021_MEAS_HUM)
    time.sleep(0.025)
    read = i2c_msg.read(SI7021_ADDR, 2)
    bus.i2c_rdwr(read)
    raw = list(read)
    hum_raw = (raw[0] << 8) | raw[1]
    humidity = ((hum_raw * 125.0) / 65536.0) - 6.0

    bus.write_byte(SI7021_ADDR, SI7021_MEAS_TEMP)
    time.sleep(0.025)
    read = i2c_msg.read(SI7021_ADDR, 2)
    bus.i2c_rdwr(read)
    raw = list(read)
    t_raw = (raw[0] << 8) | raw[1]
    temp_c = ((t_raw * 175.72) / 65536.0) - 46.85
    return temp_c, humidity


def upstash_post(commands):
    """Send a pipeline of Redis commands. commands: list of [cmd, ...args]."""
    if not UPSTASH_URL or not UPSTASH_TOKEN:
        return
    try:
        r = requests.post(
            f"{UPSTASH_URL}/pipeline",
            headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
            json=commands,
            timeout=5,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"upstash post failed: {e}", file=sys.stderr)


def wifi_up():
    try:
        with open("/sys/class/net/wlan0/operstate") as f:
            return f.read().strip() == "up"
    except OSError:
        return False


def wait_for_wifi(strip):
    """Pulse blue until wlan0 is up, then play a short connected animation."""
    start = time.monotonic()
    while not wifi_up():
        ring.render_wifi_pulse(strip, time.monotonic() - start)
        time.sleep(1.0 / 30.0)
    anim_start = time.monotonic()
    duration = 1.5
    while True:
        t = time.monotonic() - anim_start
        if t >= duration:
            break
        ring.render_wifi_connected(strip, t, duration=duration)
        time.sleep(1.0 / 30.0)


def register_device():
    """Announce ourselves so the fusion runner discovers us."""
    upstash_post([
        ["SADD", "devices", DEVICE_ID],
        ["SADD", f"zone:{DEVICE_ZONE}:devices", DEVICE_ID],
        ["SET", f"device:{DEVICE_ID}:meta", json.dumps({
            "device": DEVICE_ID, "name": PI_NAME, "zone": DEVICE_ZONE,
            "profile": DEVICE_PROFILE, "registered_at": time.time(),
        })],
    ])


def main():
    strip = ring.make_strip()
    register_device()

    def _exit(_sig, _frame):
        try:
            ring.clear(strip)
        finally:
            sys.exit(0)
    signal.signal(signal.SIGTERM, _exit)
    signal.signal(signal.SIGINT, _exit)

    ring.boot_wipe(strip)
    wait_for_wifi(strip)

    # rolling window for stable-detection (last STABLE_WINDOW_S seconds)
    window_n = max(2, int(STABLE_WINDOW_S / SAMPLE_INTERVAL_S))
    samples = deque(maxlen=window_n)

    baseline = None
    baseline_samples = []
    start = time.monotonic()

    with SMBus(I2C_BUS) as bus:
        while True:
            now_mono = time.monotonic()
            t = now_mono - start

            try:
                temp_c, humidity = read_si7021(bus)
            except OSError as e:
                print(f"i2c read failed: {e}", file=sys.stderr)
                ring.render_warn(strip, t)
                time.sleep(SAMPLE_INTERVAL_S)
                continue

            samples.append(temp_c)

            if baseline is None:
                baseline_samples.append(temp_c)
                if len(baseline_samples) >= BASELINE_SAMPLES:
                    baseline = sum(baseline_samples) / len(baseline_samples)
                    print(f"baseline locked: {baseline:.2f} C", file=sys.stderr)
                # During baselining, render at neutral (delta = 0).
                ring.render_load(strip, 0.0, TEMP_THRESHOLD_C, stable=True, t=t)
            else:
                delta = temp_c - baseline
                stable = (
                    len(samples) >= window_n
                    and statistics.pstdev(samples) < STABLE_STDDEV_C
                )
                ring.render_load(strip, delta, TEMP_THRESHOLD_C, stable, t)

            window_stddev = (
                statistics.pstdev(samples) if len(samples) >= 2 else None
            )
            payload = {
                "ts": time.time(),
                "device": DEVICE_ID,
                "zone": DEVICE_ZONE,
                "temp_c": round(temp_c, 3),
                "humidity": round(humidity, 2),
                "baseline_c": round(baseline, 3) if baseline is not None else None,
                "delta_c": round(temp_c - baseline, 3) if baseline is not None else None,
                "stable": bool(
                    window_stddev is not None and window_stddev < STABLE_STDDEV_C
                ) if baseline is not None else None,
                "stddev_c": round(window_stddev, 4) if window_stddev is not None else None,
            }
            payload_json = json.dumps(payload)
            upstash_post([
                # legacy global list (kept for back-compat)
                ["LPUSH", TELEMETRY_KEY, payload_json],
                ["LTRIM", TELEMETRY_KEY, 0, TELEMETRY_MAX - 1],
                ["SET", f"{TELEMETRY_KEY}:latest:{DEVICE_ID}", payload_json],
                # per-device list consumed by franklin.fusion
                ["LPUSH", f"device:{DEVICE_ID}:tele", payload_json],
                ["LTRIM", f"device:{DEVICE_ID}:tele", 0, DEVICE_TELE_MAX - 1],
            ])

            time.sleep(SAMPLE_INTERVAL_S)


if __name__ == "__main__":
    main()
