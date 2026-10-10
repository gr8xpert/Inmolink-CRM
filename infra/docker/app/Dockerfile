# One image per deployable app (S0-14): docker build -f infra/docker/app/Dockerfile --build-arg APP=api .
# APP = api | feed-api | realtime | worker | web | public. Built from the repo root.
#
# prune:   `turbo prune` keeps only the app's workspace closure (+ a pruned lockfile)
# build:   install from the lockfile (cached layer), build the app and its packages
# runtime: production dependencies only, root-owned files, non-root user, telemetry preload for Node apps
ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

FROM ${NODE_IMAGE} AS base
# CI=true: pnpm may purge node_modules without a TTY (the --prod reinstall below).
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH npm_config_store_dir=/pnpm/store HUSKY=0 TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.7 prune "@inmolink/app-${APP}" --docker

FROM base AS build
ARG APP
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ ./
# The prod reinstall skips lifecycle scripts: the root `prepare` (husky) is a dev tool, and native
# modules in the closure ship prebuilt binaries that the first install already placed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm turbo run build --filter="@inmolink/app-${APP}..." \
  && pnpm install --frozen-lockfile --prod --offline --ignore-scripts \
  && rm -rf apps/*/.next/cache tests scripts \
  && find apps packages -path '*/node_modules' -prune -o \( -name '__tests__' -o -name '*.test.ts' -o -name '*.test.tsx' \) -print0 \
     | xargs -0 rm -rf

FROM ${NODE_IMAGE} AS runtime
ARG APP
ENV NODE_ENV=production APP=${APP} NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
# Root-owned and read-only for the app user; only the Next.js cache directory is writable.
COPY --from=build /repo ./
RUN if [ -d "apps/${APP}/.next" ]; then mkdir -p "apps/${APP}/.next/cache" && chown node:node "apps/${APP}/.next/cache"; fi
USER node
WORKDIR /repo/apps/${APP}
# Node apps: node --import <telemetry preload> dist/main.js; Next apps: next start. Ports come from env.
CMD ["sh", "-c", "if [ -f dist/main.js ]; then exec node --import @inmolink/platform/telemetry/register dist/main.js; else exec node_modules/.bin/next start; fi"]
