FROM node:22-alpine AS base

WORKDIR /app

RUN corepack enable pnpm

COPY . .

RUN pnpm install --frozen-lockfile --prod

CMD ["node", "/app/src/index.js"] 
