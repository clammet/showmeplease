# syntax=docker/dockerfile:1.26@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# Identifies the running build on the admin dashboard, so it is fixed at build
# time rather than container startup. CI passes the commit it builds from;
# a plain `docker build` leaves it empty and the dashboard says so.
ARG GIT_COMMIT=
RUN printf 'export const GIT_COMMIT = "%s";\n' "${GIT_COMMIT}" > lib/buildInfo.ts
RUN pnpm build

FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS runtime

ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_ROOT=/srv/www

WORKDIR /app

# The backend can serve the frontend for standalone deployments. The frontend
# also has a stable export path so an external primary nginx can copy it out of
# this same image and serve it directly while proxying only /api to Node.
# Media never touches this container — Cloudflare Realtime does that work.
COPY --from=build /app/dist/backend /app/dist/backend
COPY --from=build /app/dist/client /srv/www
RUN test -f /srv/www/index.html && test -f /srv/www/404.html

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "dist/backend/index.mjs"]
