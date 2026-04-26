# Franklin

> Listen to the grid. Watch it breathe.

Franklin is an end-to-end transformer-health platform: a Raspberry Pi
sensor-pack on the asset, a fusion server that scores it in real time,
a Lambda Cloud GPU that segments the audio for fault prompts, and a
Next.js operator dashboard that closes the loop with two-way control.

A blown transformer doesn't just fail — it whispers, then it pops, then
it arcs, then it explodes. We catch the whispers.

```
┌────────────┐  Si7021  ADS1115        ┌──────────────┐
│  Pi Zero   │ ─────────────────────►  │   Upstash    │ ◄────────┐
│  + Ring    │   temp / humidity / mic │   Redis      │          │
│            │ ◄─────  cmd:<dev>  ──── │              │          │
└────┬───────┘  GETDEL each loop       └──────┬───────┘          │
     │  ▲                                     │                  │
SIGUSR1│  │ssh                          poll  │                  │
     │  │                                     ▼                  │
┌────┴──┴────┐  /api/devices/<id>/cmd   ┌──────────────┐  rewrite ┌─────────┐
│   Flask    │ ◄──────────────────────  │  Next.js     │ ──────►  │ /viewer │
│ franklin/  │   POST recalibrate       │  /grid-      │   /work/ │  Flask  │
│   server   │   POST configure         │   sensor     │          │  static │
│            │ ◄─── /api/audio/run ──── │  /dashboard  │          └─────────┘
└────┬───────┘                          └──────────────┘
     │ ssh + scp
     ▼
┌────────────┐
│   Lambda   │  SAM-Audio · A100 / A10
│ Cloud GPU  │  isolates "transformer hum",
│            │  "popping", "arcing", … from
│  sam-audio │  any uploaded clip
└────────────┘
```

## What's in the box

| Path | What it is |
|------|------------|
| [`raspi-firmware/`](raspi-firmware/) | Pi Zero 2 W firmware. Si7021 over I2C, SPW2430 mic via ADS1115, SK6812 RGBW 16-LED ring on PWM0. Pushes telemetry to Upstash REST every 2 s and polls `cmd:<DEVICE_ID>` for inbound commands. |
| [`franklin/server/`](franklin/server/) | Flask API. Proxies the Lambda Cloud GPU for audio segmentation, queues Pi commands into Upstash, and SSHes the Pi to wake it via `SIGUSR1`. |
| [`franklin/fusion/`](franklin/fusion/) | Per-device health scoring. Reads telemetry from Upstash, writes per-device + per-zone scores back. |
| [`franklin/web/`](franklin/web/) | Next.js 14 (App Router) operator UI. `/grid-sensor` for fleet telemetry + recalibration, `/dashboard` for the OpenDSS data-center agent demo with the live sensor pinned top-left, `/viewer` for SAM-Audio segmentation playback. |
| [`franklin/viewer/`](franklin/viewer/) | Static HTML viewer for SAM-Audio outputs (per-prompt target + residual playback). Served by Flask, proxied through Next at `/viewer`. |
| [`audio/`](audio/) | Local exploration of Meta SAM-Audio (blocked on Apple Silicon — runs on cloud GPU). |

## How it works

### 1 · Telemetry out (Pi → Upstash → Web)

Every 2 seconds, the Pi reads:

- **Temperature + humidity** off a Si7021 over I2C.
- **Microphone peak-to-peak voltage** off a SPW2430 analog mic via an
  ADS1115 ADC (50 single-shot conversions @ 860 SPS).

It pipelines these into Upstash Redis as `device:<id>:tele` (list) +
`device:<id>:latest` (string). The Next.js UI polls `/api/devices` (which
hits Upstash directly) every 2 s and renders cards with:

- A live **Overall Health** score (0–100) that's heavily temp-sensitive:
  Δ°F drift from baseline drives 65 % of the score with a squared-falloff
  curve, absolute temp band (70–80 °F ideal) drives 20 %, humidity 15 %,
  and microphone activity acts as a sensitivity-weighted penalty.
- A **real waveform** sampled from `chatter.mp3` (1024 ffmpeg-extracted
  peaks) windowed per-device with stable hash-derived offsets. Live cards
  scroll horizontally via `requestAnimationFrame` and tint green.
- A **LIVE** badge + glow border for the actual hardware sensor when its
  last update is < 30 minutes old.

### 2 · Commands in (Web → Upstash → Pi)

Click **Recalibrate** on a card → opens a popover with two sliders
(temp + mic sensitivity 1–10) → **Confirm recalibration**:

```
Web                  Next.js              Flask                 Pi
 │  POST              │  proxy             │  SET cmd:sensor1   │
 ├──────────────────► ├──────────────────► ├──── EX 30 ────────►│  Upstash
 │  {type:"recalibrate"│                   │                    │
 │   ,duration:6       │                   │  ssh + sudo        │
 │   ,mic_noise_floor_v│                   │  systemctl kill    │
 │   ,mic_saturation_v │                   │  --signal=SIGUSR1 ►│  firmware.service
 │   ,temp_threshold_c │                   │                    │
 │  }                  │                   │                    │
 │                     │                   │                    │  ▼
 │                     │                   │                    │  time.sleep
 │                     │                   │                    │  interrupted →
 │                     │                   │                    │  fetch_pending_command()
 │                     │                   │                    │  GETDEL cmd:sensor1
 │                     │                   │                    │  apply tunables
 │                     │                   │                    │  reset baseline
 │                     │                   │                    │  ring.render_recalibrate()
 │                     │                   │                    │     6 s flashy LEDs
```

