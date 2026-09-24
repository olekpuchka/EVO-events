# Build stage. Debian, not Alpine: node-tls-client's Go library can't be loaded on musl.
FROM node:24-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:24-slim
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

# System CA roots: the Go TLS library verifies against them, unlike Node, which bundles its own —
# slim ships none, and every faceit.com request then failed its handshake.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# node-tls-client's native library, pinned and pre-placed where it looks first — left to itself it
# downloads an unpinned release at runtime. Fetched with Node: the slim image has no wget or curl.
ARG TLS_CLIENT_VERSION=1.16.0
ARG TLS_CLIENT_SHA256=2ec853496634545e7a7ea028715763948d55bbdd97aca7ecaa9fea8c2ebb08df
RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/tls-client-x64.so', Buffer.from(b)))" \
      "https://github.com/bogdanfinn/tls-client/releases/download/v${TLS_CLIENT_VERSION}/tls-client-linux-ubuntu-amd64-${TLS_CLIENT_VERSION}.so" \
 && echo "${TLS_CLIENT_SHA256}  /tmp/tls-client-x64.so" | sha256sum -c - \
 && chmod 644 /tmp/tls-client-x64.so

# Non-root user, with the uid/gid the Alpine image gave it: files already on the /app/data volume
# belong to those ids, and a new pair would boot unable to write members.db. CI checks they match.
RUN groupadd --system --gid 101 botgroup && useradd --system --uid 100 --gid botgroup --no-create-home botuser

COPY --from=deps /app/node_modules ./node_modules
COPY bot.ts ./
COPY src/ ./src/
# Fonts and emoji the result card is drawn with — the slim image ships no fonts satori can use.
COPY assets/ ./assets/

# Create data dir and hand it to the non-root user before switching
RUN mkdir -p /app/data && chown -R botuser:botgroup /app/data

USER botuser

# Mount a persistent volume here on JustRunMy.App to survive restarts
VOLUME ["/app/data"]

# `kill -0` rather than pgrep: the slim image ships no procps. Node is PID 1 via the exec-form CMD.
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD kill -0 1 || exit 1

# Node 24 runs the TypeScript entrypoint directly via native type-stripping — no build step,
# and TypeScript stays a dev-only dependency (never installed in this image).
CMD ["node", "bot.ts"]
