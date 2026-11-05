FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY drafts-inbox ./drafts-inbox
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
