# audio

Exploration of [Meta SAM-Audio](https://github.com/facebookresearch/sam-audio).

## Status

Cloned and installed in a Python 3.11 venv with workarounds:
- `eva-decord` substituted for `decord` (no Mac arm64 wheels)
- `perception-models` installed `--no-deps`
- `sam_audio` installed `--no-deps`

**Blocked on local Mac M-series:** `core.transformer` imports `xformers` at module load.
xformers has no Apple Silicon wheels and won't build from source.

## Hosted options

- Meta web demo (no API): https://aidemos.meta.com/segment-anything/editor/segment-audio
- No turnkey hosted API exists yet (no HF Inference Provider, no fal/Replicate listing).
- To run programmatically: deploy on Modal / Replicate / HF Inference Endpoints.

## Reproducing the local setup

```sh
python3.11 -m venv .venv
.venv/bin/pip install eva-decord
.venv/bin/pip install --no-deps "perception-models@git+https://github.com/facebookresearch/perception_models@unpin-deps"
.venv/bin/pip install \
  torch torchaudio torchvision torchcodec torchdiffeq \
  "transformers>=4.54.0" einops numpy pydub audiobox_aesthetics \
  "dacvae@git+https://github.com/facebookresearch/dacvae.git" \
  "imagebind@git+https://github.com/facebookresearch/ImageBind.git" \
  "laion-clap@git+https://github.com/lematt1991/CLAP.git"
.venv/bin/pip install --no-deps ./sam-audio
# import will fail at xformers — needs cloud GPU or shim
```
