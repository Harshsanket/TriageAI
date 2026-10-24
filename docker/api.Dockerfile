# API image: full workspace (kernel + modules + apps/api), run via tsx.
# Phase 1 keeps TS execution (no bundling) — revisit in Phase 2 (ADR-0009).
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json triage.config.json triage.config.support.json triage.config.support-autoreply.json triage.config.assistant.json triage.config.full.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/kernel/package.json packages/kernel/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY modules/echo/package.json modules/echo/package.json
COPY modules/chat/package.json modules/chat/package.json
COPY modules/support/package.json modules/support/package.json
COPY modules/ai-pipeline/package.json modules/ai-pipeline/package.json
COPY modules/kb/package.json modules/kb/package.json
COPY modules/doc-assistant/package.json modules/doc-assistant/package.json
COPY packages/rag/package.json packages/rag/package.json
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --frozen-lockfile --filter @triageai/api... && pnpm store prune

RUN apk add --no-cache dumb-init

COPY packages/ packages/
COPY modules/ modules/
COPY apps/api/ apps/api/

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@triageai/api", "start"]
