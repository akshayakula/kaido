# Deploying franklin/server to Fly.io

The Flask server in this directory is the backend for `/viewer` on the
Netlify-deployed Next.js app. It owns:

- `work/` uploads + SAM-Audio job outputs (persistent disk).
- SSH tunneling to the Lambda Cloud GPU box.
- The SSE event stream for live job progress.

The Next.js app under `franklin/web/app/api/audio/*` is a pure proxy that
forwards each call to this server. To make `/viewer` work in production:

1. Deploy this server to Fly.io.
2. Point Netlify's `FRANKLIN_SERVER_URL` env at the Fly URL.
3. Set the same `FRANKLIN_API_TOKEN` on both sides.

## One-time setup

```bash
# from the kaido repo root
brew install flyctl                 # if you don't have it
fly auth login

cd /path/to/kaido

# Pick an app name. Edit franklin/server/fly.toml if "franklin-server" is taken.
fly launch \
  --no-deploy \
  --copy-config \
  --config franklin/server/fly.toml \
  --dockerfile franklin/server/Dockerfile

# Persistent disk for work/
fly volumes create franklin_work --size 5 --region iad

# Secrets — set these BEFORE deploying so the first boot has them.
LAMBDA_KEY_B64=$(base64 -i ~/.ssh/lambda_kaido)
TOKEN=$(openssl rand -hex 32)

fly secrets set \
  HF_TOKEN="hf_xxx" \
  LAMBDA_HOST="ubuntu@<lambda-ip>" \
  LAMBDA_KEY_B64="$LAMBDA_KEY_B64" \
  FRANKLIN_API_TOKEN="$TOKEN"

# Deploy
fly deploy --dockerfile franklin/server/Dockerfile

# Grab the public URL — typically https://<app-name>.fly.dev
fly status
```

## Wire Netlify → Fly

In the Netlify dashboard for the kaido site → **Site settings → Environment
variables**, add:

```
FRANKLIN_SERVER_URL = https://<app-name>.fly.dev
FRANKLIN_API_TOKEN  = <same value used in fly secrets set>
```

Trigger a redeploy (or push a commit). `/viewer` now talks to Fly through the
Next.js proxies; the proxies inject `Authorization: Bearer <token>` on every
upstream call.

## Verifying

```bash
# health (no auth required)
curl https://<app-name>.fly.dev/healthz

# token-gated (should return JSON when correct, 401 otherwise)
curl -H "Authorization: Bearer $TOKEN" https://<app-name>.fly.dev/api/sources

# from the Netlify-deployed app
curl https://<your-netlify-domain>/api/audio/sources
```

## Iterating

```bash
# tail logs
fly logs

# shell in
fly ssh console

# redeploy after code edits
fly deploy --dockerfile franklin/server/Dockerfile
```

## Notes / gotchas

- **Single worker.** `gunicorn -w 1` so SSE clients always land on the same
  process that owns the in-memory `jobs` dict. Don't bump `-w` without
  externalizing job state.
- **Volume.** `franklin_work` is a Fly volume mounted at `/app/franklin/work`.
  It survives deploys but not region migrations. Snapshot or re-upload
  audio if you change `primary_region`.
- **SSH.** `LAMBDA_KEY_B64` is the base64-encoded private key (no header
  juggling). The entrypoint writes it to `/root/.ssh/lambda_kaido` at boot
  and `chmod 600`s it. `LAMBDA_HOST` is the `user@ip` form. The first
  outbound SSH call also runs `ssh-keyscan` so host fingerprints are
  trusted.
- **Auth.** When `FRANKLIN_API_TOKEN` is unset on the Flask side, the
  `/api/*` and `/work/*` routes are open. Always set it for production.
- **Uploads.** Netlify Functions cap request bodies at ~6 MB. If you need
  larger audio uploads, change `ViewerClient` to POST directly at
  `https://<app-name>.fly.dev/api/upload` with `Authorization: Bearer …`.
  CORS is already permissive in `app.py`'s `_cors_headers`.
- **Cost.** With `auto_stop_machines = "stop"` and `min_machines_running = 0`,
  the VM idles to zero between bursts. First request after idle has a
  ~2 s cold start.
