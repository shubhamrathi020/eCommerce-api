# eCommerce API: Claude Instructions

Backend half of a solo eCommerce project (NestJS, PostgreSQL/Prisma, MongoDB, Redis, RabbitMQ, Meilisearch, Docker, Kubernetes). The frontend is the sibling repository `../eCommerce`; the shared contract (types and pure pricing/promotion/returns rules) is `../eCommerce-contracts`. See README.md.

## Before every task
1. Read the module BRD in `../eCommerce/brds/` (the backend BRDs are 19 to 25) and `../eCommerce/steering/rules.md`, `memory.md`, `architecture.md`, `security.md`. The requirements and project log live in the frontend repository because they cover both halves.
2. If the task conflicts with a steering doc or BRD, stop and ask.

## Rules specific to this repository
- A shape or rule that both sides use belongs in `../eCommerce-contracts`, not here. Change it there first, tag it, then update both consumers.
- Never push; the owner pushes. Commit messages end with the attribution line given by the session.
- Run `pnpm verify` before committing; the API tests need Postgres, Redis, RabbitMQ, MongoDB and Meilisearch (`docker compose up -d ...`).

## After every task
- Add a line to `../eCommerce/PROJECT-LOG.md` (plain-English decisions, commands, problems solved) and, if behaviour changed, the BRD.
