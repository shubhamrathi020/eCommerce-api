# API (NestJS). Build from the repository root. The shared contract package lives in a sibling repository
# (eCommerce-contracts) and is passed in as a named build context:
#   docker build -f apps/api/Dockerfile --build-context contracts_src=../eCommerce-contracts -t shop-api .
#   docker build -f apps/api/Dockerfile --build-context contracts_src=../eCommerce-contracts --target migrate -t shop-api-migrate .
# `docker compose build` passes it for you (see docker-compose.yml).
#
# Once @ecom/contracts is a git or registry dependency in package.json instead of `link:../eCommerce-contracts`,
# delete the `contracts` stage and the two COPY --from=contracts lines in the build and runtime stages.

# ---- contracts stage: build the shared package once ----
FROM node:22-alpine AS contracts
WORKDIR /eCommerce-contracts
RUN corepack enable
COPY --from=contracts_src package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY --from=contracts_src tsconfig.json ./
COPY --from=contracts_src scripts ./scripts
COPY --from=contracts_src src ./src
RUN pnpm build

# ---- build stage: locked install, Prisma client generation, production bundle ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# `link:../eCommerce-contracts` in package.json resolves to /eCommerce-contracts from /app.
COPY --from=contracts /eCommerce-contracts/package.json /eCommerce-contracts/package.json
COPY --from=contracts /eCommerce-contracts/dist /eCommerce-contracts/dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm exec nx build api

# ---- migrate stage: applies migrations (safe to run repeatedly; Prisma takes a lock) and seeds demo accounts ----
# Kept out of the runtime image so the server image carries no schema tooling.
FROM build AS migrate
CMD ["sh", "-c", "pnpm db:migrate:deploy && pnpm db:seed"]

# ---- runtime stage: only the bundle and its production dependencies ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3333
WORKDIR /app
RUN corepack enable
COPY --from=contracts /eCommerce-contracts/package.json /eCommerce-contracts/package.json
COPY --from=contracts /eCommerce-contracts/dist /eCommerce-contracts/dist
# This repository now holds only the backend, so its own manifest and lockfile are exactly the runtime dependencies
# (Nx's generated, pruned lockfile cannot be used while @ecom/contracts is a `link:` dependency).
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build --chown=node:node /app/dist/apps/api/main.js /app/dist/apps/api/main.js.map ./
USER node
EXPOSE 3333
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3333/healthz || exit 1
CMD ["node", "main.js"]
