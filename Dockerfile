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
# KEEP IN SYNC: an ENV here beats the fallback in src/config.ts, so changing a code default
# alone never reaches the container.
ENV DATA_DIR=/app/data
ENV FACEIT_POLL_MINUTES=20
# Empty means everyone is on Kyiv time.
ENV EU_TIMEZONE_MEMBERS=""

# Secrets stay out of the image — ENV is readable via `docker history`. Supply at runtime:
# BOT_TOKEN and FACEIT_API_KEY (required), DEEPSEEK_API_KEY (optional).

# node-tls-client's native library, pre-placed where it looks first. Left to itself it downloads
# the glibc build (unloadable on musl) from an unpinned release at boot. See CLAUDE.md.
ARG TLS_CLIENT_VERSION=1.16.0
ARG TLS_CLIENT_SHA256=83c8702e8e8af2e5629277f422e77384a8780ac63c7f20988269a82d78e835ae
RUN wget -qO /tmp/tls-client-x64.so \
      "https://github.com/bogdanfinn/tls-client/releases/download/v${TLS_CLIENT_VERSION}/tls-client-linux-alpine-amd64-${TLS_CLIENT_VERSION}.so" \
 && echo "${TLS_CLIENT_SHA256}  /tmp/tls-client-x64.so" | sha256sum -c - \
 && chmod 644 /tmp/tls-client-x64.so

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
