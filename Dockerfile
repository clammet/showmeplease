# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

# renovate: datasource=npm depName=corepack
ARG COREPACK_VERSION=0.36.0
RUN npm install --global corepack@${COREPACK_VERSION} && corepack enable

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

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime

# Runtime executes the bundled backend directly; package managers are unused.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
