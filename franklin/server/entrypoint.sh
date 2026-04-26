#!/usr/bin/env bash
# Materialize the Lambda SSH key from a base64 Fly secret into a real file
# before starting the Flask server. This avoids storing the private key in
# the repo or in the image.
#
# Set with:
#   base64 -i ~/.ssh/lambda_kaido | pbcopy
#   fly secrets set LAMBDA_KEY_B64="<paste>"
set -euo pipefail

KEY_PATH="${LAMBDA_KEY:-/root/.ssh/lambda_kaido}"

if [[ -n "${LAMBDA_KEY_B64:-}" ]]; then
  mkdir -p "$(dirname "$KEY_PATH")"
  echo "$LAMBDA_KEY_B64" | base64 -d > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  echo "[entrypoint] wrote ssh key to $KEY_PATH"
else
  echo "[entrypoint] LAMBDA_KEY_B64 not set; SSH-dependent endpoints will fail until it is."
fi

# Trust Lambda host fingerprint if provided so jobs don't get prompted.
if [[ -n "${LAMBDA_HOST:-}" ]]; then
  HOSTNAME_ONLY="${LAMBDA_HOST##*@}"
  ssh-keyscan -H "$HOSTNAME_ONLY" >> /root/.ssh/known_hosts 2>/dev/null || true
fi

# Make sure /app is on PYTHONPATH so gunicorn can import franklin.server.app
export PYTHONPATH="/app:${PYTHONPATH:-}"

# Hand off to gunicorn (or whatever CMD says).
exec "$@"
