# Build stage
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

COPY --from=deps /app/node_modules ./node_modules
COPY bot.js ./
COPY src/ ./src/

# Create data dir and hand it to the non-root user before switching
RUN mkdir -p /app/data && chown -R botuser:botgroup /app/data

USER botuser

# Mount a persistent volume here on JustRunMy.App to survive restarts
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD pgrep -x node || exit 1

CMD ["node", "bot.js"]
