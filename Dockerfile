# Build stage
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Runtime stage
FROM node:20-alpine
WORKDIR /app

# Non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

COPY --from=deps /app/node_modules ./node_modules
COPY bot.js ./

USER botuser

CMD ["node", "bot.js"]
