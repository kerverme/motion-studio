# syntax=docker/dockerfile:1
# Build context is repository root; this coordinator never runs generated code.
FROM python:3.12-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core libcairo2 libraqm0 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY worker/requirements.txt /app/requirements.txt
# Railway validates secret mounts before building; this service needs no build secrets.
RUN pip install --no-cache-dir -r requirements.txt
COPY worker /app/classic
COPY lemo-worker /app/lemo
RUN chmod -R a+rX /app
ENV PYTHONPATH=/app/classic:/app/lemo MOTION_WORKDIR=/tmp/lemo PYTHAINLP_DATA_DIR=/tmp/lemo-thai LEMO_VENDOR_DIR=/app/lemo/vendor/lemo LEMO_ENABLED=false PORT=8080
USER 65534:65534
CMD ["python","-m","lemo_worker.main"]