The **`SIGUSR1` kick** is the secret sauce. The Pi naturally polls once
per loop (~2 s); a SIGUSR1 from the Mac interrupts `time.sleep` so the
operator sees the LED ring respond instantly instead of after a sample-tick
latency. The signal handler is a no-op — the wake itself is the work.

### 3 · Audio fault segmentation (Web → Lambda Cloud)

Click **Audio analysis ↗** on any card → `/viewer/?device=<id>` (proxied
through Next to the Flask static server). Upload audio (or pick the
sample chatter clip) → POST `/api/audio/run` with prompts like
`"popping"; "transformer hum"; "arcing"` → Flask:

1. SCPs the input to `ubuntu@<lambda-cloud-host>:~/franklin/inputs/`.
2. SSHes in and runs `run_inference.py` against
   `facebook/sam-audio-small` on the A100/A10 GPU.
3. Streams stdout back as Server-Sent Events.
4. SCPs `target__<prompt>.wav` and `residual__<prompt>.wav` back per
   prompt and exposes them as `<audio>` players in the viewer.

The fault prompts (`fault_prompts.py`) map to IEEE C57.127 fault
classes (`partial_discharge`, `arcing`, `loose_winding`,
`cooling_fan_imbalance`, …).

## Quickstart

### Run the web app

```sh
cd franklin/web
# .env.local symlinks to /kaido/.env
PORT=$(echo "$PWD" | cksum | awk '{print 3000 + ($1 % 1000)}')
npx next dev -p $PORT       # → http://127.0.0.1:$PORT
```

### Run the Flask server (audio + commands)

```sh
cd franklin
.venv/bin/python -m server.app   # → http://127.0.0.1:3782
```

The web app proxies `/api/audio/*`, `/api/devices/[id]/command`, `/viewer/*`,
and `/work/*` to `FRANKLIN_SERVER_URL` (default `http://127.0.0.1:3782`).
**In production, point that env var at a publicly reachable Flask URL
(e.g. a Cloudflare Tunnel back to your Mac) — Netlify cannot reach
`127.0.0.1`.**

### Flash the Pi

```sh
cd raspi-firmware
./provision-sd.sh /dev/diskN          # writes Pi OS + bootstrap config
# Boot the Pi; bootstrap-pi.sh runs once on first login
sudo systemctl status firmware        # firmware.service
journalctl -u firmware -f             # live logs
```

`firmware.conf.example` documents every env var: device id, Upstash
creds, sample interval, baseline window, mic enable, etc.

### Run the cloud SAM-Audio (one-time setup)

```sh
ssh ubuntu@<lambda-cloud-ip> 'bash -s' < franklin/lambda_setup.sh
# Then HF login + first inference happens via the web UI's audio analysis flow
```

## Tech stack

- **Hardware**: Raspberry Pi Zero 2 W · Si7021 (I²C) · SPW2430 mic + ADS1115 ADC · SK6812 RGBW 16-LED ring
- **Edge**: Python 3 firmware · `smbus2` · `rpi_ws281x` · `requests`
- **State**: Upstash Redis (REST API both directions)
- **Backend**: Flask · OpenSSH (subprocess, no paramiko)
- **GPU**: Lambda Cloud (A100 40 GB or A10 24 GB) · `facebook/sam-audio-small` · `torchaudio` · bf16
- **Frontend**: Next.js 14 (App Router) · React 18 · Mapbox GL · hand-rolled `globals.css`
- **Grid model**: OpenDSS scenarios (`franklin/web/lib/opendss/`)

## Project layout

```
kaido/
├── README.md                ← you are here
├── .env                     ← Upstash + HF + OpenAI creds (gitignored)
├── audio/                   ← local Meta SAM-Audio exploration
├── raspi-firmware/          ← Pi Zero firmware
│   ├── main.py              ← sensor read loop + command poll + SIGUSR1
│   ├── ring.py              ← LED rendering primitives + recalibrate animation
│   ├── bootstrap-pi.sh      ← one-shot Pi setup
│   └── OPERATIONS.md        ← runbook
└── franklin/
    ├── server/app.py        ← Flask API
    ├── fusion/              ← health scoring + Upstash helpers
    ├── viewer/              ← static SAM-Audio playback HTML
    ├── work/                ← per-source inputs + outputs (gitignored)
    └── web/                 ← Next.js operator UI
        ├── app/grid-sensor/ ← fleet view + recalibration + audio analysis link
        ├── app/dashboard/   ← OpenDSS demo + FranklinLiveSensor pinned left
        ├── app/api/audio/   ← proxy → Flask SAM-Audio job pipeline
        ├── app/api/devices/[id]/command  ← proxy → Flask /api/devices/<id>/command
        └── components/      ← FranklinLiveSensor, ChatterWaveform, SensitivityControls, …
```

## Naming

> Named after Benjamin Franklin — kite, key, lightning. He learned the
> grid by listening to it crackle. So do we.

## Status

Pre-production research project. Ships the full data path (Pi → cloud →
operator → Pi) and a working SAM-Audio segmentation pipeline. Nothing in
here is paged on call yet; treat it as a proof that the loop closes.

## License

TBD.
