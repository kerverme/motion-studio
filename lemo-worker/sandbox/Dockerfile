# syntax=docker/dockerfile:1
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /renderer
COPY --chmod=644 sandbox/package*.json ./
RUN --mount=type=secret,id=build_ca,target=/tmp/build-ca NODE_EXTRA_CA_CERTS=/tmp/build-ca npm ci --omit=dev
COPY --chmod=644 vendor/lemo/core/lib.js ./lib.js
COPY --chmod=644 sandbox/render.mjs ./render.mjs
USER 65534:65534
ENV HOME=/tmp
ENTRYPOINT ["node","/renderer/render.mjs"]
