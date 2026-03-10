FROM node:20-alpine AS base

WORKDIR /app

COPY package.json ./
RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile=false
RUN pnpm prisma:generate
RUN pnpm build

CMD ["pnpm", "sync:daily"]
