# Self-hosted Agentation server (HTTP API + /mcp endpoint).
# Built from this repo's source: the npm release may lag behind.
#
#   docker build -t agentation-server mcp/
#   docker run -p 127.0.0.1:4747:4747 -v agentation-data:/data --env-file deploy/.env agentation-server

FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for better-sqlite3 when no prebuilt binary matches the platform
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml ./
# pnpm 10 skips dependency build scripts unless allowed; better-sqlite3 needs its native build
RUN printf 'onlyBuiltDependencies:\n  - better-sqlite3\n' > pnpm-workspace.yaml \
  && pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    AGENTATION_DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# --http-only: no stdio MCP client inside the container
CMD ["node", "dist/cli.js", "server", "--http-only", "--port", "4747"]
