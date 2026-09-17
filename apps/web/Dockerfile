# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace=apps/web

FROM node:24-slim AS runtime
ARG OKF_VERSION=0.3.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl poppler-utils \
  && curl -fsSL -o /tmp/okf "https://github.com/okf-memory/okf-agent-memory/releases/download/v${OKF_VERSION}/okf-linux-${TARGETARCH}" \
  && curl -fsSL -o /tmp/checksums.txt "https://github.com/okf-memory/okf-agent-memory/releases/download/v${OKF_VERSION}/checksums.txt" \
  && cd /tmp && grep -E ' +bin/okf-linux-'"${TARGETARCH}"'$' checksums.txt | sed -E 's# +bin/okf-linux-'"${TARGETARCH}"'$#  okf#' > okf.sha256 && test -s okf.sha256 && sha256sum -c okf.sha256 \
  && install -m 0755 /tmp/okf /usr/local/bin/okf \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /tmp/okf /tmp/checksums.txt /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web ./apps/web
ENV NODE_ENV=production PORT=8080 KNOWLEDGE_ROOT=/mnt/knowledge
RUN mkdir -p /mnt/knowledge
WORKDIR /repo/apps/web
EXPOSE 8080
# tsx directly, not `npm run start`: npm would be PID 1 and does not forward
# SIGTERM to the child it spawned, so ECS's stop signal would never reach the
# server's own shutdown handler and every stop would end in SIGKILL. The path
# is relative to this WORKDIR (/repo/apps/web) and resolves into the hoisted
# workspace root's /repo/node_modules/.bin.
CMD ["../../node_modules/.bin/tsx", "src/server/node.ts"]
