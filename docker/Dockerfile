# syntax=docker/dockerfile:1
# Grok Context Manager — remote MCP server image.
# Build from the repository root:  docker build -f docker/Dockerfile -t grok-context-manager:0.1.0 .

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && mkdir -p /out \
 && cd apps/cli && pnpm pack --pack-destination /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    GCM_HOME=/data
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin gcm \
 && mkdir -p /data && chown gcm:gcm /data
COPY --from=build /out/ /tmp/pkg/
RUN npm install -g --no-audit --no-fund /tmp/pkg/*.tgz && rm -rf /tmp/pkg /root/.npm
USER gcm
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["gcm"]
# TLS is terminated by the Caddy service in docker-compose.yml.
CMD ["mcp", "serve", "--http", "--host", "0.0.0.0", "--port", "8787", "--behind-tls-proxy"]
