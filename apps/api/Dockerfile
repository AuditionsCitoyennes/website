# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
#
# The API as a container. Build from the repository root (the API bundles
# packages/shared):
#   docker build -f apps/api/Dockerfile -t auditions-api .
# Configuration comes from the environment (see apps/api/.env.example);
# APP_ENV defaults to production.
#
# The Dockerfile frontend above and the base image below are named by digest:
# a build takes the same bytes until this file changes. Dependabot proposes
# the base image's new digest (.github/dependabot.yml); both stages name the
# same one.

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
WORKDIR /repo
# Manifests first, so the dependency layer is reused while only code changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace=@ac/api --ignore-scripts --no-audit --no-fund
COPY apps/api apps/api
COPY packages/shared packages/shared
RUN npm run build --workspace=@ac/api

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace=@ac/api --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
# The commit this image is built from (docker build --build-arg
# APP_VERSION=<sha>), shown by /health: last, so that it changes no layer above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
WORKDIR /repo/apps/api
# The geocode cache is written next to dist/ (disposable: rebuilt on demand
# after each deploy).
RUN chown node:node /repo/apps/api
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
# V8's heap gets 256 MB of the container's 512 MB: the rest is for the cached
# responses' bytes, Buffers that live outside the heap (lib/cache.ts).
CMD ["node", "--enable-source-maps", "--max-old-space-size=256", "dist/index.js"]
