# Echo as a container module (Phase 22.T8). No host ports; reachable only on
# the internal `modules` network. The core supervisor calls MP1 stage.invoke.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/kernel/package.json packages/kernel/
COPY modules/echo/package.json modules/echo/
RUN pnpm install --frozen-lockfile --filter @triageai/module-echo...
COPY packages ./packages
COPY modules/echo ./modules/echo
WORKDIR /app/modules/echo
ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
