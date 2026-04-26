FROM python:3.12-slim

# OS deps:
#   - openssh-client + ssh: needed for `subprocess.run(["ssh", ...])` calls in app.py
#   - ca-certificates: outbound HTTPS to HF + Lambda APIs
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for cache reuse
COPY franklin/server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy the Flask server + the static viewer assets it serves.
# ROOT in app.py = parent of this file, so we match that layout: /app/franklin/{server,viewer,work}
COPY franklin/server/ /app/franklin/server/
COPY franklin/viewer/ /app/franklin/viewer/

# Persistent volume mount lives here (Fly volume `franklin_work`).
RUN mkdir -p /app/franklin/work

# SSH config: known_hosts + key materialization happen at runtime via entrypoint.
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

COPY franklin/server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3782
ENV PORT=3782 \
    PYTHONUNBUFFERED=1 \
    FRANKLIN_DATA_DIR=/app/franklin/work

ENTRYPOINT ["/entrypoint.sh"]
# Single sync worker — SAM-Audio jobs run in a background thread inside the
# process and we want SSE clients to land on the same worker that owns the job.
CMD ["gunicorn", "-w", "1", "-k", "gthread", "--threads", "8", "--timeout", "0", "-b", "0.0.0.0:3782", "--chdir", "/app/franklin/server", "app:app"]
