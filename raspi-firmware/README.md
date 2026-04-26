# raspi-firmware — Si7021 load monitor + NeoPixel ring

Pi Zero 2 W firmware. Reads a Si7021 temperature/humidity sensor over I2C,
visualizes thermal load on a 16-LED SK6812 RGBW ring, and posts samples to
Upstash Redis over its REST API.

Sibling-of-enel: same provisioning workflow (`provision-sd.sh` + `bootstrap-pi.sh`),
no camera, no streamer.

## Wiring

**Si7021 (I2C bus 1)**

| Si7021 | Pi physical pin |
|---|---|
| VIN / VCC (3.3V) | 1 |
| GND | 9 |
| SDA | 3 (GPIO 2) |
| SCL | 5 (GPIO 3) |

**NeoPixel SK6812 RGBW 16-ring**

| Ring | Pi physical pin |
|---|---|
| 5V | 2 |
| GND | 6 |
| DIN | 12 (GPIO 18, PWM0) |

`bootstrap-pi.sh` adds `dtparam=audio=off` so PWM0 is free for the ring.

## Ring behavior

- First `BASELINE_SAMPLES` (default 10) readings define the baseline.
- 8 LEDs lit at baseline; fills toward 16 as Δ → +threshold, drains toward 0
  as Δ → −threshold. Default threshold is ±2.5 °C.
- Color: red as the Pi heats up, blue as it cools, **green when stable**
  (rolling stddev over the last 30 s under 0.15 °C).

## Files

| File | Where it runs | What |
|---|---|---|
| `main.py` | Pi | sample loop: Si7021 → ring + Upstash |
| `ring.py` | Pi | NeoPixel rendering primitives |
| `firmware.service` | Pi | systemd unit |
| `firmware.conf.example` | — | config template |
| `provision-sd.sh` | Mac | writes `firmware.conf` to SD `bootfs` |
| `bootstrap-pi.sh` | Mac | SSH-installs firmware on a booted Pi |

## First-time flash

1. **Flash Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In OS
   customization set hostname (e.g. `pi-load1`), SSH key, user, and WiFi
   (`Verizon_P4MFYG` / `wax7-cpu-overt`).
2. **Drop config on SD.** Create `raspi-firmware/.env` with your Upstash creds:
   ```bash
   UPSTASH_REDIS_REST_URL=https://fresh-oryx-106816.upstash.io
   UPSTASH_REDIS_REST_TOKEN=...
   ```
   Then:
   ```bash
   ./provision-sd.sh load1 pi-load1
   ```
3. **Eject + boot the Pi.** Wait ~60 s for WiFi.
4. **Bootstrap over SSH:**
   ```bash
   ./bootstrap-pi.sh pi-load1.local akshay
   ```
   Reboot once after first install so `dtparam=audio=off` takes effect.
5. **Tail logs:**
   ```bash
   ssh akshay@pi-load1.local 'journalctl -u firmware -f'
   ```

## Verifying the sensor

After SSH'ing in:

```bash
sudo i2cdetect -y 1   # should show 40
```

## Tuning later

Edit `/boot/firmware/firmware.conf` on the Pi (or pull the SD), then
`sudo systemctl restart firmware`. Knobs: `TEMP_THRESHOLD_C`,
`SAMPLE_INTERVAL_S`, `BASELINE_SAMPLES`, `STABLE_WINDOW_S`, `STABLE_STDDEV_C`.

## TODO

- Mic capture + upload to a future audio endpoint.
