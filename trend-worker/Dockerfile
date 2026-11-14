FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS socai
ARG SOCAI_COMMIT=340b9d7b65533a535bafded02659f76fb8b75cb3
WORKDIR /build
RUN curl --fail --silent --show-error --location https://codeload.github.com/socai-io/socai/tar.gz/${SOCAI_COMMIT} -o /tmp/socai.tar.gz && echo '09cdc9d671a8841d778f2a7e616d0fb8d591c34649cfbc659e9dc2decf60fe74  /tmp/socai.tar.gz' | sha256sum -c - && tar xzf /tmp/socai.tar.gz --strip-components=1 && rm /tmp/socai.tar.gz
COPY trend-worker/socai-runtime.patch /tmp/socai-runtime.patch
RUN patch -p1 < /tmp/socai-runtime.patch
RUN cargo build --release --locked -p socai-cli -j 4

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates tini libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/trend-worker
COPY trend-worker/package.json trend-worker/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=socai /build/target/release/socai /usr/local/bin/socai
COPY --from=socai /build/LICENSE /usr/share/doc/socai/LICENSE
COPY trend-worker/src ./src
COPY api/src/trends /app/api/src/trends
COPY api/src/openai-response.ts /app/api/src/openai-response.ts
COPY api/package.json /app/api/package.json
COPY api/migrations/030_trend_research.sql /app/api/migrations/030_trend_research.sql
RUN ln -s /app/trend-worker/node_modules /app/api/node_modules && chown -R node:node /app
USER node
RUN node --import tsx --test src/adapter.test.ts
ENV NODE_ENV=production PORT=8080 SOCAI_BIN=/usr/local/bin/socai CHROMIUM_BIN=/usr/bin/chromium
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
