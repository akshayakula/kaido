#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

cd ~
[ -d sam-audio ] || git clone https://github.com/facebookresearch/sam-audio.git
cd sam-audio

# Python 3.11 venv via uv, with torch+CUDA wheels
uv venv --python 3.11 .venv
source .venv/bin/activate

# Install torch first so sam-audio's deps see it (CUDA 12.x wheels on Lambda's driver)
uv pip install torch torchaudio torchvision

# Install sam-audio (Linux + Python 3.11 should not need decord workarounds)
uv pip install .

# Sanity check
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0))"
python -c "from sam_audio import SAMAudio, SAMAudioProcessor; print('sam_audio import: ok')"

echo "INSTALL_OK"
