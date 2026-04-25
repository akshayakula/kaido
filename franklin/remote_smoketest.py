"""Smoke test: load SAM-Audio-large, isolate a target sound from a public sample."""
import os
import time
from pathlib import Path

import torch
import torchaudio

from huggingface_hub import login
from sam_audio import SAMAudio, SAMAudioProcessor

HF_TOKEN = os.environ["HF_TOKEN"]
login(HF_TOKEN)

OUT = Path("~/franklin").expanduser()
OUT.mkdir(exist_ok=True)

# Use librosa's bundled CC0 sample (multi-instrument music — good test for "trumpet" prompt)
import librosa  # bundled with audiobox_aesthetics
sample_path = librosa.example("trumpet")
print(f"sample: {sample_path}")
print(f"  size: {os.path.getsize(sample_path) / 1024:.1f} KiB")

t0 = time.time()
print("loading model …")
model_id = os.environ.get("SAM_MODEL", "facebook/sam-audio-small")
print(f"  model: {model_id}")
model = SAMAudio.from_pretrained(model_id)
processor = SAMAudioProcessor.from_pretrained(model_id)
model = model.eval().cuda()
print(f"  model loaded in {time.time()-t0:.1f}s")

prompt = "trumpet"
print(f"running separation with prompt: {prompt!r}")

t1 = time.time()
batch = processor(audios=[sample_path], descriptions=[prompt]).to("cuda")
with torch.inference_mode():
    result = model.separate(batch, predict_spans=False, reranking_candidates=1)
print(f"  inference: {time.time()-t1:.1f}s")

sr = processor.audio_sampling_rate

def _save(x, path):
    if isinstance(x, list):
        x = x[0]
    if x.dim() == 1:
        x = x.unsqueeze(0)
    torchaudio.save(str(path), x.cpu().float(), sr)

_save(result.target, OUT / "target.wav")
_save(result.residual, OUT / "residual.wav")

print(f"wrote: {OUT}/target.wav  {OUT}/residual.wav  {OUT}/input.wav")
print(f"sample rate: {sr}")
print("SMOKE_OK")
