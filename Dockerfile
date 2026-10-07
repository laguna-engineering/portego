# syntax=docker/dockerfile:1

# The version CI tests with.
ARG BUN_VERSION=1.4.0

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# The server and migration bundles carry their dependencies, so the image needs
# dist/ and nothing else from the build.
FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/var/lib/portego \
    CLIENT_DIST=dist/client
COPY --from=build /src/dist ./dist
# With no node_modules, Bun would try to install an optional import the bundles
# leave unresolved (@opentelemetry/api, from better-auth) on every start.
RUN printf '[install]\nauto = "disable"\n' > bunfig.toml \
 && mkdir -p /var/lib/portego && chown bun:bun /var/lib/portego
USER bun
VOLUME /var/lib/portego
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "dist/server/index.js"]
