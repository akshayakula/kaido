#!/usr/bin/env bash
# SSH into a freshly-booted Pi, install deps + firmware, enable systemd unit.
#
# Usage:
#   ./bootstrap-pi.sh <pi-host> [ssh-user]
#
# Requires:
#   - Pi is booted, on WiFi, SSH is enabled (Imager OS customization)
#   - Your SSH key is in the Pi's authorized_keys
#   - /boot/firmware/firmware.conf already exists (run provision-sd.sh first)

set -euo pipefail

PI_HOST="${1:-}"
SSH_USER="${2:-akshay}"

if [[ -z "$PI_HOST" ]]; then
  echo "usage: $0 <pi-host> [ssh-user]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> copying firmware files to ${SSH_USER}@${PI_HOST}:/tmp/"
scp -o StrictHostKeyChecking=accept-new \
    "$SCRIPT_DIR/main.py" \
    "$SCRIPT_DIR/ring.py" \
    "$SCRIPT_DIR/firmware.service" \
    "$SCRIPT_DIR/firmware.conf.example" \
    "${SSH_USER}@${PI_HOST}:/tmp/"

echo "==> installing on Pi (will prompt for sudo password)"
ssh -t "${SSH_USER}@${PI_HOST}" bash <<'EOF'
set -euo pipefail

echo "--- apt packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3 python3-pip python3-rpi.gpio i2c-tools \
    python3-requests python3-setuptools

echo "--- pip packages (rpi_ws281x not in apt on Bookworm)"
sudo pip3 install --break-system-packages rpi_ws281x smbus2

echo "--- enabling I2C + disabling onboard audio (NeoPixel needs PWM0)"
CONFIG=/boot/firmware/config.txt
sudo grep -q '^dtparam=i2c_arm=on' $CONFIG || echo 'dtparam=i2c_arm=on' | sudo tee -a $CONFIG >/dev/null
sudo grep -q '^dtparam=audio=off' $CONFIG || echo 'dtparam=audio=off' | sudo tee -a $CONFIG >/dev/null
sudo raspi-config nonint do_i2c 0 || true

echo "--- installing firmware to /usr/local/lib/raspi-firmware/"
sudo install -d /usr/local/lib/raspi-firmware
sudo install -m 0644 /tmp/main.py /usr/local/lib/raspi-firmware/main.py
sudo install -m 0644 /tmp/ring.py /usr/local/lib/raspi-firmware/ring.py

echo "--- installing firmware.service"
sudo install -m 0644 /tmp/firmware.service /etc/systemd/system/firmware.service

if [[ ! -f /boot/firmware/firmware.conf ]]; then
  echo "--- WARNING: /boot/firmware/firmware.conf missing; copying example (you must edit it)"
  sudo install -m 0644 /tmp/firmware.conf.example /boot/firmware/firmware.conf
fi

echo "--- enabling + starting firmware.service"
sudo systemctl daemon-reload
sudo systemctl enable firmware.service
sudo systemctl restart firmware.service
sleep 2
sudo systemctl status --no-pager firmware.service | head -20 || true

echo "--- I2C scan (should show 40 if Si7021 is wired):"
sudo i2cdetect -y 1 || true

echo "--- done; reboot recommended for config.txt changes to take effect"
EOF

echo
echo "==> tail logs:  ssh ${SSH_USER}@${PI_HOST} 'journalctl -u firmware -f'"
