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

SSH_OPTS = [
    "-i", LAMBDA_KEY,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15",
]

app = Flask(__name__)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


# ---------- static ----------
@app.route("/")
def index():
    return redirect("/viewer/")


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


@app.route("/api/health")
def health():
    return jsonify({
        "lambda_host": LAMBDA_HOST,
        "key_exists": Path(LAMBDA_KEY).exists(),
        "hf_token_set": bool(HF_TOKEN),
        "workspaces": [d.name for d in WORK.iterdir() if d.is_dir()],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or
               int(subprocess.check_output(
                   "echo $(echo /Users/akshayakula/Developer/kaido/franklin | cksum | "
                   "awk '{print 3000 + ($1 % 1000)}')",
                   shell=True, text=True).strip()))
    print(f"franklin server on http://localhost:{port}/viewer/")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
