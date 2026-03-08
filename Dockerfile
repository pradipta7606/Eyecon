FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production stage ────────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/src/lib ./src/lib
COPY --from=builder /app/tsconfig.json ./

RUN mkdir -p uploads streams thumbnails

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--"]
CMD ["npx", "tsx", "server.ts"]
