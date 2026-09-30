# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/test ./test
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=3543 \
    NODE_ENV=production \
    PUBLIC_DIR=/app/public \
    DATABASE_PATH=/var/lib/dragonchess/dragonchess.sqlite
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/migrations ./dist/migrations
COPY index.html /app/public/index.html
RUN groupadd --system app && useradd --system --no-create-home --gid app app \
 && mkdir -p /var/lib/dragonchess \
 && chown -R app:app /app /var/lib/dragonchess
USER app
EXPOSE 3543
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3543/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]