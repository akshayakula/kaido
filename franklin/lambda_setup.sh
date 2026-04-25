#!/usr/bin/env bash
# Run on the Lambda A10 instance to install SAM-Audio and run a smoke test.
# Lambda Stack (Ubuntu 22.04 + CUDA + PyTorch preinstalled) is the host image.
set -euo pipefail

echo ">>> python / torch baseline"
python3 --version
python3 -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

echo ">>> clone sam-audio"
cd ~
[ -d sam-audio ] || git clone https://github.com/facebookresearch/sam-audio.git
cd sam-audio

echo ">>> venv with system site-packages (reuse Lambda Stack's torch+cuda)"
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install --upgrade pip wheel

echo ">>> install sam-audio"
pip install .

echo ">>> hf login"
hf auth login --token "$HF_TOKEN" --add-to-git-credential || \
  HF_TOKEN="$HF_TOKEN" python3 -c "from huggingface_hub import login; import os; login(os.environ['HF_TOKEN'])"

echo ">>> grab a stock audio sample (esc-50 dog bark + speech mix from huggingface)"
mkdir -p ~/franklin && cd ~/franklin
[ -f sample.wav ] || curl -L -o sample.wav \
  "https://huggingface.co/datasets/facebook/sam-audio-eval/resolve/main/examples/dog_bark_speech.wav" || true

# Fallback: synthesize a simple mix using torchaudio
if [ ! -s sample.wav ]; then
  echo ">>> stock URL unavailable, will synthesize sample at runtime"
fi

echo ">>> ready"
