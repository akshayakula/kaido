"""Franklin pipeline server.

Serves the viewer + work files, exposes a small JSON API to upload audio,
run SAM-Audio on the Lambda Cloud GPU box, and stream progress back.

Routes:
  GET  /                       -> redirect to /viewer/
  /viewer/*, /work/*           -> static
  GET  /api/sources            -> [{name, files}]  list of work/<name>/ folders
  POST /api/upload  multipart  -> {name}           save to work/<name>/input.<ext>
  POST /api/run     json       -> {jobId}          {name, prompts, model?}
  GET  /api/jobs/<id>          -> job state JSON
  GET  /api/jobs/<id>/events   -> server-sent events stream of progress

Env (from /kaido/.env):
  HF_TOKEN              gated SAM-Audio access
  LAMBDA_API_KEY        (unused here, just sanity-checked)
  LAMBDA_HOST           ubuntu@<ip>     default: ubuntu@193.122.246.239
  LAMBDA_KEY            path to ssh key default: ~/.ssh/lambda_kaido
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from dotenv import load_dotenv
from flask import (
    Flask, Response, abort, jsonify, redirect, request, send_from_directory,
    stream_with_context,
)

ROOT = Path(__file__).resolve().parent.parent  # franklin/
KAIDO = ROOT.parent
WORK = ROOT / "work"
VIEWER = ROOT / "viewer"
WORK.mkdir(exist_ok=True)

load_dotenv(KAIDO / ".env")

LAMBDA_HOST = os.environ.get("LAMBDA_HOST", "ubuntu@193.122.246.239")
LAMBDA_KEY = os.path.expanduser(os.environ.get("LAMBDA_KEY", "~/.ssh/lambda_kaido"))
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# SSH endpoint for the Pi; used to nudge it to immediately poll the Upstash
# command channel after we queue a command (otherwise it waits up to one
# SAMPLE_INTERVAL_S for its next loop tick). Mac → Pi key auth is set up by
# raspi-firmware/OPERATIONS.md.
PI_SSH_HOSTS = {
    # Map device id -> ssh target. Override via PI_SSH_<DEVICE> env vars.
    "sensor1": os.environ.get("PI_SSH_SENSOR1", "pi-sensor1@192.168.1.14"),
}

SSH_OPTS = [
    "-i", LAMBDA_KEY,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15",
]

app = Flask(__name__)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


# ---------- auth ----------
# When FRANKLIN_API_TOKEN is set, every request to /api/* and /work/* must
# carry `Authorization: Bearer <token>` (or `?token=<token>` for raw <audio>
# tags that can't set headers). The Next.js proxies forward this header from
# their own FRANKLIN_API_TOKEN env var.
_API_TOKEN = os.environ.get("FRANKLIN_API_TOKEN", "").strip()


def _is_authed() -> bool:
    if not _API_TOKEN:
        return True  # auth disabled
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer ") and header[len("Bearer "):].strip() == _API_TOKEN:
        return True
    qp = request.args.get("token", "")
    return bool(qp) and qp == _API_TOKEN


@app.before_request
def _gate_protected_paths():
    path = request.path or ""
    if path.startswith("/api/") or path.startswith("/work/"):
        if not _is_authed():
            return jsonify({"error": "unauthorized"}), 401
    # /viewer/, /, /healthz left open by default
    return None


@app.after_request
def _cors_headers(resp):
    # The Next.js proxies are server-to-server, so CORS isn't strictly
    # needed. Allow it anyway in case a browser ever hits Flask directly
    # via a tunnel during local debugging.
    origin = request.headers.get("Origin", "")
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


# ---------- static ----------
@app.route("/")
def index():
    return redirect("/viewer/fleet.html")


@app.route("/viewer/")
@app.route("/viewer/<path:p>")
def viewer(p: str = "index.html"):
    return send_from_directory(VIEWER, p)


@app.route("/work/<path:p>")
def work_file(p: str):
    return send_from_directory(WORK, p)


# ---------- sources ----------
@app.route("/api/sources")
def list_sources():
    out = []
    for d in sorted([d for d in WORK.iterdir() if d.is_dir()]):
        files = sorted(f.name for f in d.iterdir() if f.is_file())
        out.append({"name": d.name, "files": files})
    return jsonify(out)


# ---------- upload ----------
def _safe_name(s: str) -> str:
    s = s.strip().replace(" ", "_")
    s = re.sub(r"[^A-Za-z0-9_.-]", "", s)[:60]
    return s or f"upload_{int(time.time())}"


@app.route("/api/upload", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f:
        abort(400, "no file")
    name = _safe_name(request.form.get("name") or Path(f.filename).stem)
    dest = WORK / name
    dest.mkdir(parents=True, exist_ok=True)
    # remove any prior outputs so the new run is clean
    for old in dest.glob("target__*.wav"): old.unlink()
    for old in dest.glob("residual__*.wav"): old.unlink()
    for old in dest.glob("input.*"): old.unlink()
    ext = (Path(f.filename).suffix or ".wav").lower()
    out = dest / f"input{ext}"
    f.save(str(out))
    return jsonify({"name": name, "input": f"work/{name}/{out.name}"})


# ---------- run ----------
def _run_job(job_id: str, name: str, prompts: list[str], model: str):
    j = jobs[job_id]

    def emit(line: str, kind: str = "log"):
        with jobs_lock:
            j["log"].append({"t": time.time(), "kind": kind, "line": line.rstrip()})
            j["seq"] += 1

    try:
        local = WORK / name
        candidates = sorted(local.glob("input.*"))
        if not candidates:
            raise RuntimeError(f"no input file in {local}")
        src = candidates[0]
        ext = src.suffix
        remote_in = f"~/franklin/inputs/{name}{ext}"
        remote_out = f"~/franklin/jobs/{name}"

        emit(f"[upload] {src.name} ({src.stat().st_size/1024:.1f} KiB) -> {LAMBDA_HOST}")
        subprocess.run(
            ["ssh", *SSH_OPTS, LAMBDA_HOST,
             f"mkdir -p ~/franklin/inputs ~/franklin/jobs/{name} && rm -f {remote_out}/*.wav 2>/dev/null || true"],
            check=True, capture_output=True, text=True, timeout=60)
        subprocess.run(["scp", *SSH_OPTS, str(src), f"{LAMBDA_HOST}:{remote_in}"],
                       check=True, capture_output=True, text=True, timeout=300)
        emit("[upload] done")

        prompts_str = ";".join(prompts)
        emit(f"[run] {len(prompts)} prompts on {model}")
        cmd = (
            f"export PATH=$HOME/.local/bin:$PATH; "
            f"export HF_TOKEN={HF_TOKEN}; "
            f"export PYTHONPATH=$HOME; "
            f"cd ~/sam-audio && source .venv/bin/activate && "
            f"AUDIO={remote_in} OUT={remote_out} PROMPTS='{prompts_str}' "
            f"DTYPE=bfloat16 SAM_MODEL={model} "
            f"python ~/run_inference.py"
        )
        proc = subprocess.Popen(
            ["ssh", *SSH_OPTS, LAMBDA_HOST, cmd],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        j["pid"] = proc.pid
        for line in proc.stdout:
            emit(line, kind="stdout")
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"inference exited {rc}")

        emit("[fetch] downloading outputs")
        subprocess.run(
            ["scp", *SSH_OPTS, "-r",
             f"{LAMBDA_HOST}:{remote_out}/.", str(local) + "/"],
            check=True, capture_output=True, text=True, timeout=600)
        n = len(list(local.glob("target__*.wav")))
        emit(f"[done] {n} prompts isolated, output in work/{name}/")
        with jobs_lock:
            j["state"] = "done"
    except subprocess.CalledProcessError as e:
        emit(f"[error] {' '.join(e.cmd[:3])}: {e.stderr or e.stdout or e}", kind="error")
        with jobs_lock:
            j["state"] = "error"
            j["error"] = str(e)
    except Exception as e:
        emit(f"[error] {e}", kind="error")
        with jobs_lock:
            j["state"] = "error"
            j["error"] = str(e)


@app.route("/api/run", methods=["POST"])
def run_job():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    prompts = body.get("prompts") or []
    model = body.get("model") or "facebook/sam-audio-small"
    if not name or not prompts:
        abort(400, "name and prompts required")
    if not (WORK / name).exists():
        abort(404, f"source {name} not found")

    job_id = uuid.uuid4().hex[:8]
    jobs[job_id] = {
        "id": job_id, "state": "running", "name": name, "model": model,
        "prompts": prompts, "log": [], "seq": 0, "error": None,
        "started": time.time(),
    }
    threading.Thread(target=_run_job, args=(job_id, name, prompts, model), daemon=True).start()
    return jsonify({"jobId": job_id})


@app.route("/api/sources/<name>", methods=["DELETE"])
def delete_source(name: str):
    name = _safe_name(name)
    local = WORK / name
    if not local.exists():
        abort(404, f"source {name} not found")
    shutil.rmtree(local)
    # best-effort remote cleanup
    try:
        subprocess.run(
            ["ssh", *SSH_OPTS, LAMBDA_HOST,
             f"rm -rf ~/franklin/inputs/{name}.* ~/franklin/jobs/{name}"],
            check=False, capture_output=True, text=True, timeout=30)
    except Exception:
        pass
    return jsonify({"deleted": name})


@app.route("/api/jobs/<jid>")
def job_status(jid: str):
    j = jobs.get(jid)
    if not j:
        abort(404)
    since = int(request.args.get("since", "0"))
    log = [e for e in j["log"] if e["t"] > since] if since else j["log"]
    return jsonify({**j, "log": log[-300:]})


@app.route("/api/jobs/<jid>/events")
def job_events(jid: str):
    if jid not in jobs:
        abort(404)

    @stream_with_context
    def gen():
        sent = 0
        while True:
            j = jobs.get(jid)
            if not j:
                break
            log = j["log"]
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            if j["state"] != "running":
                yield f"event: state\ndata: {json.dumps({'state': j['state']})}\n\n"
                break
            time.sleep(0.4)
    return Response(gen(), mimetype="text/event-stream")


@app.route("/api/devices")
def list_devices_api():
    from fusion.upstash import (DEVICES_KEY, EVENTS_KEY, Upstash,
                                k_audio, k_latest, k_meta, k_score, k_tele,
                                k_zone_devs)
    u = Upstash()
    devs = sorted(u.smembers(DEVICES_KEY))
    out = []
    for dev in devs:
        meta = u.get_json(k_meta(dev)) or {}
        score = u.get_json(k_score(dev)) or {}
        tele = u.get_json(k_latest(dev)) or {}
        out.append({
            "device": dev,
            "zone": meta.get("zone"),
            "profile": meta.get("profile"),
            "state": score.get("state", "OFFLINE"),
            "health": score.get("health"),
            "components": score.get("components"),
            "flags": score.get("flags", []),
            "transitions_24h": score.get("transitions_24h"),
            "latest_telemetry": tele or None,
            "latest_features": score.get("features"),
        })
    return jsonify(out)


@app.route("/api/devices/<dev>")
def device_detail(dev: str):
    from fusion.upstash import (Upstash, k_audio, k_latest, k_meta, k_score,
                                k_tele)
    u = Upstash()
    return jsonify({
        "device": dev,
        "meta": u.get_json(k_meta(dev)),
        "score": u.get_json(k_score(dev)),
        "latest_telemetry": u.get_json(k_latest(dev)),
        "telemetry_history": u.lrange_json(k_tele(dev), 0, 199),
        "audio_history": u.lrange_json(k_audio(dev), 0, 39),
    })


@app.route("/api/zones")
def list_zones_api():
    from fusion.upstash import (Upstash, k_zone_devs, k_zone_score)
    u = Upstash()
    out = {}
    # find zones via the Upstash key listing — Upstash REST exposes KEYS
    keys = u.cmd("KEYS", "zone:*:score") or []
    for k in keys:
        zone = k.split(":")[1]
        out[zone] = u.get_json(k)
    return jsonify(out)


@app.route("/api/events")
def list_events():
    from fusion.upstash import EVENTS_KEY, Upstash
    u = Upstash()
    return jsonify(u.lrange_json(EVENTS_KEY, 0, 99))


@app.route("/api/upstash/keys")
def upstash_keys():
    """List Upstash keys with type + size hint. Pages via SCAN."""
    from fusion.upstash import Upstash
    u = Upstash()
    match = request.args.get("match", "*")
    max_keys = min(int(request.args.get("max", "500")), 5000)
    keys: list[str] = []
    cursor = "0"
    while True:
        res = u.cmd("SCAN", cursor, "MATCH", match, "COUNT", "200") or [cursor, []]
        cursor = res[0] if isinstance(res, list) else "0"
        batch = res[1] if isinstance(res, list) and len(res) > 1 else []
        keys.extend(batch)
        if cursor == "0" or len(keys) >= max_keys:
            break
    keys = sorted(set(keys))[:max_keys]
    if not keys:
        return jsonify([])
    type_results = u.pipeline([["TYPE", k] for k in keys])
    size_cmds = []
    for k, t in zip(keys, type_results):
        if t == "list":
            size_cmds.append(["LLEN", k])
        elif t == "set":
            size_cmds.append(["SCARD", k])
        elif t == "hash":
            size_cmds.append(["HLEN", k])
        elif t == "string":
            size_cmds.append(["STRLEN", k])
        else:
            size_cmds.append(["TYPE", k])
    sizes = u.pipeline(size_cmds) if size_cmds else []
    out = [{"key": k, "type": t, "size": s} for k, t, s in zip(keys, type_results, sizes)]
    return jsonify(out)


@app.route("/api/upstash/inspect")
def upstash_inspect():
    """Return type + value for a single key. Lists/sets capped at limit items."""
    from fusion.upstash import Upstash
    u = Upstash()
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "missing key"}), 400
    limit = min(int(request.args.get("limit", "200")), 2000)
    t = u.cmd("TYPE", key)
    if t == "string":
        return jsonify({"key": key, "type": t, "value": u.cmd("GET", key)})
    if t == "list":
        n = u.cmd("LLEN", key) or 0
        items = u.cmd("LRANGE", key, "0", str(limit - 1)) or []
        return jsonify({"key": key, "type": t, "size": n, "items": items, "limit": limit})
    if t == "set":
        n = u.cmd("SCARD", key) or 0
        items = u.cmd("SMEMBERS", key) or []
        return jsonify({"key": key, "type": t, "size": n, "items": sorted(items)})
    if t == "hash":
        return jsonify({"key": key, "type": t, "value": u.cmd("HGETALL", key) or []})
    if t == "zset":
        items = u.cmd("ZRANGE", key, "0", str(limit - 1), "WITHSCORES") or []
        return jsonify({"key": key, "type": t, "items": items})
    return jsonify({"key": key, "type": t, "value": None})


def _kick_pi(dev: str) -> dict:
    """Fire-and-forget SSH to the Pi to send SIGUSR1 to the firmware so it
    immediately polls the Upstash command channel instead of waiting for the
    next sample tick. Returns a status dict; never raises."""
    host = PI_SSH_HOSTS.get(dev)
    if not host:
        return {"kicked": False, "reason": f"no PI_SSH host for {dev}"}
    try:
        proc = subprocess.run(
            [
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "ConnectTimeout=3",
                "-o", "BatchMode=yes",
                host,
                "sudo systemctl kill --signal=SIGUSR1 firmware.service "
                "|| sudo pkill -USR1 -f main.py",
            ],
            timeout=6, capture_output=True, text=True,
        )
        return {
            "kicked": proc.returncode == 0,
            "host": host,
            "rc": proc.returncode,
            "stderr": (proc.stderr or "").strip()[:200],
        }
    except Exception as e:
        return {"kicked": False, "host": host, "error": str(e)}


@app.route("/api/devices/<dev>/command", methods=["POST"])
def device_command(dev: str):
    """Queue a command for the Pi at cmd:<device>, then SSH the Pi to nudge
    it to poll immediately. The firmware GETDELs cmd:<dev> and acts on it."""
    from fusion.upstash import Upstash
    body = request.get_json(force=True) or {}
    cmd_type = (body.get("type") or "").strip()
    if not cmd_type:
        abort(400, "type required")
    payload = {"type": cmd_type, "ts": time.time(),
               **{k: v for k, v in body.items() if k != "type"}}
    u = Upstash()
    # 30s expiry: if the Pi is offline the command shouldn't sit forever.
    res = u.cmd("SET", f"cmd:{dev}", json.dumps(payload), "EX", "30")
    kick = _kick_pi(dev)
    return jsonify({"queued": payload, "result": res, "kick": kick})


@app.route("/api/health")
def health():
    return jsonify({
        "lambda_host": LAMBDA_HOST,
        "key_exists": Path(LAMBDA_KEY).exists(),
        "hf_token_set": bool(HF_TOKEN),
        "workspaces": [d.name for d in WORK.iterdir() if d.is_dir()],
    })


# ---------- live cluster info ----------
# Cached probe of the Lambda GPU box. SSH + nvidia-smi takes ~1-2s, so we
# memoize for CLUSTER_TTL seconds and let multiple page loads share it.
CLUSTER_TTL = 8.0
_cluster_cache: dict = {"t": 0.0, "data": None}
_cluster_lock = threading.Lock()


def _probe_cluster() -> dict:
    """SSH to the Lambda box and pull GPU stats. Returns a JSON-able dict."""
    out: dict = {
        "lambda_host": LAMBDA_HOST,
        "online": False,
        "gpus": [],
        "uptime": None,
        "loadavg": None,
        "error": None,
    }
    if not Path(LAMBDA_KEY).exists():
        out["error"] = f"key missing at {LAMBDA_KEY}"
        return out

    # nvidia-smi gives us one CSV row per GPU.
    nv_query = "name,utilization.gpu,memory.used,memory.total,temperature.gpu"
    remote = (
        f"nvidia-smi --query-gpu={nv_query} --format=csv,noheader,nounits"
        " 2>/dev/null; echo '---'; uptime"
    )
    try:
        r = subprocess.run(
            ["ssh", *SSH_OPTS, LAMBDA_HOST, remote],
            capture_output=True, text=True, timeout=6,
        )
    except subprocess.TimeoutExpired:
        out["error"] = "ssh timeout"
        return out
    except Exception as e:  # noqa: BLE001
        out["error"] = f"ssh error: {e}"
        return out

    if r.returncode != 0:
        out["error"] = (r.stderr or r.stdout or "ssh failed").strip().splitlines()[-1][:200]
        return out

    out["online"] = True
    text = r.stdout or ""
    parts = text.split("---", 1)
    gpu_block = parts[0].strip()
    tail = parts[1].strip() if len(parts) > 1 else ""

    for line in gpu_block.splitlines():
        cells = [c.strip() for c in line.split(",")]
        if len(cells) < 5 or not cells[0]:
            continue
        try:
            out["gpus"].append({
                "name": cells[0],
                "util_pct": int(float(cells[1])),
                "mem_used_mb": int(float(cells[2])),
                "mem_total_mb": int(float(cells[3])),
                "temp_c": int(float(cells[4])),
            })
        except ValueError:
            continue

    # parse `uptime` line: "  12:34:56 up  3 days,  2:15,  1 user,  load average: 0.10, 0.20, 0.30"
    if tail:
        m = re.search(r"up\s+(.+?),\s+\d+\s+user", tail)
        if m:
            out["uptime"] = m.group(1).strip()
        m = re.search(r"load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)", tail)
        if m:
            out["loadavg"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]

    return out


@app.route("/api/cluster")
def cluster():
    now = time.time()
    fresh = False
    with _cluster_lock:
        if _cluster_cache["data"] and now - _cluster_cache["t"] < CLUSTER_TTL:
            data = _cluster_cache["data"]
            fresh = True
    if not fresh:
        data = _probe_cluster()
        with _cluster_lock:
            _cluster_cache["t"] = now
            _cluster_cache["data"] = data

    with jobs_lock:
        running = sum(1 for j in jobs.values() if j.get("state") == "running")
        total = len(jobs)
    payload = dict(data)
    payload["jobs_running"] = running
    payload["jobs_total"] = total
    payload["cached"] = fresh
    payload["cache_age_s"] = round(now - _cluster_cache["t"], 1) if fresh else 0.0
    return jsonify(payload)


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or
               int(subprocess.check_output(
                   "echo $(echo /Users/akshayakula/Developer/kaido/franklin | cksum | "
                   "awk '{print 3000 + ($1 % 1000)}')",
                   shell=True, text=True).strip()))
    print(f"franklin server on http://localhost:{port}/viewer/")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
