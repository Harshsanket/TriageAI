# Web image: build static assets, serve via nginx which proxies /api and
# /system-less paths to the API (compose: api:3000).
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile --filter @triageai/web... && pnpm store prune

COPY packages/ packages/
COPY apps/web/ apps/web/

RUN pnpm --filter @triageai/web build && pnpm store prune

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
