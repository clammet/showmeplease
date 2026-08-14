# syntax=docker/dockerfile:1.7

FROM node:22.19-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22.19-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# The single container serves the static frontend and runs the small backend
# (session hub, Realtime SFU proxy, admin API). Media never touches it — the
# heavy lifting is done by the Cloudflare Realtime SFU.
COPY --from=build /app/dist/backend /app/dist/backend
COPY --from=build /app/dist/client /app/dist/client

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "dist/backend/index.mjs"]
