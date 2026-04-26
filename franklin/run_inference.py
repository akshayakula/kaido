"""Run SAM-Audio on a user-supplied audio file with one or more text prompts.

Usage on the box:
    HF_TOKEN=hf_... AUDIO=~/franklin/input.mp3 \
        PROMPTS="transformer hum;electrical buzz" \
        SAM_MODEL=facebook/sam-audio-small \
        python run_inference.py

If PROMPTS is omitted or set to "ALL", uses the canonical fault-prompt list
from fault_prompts.py (transformer health + fault categories).
"""
import os
import time
from pathlib import Path

import torch
import torchaudio
from huggingface_hub import login
from sam_audio import SAMAudio, SAMAudioProcessor

HF_TOKEN = os.environ["HF_TOKEN"]
login(HF_TOKEN)

AUDIO = Path(os.environ["AUDIO"]).expanduser()
_prompts_env = os.environ.get("PROMPTS", "ALL").strip()
if _prompts_env in ("", "ALL"):
    from fault_prompts import ALL_PROMPTS
    PROMPTS = ALL_PROMPTS
else:
    PROMPTS = [p.strip() for p in _prompts_env.split(";") if p.strip()]
MODEL_ID = os.environ.get("SAM_MODEL", "facebook/sam-audio-small")
OUT = Path(os.environ.get("OUT", "~/franklin/work")).expanduser()
OUT.mkdir(parents=True, exist_ok=True)
DTYPE_NAME = os.environ.get("DTYPE", "bfloat16")
DTYPE = getattr(torch, DTYPE_NAME)

print(f"audio: {AUDIO}  ({AUDIO.stat().st_size/1024:.0f} KiB)")
print(f"model: {MODEL_ID}  dtype: {DTYPE_NAME}")
print(f"prompts: {PROMPTS}")

t0 = time.time()
print("loading model …")
model = SAMAudio.from_pretrained(MODEL_ID)
processor = SAMAudioProcessor.from_pretrained(MODEL_ID)
model = model.eval().to("cuda", dtype=DTYPE)
print(f"  model loaded in {time.time()-t0:.1f}s "
      f"(GPU mem {torch.cuda.memory_allocated()/1e9:.2f} GB)")

sr = processor.audio_sampling_rate

def _prep_audio(path, target_seconds=30):
    """Load, downmix to mono, trim/pad to exactly target_seconds at sr."""
    wav, src_sr = torchaudio.load(str(path))
    if src_sr != sr:
        wav = torchaudio.functional.resample(wav, src_sr, sr)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    target_n = target_seconds * sr
    n = wav.shape[-1]
    if n < target_n:
        wav = torch.nn.functional.pad(wav, (0, target_n - n))
    else:
        wav = wav[..., :target_n]
    # SAM-Audio rounds up to next 4096-sample boundary internally; match it
    n = wav.shape[-1]
    extra = (-n) % 4096
    if extra:
        wav = torch.nn.functional.pad(wav, (0, extra))
    out = path.parent / (path.stem + ".prepped.wav")
    torchaudio.save(str(out), wav, sr)
    print(f"  prepped: {out}  ({wav.shape[-1]/sr:.2f}s mono @ {sr})")
    return out

PREPPED = _prep_audio(AUDIO)

def _save(x, path):
    if isinstance(x, list):
        x = x[0]
    if x.dim() == 1:
        x = x.unsqueeze(0)
    torchaudio.save(str(path), x.cpu().float(), sr)

for prompt in PROMPTS:
    print(f"\n=== prompt: {prompt!r} ===")
    t1 = time.time()
    batch = processor(audios=[str(PREPPED)], descriptions=[prompt]).to("cuda")
    # Cast any float tensors in the batch to model dtype
    for k, v in vars(batch).items() if hasattr(batch, "__dict__") else []:
        if torch.is_tensor(v) and v.is_floating_point():
            setattr(batch, k, v.to(DTYPE))
    with torch.autocast("cuda", dtype=DTYPE):
        with torch.inference_mode():
            result = model.separate(batch, predict_spans=False, reranking_candidates=1)
    t2 = time.time()

    safe = prompt.replace(" ", "_").replace("/", "-")
    _save(result.target, OUT / f"target__{safe}.wav")
    _save(result.residual, OUT / f"residual__{safe}.wav")
    print(f"  inference: {t2-t1:.1f}s  -> target__{safe}.wav, residual__{safe}.wav")
    print(f"  GPU mem peak: {torch.cuda.max_memory_allocated()/1e9:.2f} GB")
    torch.cuda.reset_peak_memory_stats()

print("\nDONE")
