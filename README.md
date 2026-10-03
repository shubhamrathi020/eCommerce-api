# eCommerce API (backend)

NestJS API, PostgreSQL schema (Prisma), catalog store (MongoDB) and search (Meilisearch), Redis caching and rate limiting, RabbitMQ messaging, plus the Docker, Kubernetes, Terraform and monitoring files that run it.

This is one of three repositories, kept as sibling folders:

| Repository | What it holds |
|---|---|
| `eCommerce` | The frontend: storefront, admin console and seller portal (Angular), the business requirements (`brds/`), the project log and steering docs |
| `eCommerce-api` | **This repository**: the backend and its infrastructure |
| `eCommerce-contracts` | The shared contract: API types, error codes and the pure pricing/promotion/returns rules that the browser and the server must agree on |

The business requirements, project log and steering documents stay in the `eCommerce` repository (they cover both halves); read them there.

## Start

```bash
cd ../eCommerce-contracts && pnpm install && pnpm build    # once, and after contract changes
cd ../eCommerce-api
pnpm install
cp apps/api/.env.example apps/api/.env                        # dev-only values
docker compose up -d postgres redis rabbitmq mongo meilisearch
pnpm db:generate && pnpm db:migrate && pnpm db:seed && pnpm db:seed:catalog
pnpm start:api                                                # http://localhost:3333, docs at /docs
pnpm verify                                                   # lint, tests (need the data stores), build
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for everything else (containers, monitoring, backups, Kubernetes, troubleshooting) and [docs/CANARY-RELEASE.md](docs/CANARY-RELEASE.md), [docs/CAPACITY-PLAN.md](docs/CAPACITY-PLAN.md).

## Working with the contracts package

`package.json` depends on the contracts package by path:

```json
"@ecom/contracts": "link:../eCommerce-contracts"
```

That works on this machine only. Before CI or a container build can run anywhere else, publish `eCommerce-contracts` (for example to GitHub) and switch both this repository and the frontend to a tagged git dependency:

```bash
pnpm add -w github:<your-account>/eCommerce-contracts#v0.1.0
```

Then delete the `contracts` stage and the two `COPY --from=contracts` lines in `apps/api/Dockerfile` (they exist only to supply the sibling folder to a Docker build). Always depend on a tag, never a branch. A change to the contract is made in `eCommerce-contracts`, tagged, and then taken up here and in the frontend; a breaking change needs both sides updated before either is deployed.

## Data used for seeding

`apps/api/seed-data/*.json` is the catalog dataset (252 products, categories, brands, reviews). It was copied from the frontend's mock data when the repositories were split; the two copies are now independent (the frontend's `pnpm mock-data` does not update this one).
