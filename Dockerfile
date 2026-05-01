FROM node:22-bookworm-slim

WORKDIR /app

# Debian glibc base: better-sqlite3 ships prebuilt binaries for this ABI,
# so no source compile needed. Tiny image still — slim is ~80MB.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
    || npm install --production --legacy-peer-deps --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_DB=/data/cache.db

VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8787/healthz || exit 1

CMD ["node", "src/index.js"]
