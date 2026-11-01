# Slack as a container module (Phase 22.T9). Internal network only; the core
# supervisor calls MP1 stage.invoke. The DB connection is the module's role.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/kernel/package.json packages/kernel/
COPY packages/integrations-core/package.json packages/integrations-core/
COPY modules/integrations-slack/package.json modules/integrations-slack/
RUN pnpm install --frozen-lockfile --filter @triageai/module-integrations-slack...
COPY packages ./packages
COPY modules/integrations-slack ./modules/integrations-slack
WORKDIR /app/modules/integrations-slack
ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
