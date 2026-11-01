# Chat as a container module (Phase 22.T13). Internal network only.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/kernel/package.json packages/kernel/
COPY modules/chat/package.json modules/chat/
RUN pnpm install --frozen-lockfile --filter @triageai/module-chat...
COPY packages ./packages
COPY modules/chat ./modules/chat
WORKDIR /app/modules/chat
ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
