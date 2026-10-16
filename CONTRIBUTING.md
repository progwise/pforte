# Contributing to pforte

Thanks for your interest. pforte is in early development, so the best way to help right now is
to pick up an open issue or comment on the design in one. Please open an issue before starting
larger changes.

## Sign your commits (DCO)

Every commit needs a Developer Certificate of Origin sign-off. Add it with `git commit -s`,
which appends a `Signed-off-by: Your Name <you@example.com>` line. Pull requests with unsigned
commits fail the DCO check. There is no contributor agreement.

## Set up

You need:

- Node.js 22.23.3 (see `.nvmrc`; `nvm use` picks it up)
- pnpm 12.11.2 (see `packageManager` in `package.json`)
- Docker, for the local Postgres

Then:

```sh
cp .env.example .env
pnpm install
pnpm dev:up        # Postgres from compose.dev.yaml, waits until it is healthy
pnpm db:migrate    # create the tables
pnpm db:seed       # fictional dev data: an admin, two clients, ten users with claims
pnpm dev           # server on http://localhost:3300, loads .env
```

The seed is safe to run again and refuses to run when `NODE_ENV=production`. All seeded users
have the password `dev-password`; the confidential client `demo-backend` uses the secret
`dev-secret`. After changing the schema in `packages/db/src/schema`, run `pnpm db:generate`
and commit the new migration.

Check it works: `curl http://localhost:3300/health` returns `{"status":"ok","databaseTime":"…"}`.
Stop the database with `pnpm dev:down`.

### Port 5432 is already in use

The compose file publishes Postgres on port 5432. If another Postgres already uses it, pick
another host port and use the same one in `DATABASE_URL`:

```sh
PFORTE_DB_PORT=5433 pnpm dev:up
# in .env: DATABASE_URL=postgres://pforte:pforte@localhost:5433/pforte
```

`compose.dev.yaml` is for local development only. Its credentials are public; never use them
anywhere else.

## Before you push

CI runs the same commands:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Layout

| Path | Contents |
| --- | --- |
| `apps/server` | Fastify application: OpenID Connect provider, admin API and pages |
| `packages/db` | Drizzle ORM schema, migrations and the database connection |
| `examples/` | Example client applications (planned) |

## Rules for the repository

- No customer names, real data or secrets. Fixtures and seed data are fictional.
- Configuration comes from environment variables. Do not add defaults for secrets.

## Security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
