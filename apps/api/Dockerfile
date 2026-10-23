# syntax=docker/dockerfile:1
#
# The API as a container. Build from the repository root (the API bundles
# packages/shared):
#   docker build -f apps/api/Dockerfile -t auditions-api .
# Configuration comes from the environment (see apps/api/.env.example);
# APP_ENV defaults to production.

FROM node:25-slim AS build
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

FROM node:25-slim
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
# The geocode and boundary caches are written next to dist/ (disposable:
# rebuilt on demand after each deploy).
RUN chown node:node /repo/apps/api
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/index.js"]
