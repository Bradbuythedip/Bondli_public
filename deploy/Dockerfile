# BONDLI v3.0 Production Dockerfile
FROM node:20-alpine AS base
RUN apk add --no-cache dumb-init
WORKDIR /app

# Dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App code
COPY src/ ./src/
COPY app/dist/ ./app/dist/

# Non-root user
RUN addgroup -S bondli && adduser -S bondli -G bondli
RUN chown -R bondli:bondli /app
USER bondli

ENV NODE_ENV=production
ENV API_PORT=3001
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/api/server.production.mjs"]
