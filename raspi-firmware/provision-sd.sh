#!/usr/bin/env bash
# Writes /boot/firmware/firmware.conf to a freshly-flashed Pi OS SD card.
#
# Usage:
#   ./provision-sd.sh <device-id> [pi-name] [bootfs-path]
#
# Example:
#   ./provision-sd.sh load1 pi-load1
#
# Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from your environment
# (or a sibling .env file). Never bake those into firmware.conf.example.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <device-id> [pi-name] [bootfs-path]" >&2
  exit 1
fi

DEVICE_ID="$1"
PI_NAME="${2:-pi-$DEVICE_ID}"
BOOTFS="${3:-/Volumes/bootfs}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
fi

: "${UPSTASH_REDIS_REST_URL:?set UPSTASH_REDIS_REST_URL in env or .env}"
: "${UPSTASH_REDIS_REST_TOKEN:?set UPSTASH_REDIS_REST_TOKEN in env or .env}"

if [[ ! -d "$BOOTFS" ]]; then
  if [[ -d "/Volumes/NO NAME" ]]; then
    echo "error: SD at '/Volumes/NO NAME' looks blank — flash Raspberry Pi OS first." >&2
  else
    echo "error: bootfs not mounted at $BOOTFS" >&2
    echo "  currently mounted volumes:" >&2
    ls /Volumes >&2
  fi
  exit 1
fi

OUT="$BOOTFS/firmware.conf"
cat > "$OUT" <<EOF
# raspi-firmware config (written by provision-sd.sh)
PI_NAME=$PI_NAME
DEVICE_ID=$DEVICE_ID

UPSTASH_REDIS_REST_URL=$UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN=$UPSTASH_REDIS_REST_TOKEN
TELEMETRY_KEY=telemetry
TELEMETRY_MAX=1000

SAMPLE_INTERVAL_S=2
BASELINE_SAMPLES=10
TEMP_THRESHOLD_C=2.5
STABLE_WINDOW_S=30
STABLE_STDDEV_C=0.15
EOF

echo "wrote $OUT"
echo
echo "next steps:"
echo "  1) eject the SD, boot the Pi"
echo "  2) ./bootstrap-pi.sh $PI_NAME.local"
