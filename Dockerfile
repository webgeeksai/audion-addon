FROM node:22-alpine

WORKDIR /app

# better-sqlite3 needs build tools at install time
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --production --legacy-peer-deps

COPY src ./src

ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_DB=/data/cache.db

VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8787/healthz || exit 1

CMD ["node", "src/index.js"]
