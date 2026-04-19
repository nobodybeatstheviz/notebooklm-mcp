# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

# Copy package files and install production deps only.
# --ignore-scripts skips Puppeteer's Chrome download (not needed in cloud).
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js", "--http"]
