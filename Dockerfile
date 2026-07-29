# Build stage
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Non-secret config; runtime env (JustRunMy.App → Settings) overrides any of it.
# KEEP IN SYNC: an ENV here beats the fallback in src/, so changing a code default alone
# never reaches the container.
ENV DATA_DIR=/app/data
ENV LANGUAGE=UA
ENV FACEIT_POLL_MINUTES=20
# Empty means everyone is on Kyiv time.
ENV EU_TIMEZONE_MEMBERS=""

# Secrets stay out of the image — ENV is readable via `docker history`. Supply at runtime:
# BOT_TOKEN and FACEIT_API_KEY (required), DEEPSEEK_API_KEY (optional).

# Non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

COPY --from=deps /app/node_modules ./node_modules
COPY bot.ts ./
COPY src/ ./src/

# Create data dir and hand it to the non-root user before switching
RUN mkdir -p /app/data && chown -R botuser:botgroup /app/data

USER botuser

# Mount a persistent volume here on JustRunMy.App to survive restarts
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD pgrep -x node || exit 1

# Node 24 runs the TypeScript entrypoint directly via native type-stripping — no build step,
# and TypeScript stays a dev-only dependency (never installed in this image).
CMD ["node", "bot.ts"]
