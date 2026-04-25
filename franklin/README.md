# franklin

Transformer health monitoring via audio (SAM-Audio) + temperature + grid signals.

## What's here

- `gridstatus-notes.md` — research notes on the gridstatus.io API (datasets,
  free-plan limits, rotation strategy, useful dataset families).
- `lambda_setup.sh` — early scaffold for Lambda setup (superseded by
  `remote_install.sh`).
- `remote_install.sh` — runs on a fresh Lambda Cloud GPU instance: installs
  uv → Python 3.11 → torch CUDA → SAM-Audio + deps.
- `remote_smoketest.py` — runs on the instance: downloads librosa's CC0
  trumpet sample, loads SAM-Audio, isolates "trumpet" with a text prompt,
  saves `target.wav` and `residual.wav`.

## Smoke test result (A100 40 GB, Lambda Cloud)

- Model: `facebook/sam-audio-small` (large + base OOM on 24 GB A10)
- Sample: librosa's `sorohanro_-_solo-trumpet-06.ogg` (~5 s, 26 KB)
- Prompt: `"trumpet"`
- Cold-start model load: ~155 s (large), ~68 s (small, second run, cache warm)
- Inference: **1.7 s**
- Output: 48 kHz mono WAVs in `work/` (gitignored)

## Reproducing

1. Provision a Lambda Cloud GPU (≥40 GB VRAM — `gpu_1x_a100_sxm4` or `gpu_1x_h100_*`).
   `gpu_1x_a10` (24 GB) is **not enough** for SAM-Audio at fp32, even `-small`.
2. `scp` `remote_install.sh` and `remote_smoketest.py` to `~/`.
3. SSH in and run:
   ```
   curl -LsSf https://astral.sh/uv/install.sh | sh
   export PATH=$HOME/.local/bin:$PATH
   export HF_TOKEN=hf_...
   bash ~/remote_install.sh
   cd ~/sam-audio && source .venv/bin/activate
   uv pip install --force-reinstall torch torchaudio torchvision \
       --index-url https://download.pytorch.org/whl/cu128
   uv pip install 'transformers>=4.54,<5.0' 'huggingface_hub<1.0'
   SAM_MODEL=facebook/sam-audio-small python ~/remote_smoketest.py
   ```

## Compatibility footnotes

- `transformers>=5.0` and `huggingface_hub>=1.0` break SAM-Audio's
  `BaseModel.from_pretrained` mixin. Pin `<5.0` and `<1.0`.
- Lambda's preinstalled CUDA driver is 12.8 — pip's default torch wheel
  expects newer. Force `--index-url https://download.pytorch.org/whl/cu128`.
- Mac M-series is a non-starter for local SAM-Audio: `xformers` has no
  Apple Silicon wheels. See `audio/README.md`.
