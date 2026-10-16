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
pnpm dev:keys      # generates COOKIE_KEYS and JWKS in .env (keeps existing values)
pnpm dev:up        # Postgres from compose.dev.yaml, waits until it is healthy
pnpm db:migrate    # create the tables
pnpm db:seed       # fictional dev data: an admin, four clients, ten users with claims
pnpm dev           # server on http://localhost:3300, loads .env
pnpm dev:example   # optional: example application on http://localhost:3400
```

The seed is safe to run again and refuses to run when `NODE_ENV=production`. All seeded users
have the password `dev-password`; the confidential client `demo-backend` uses the secret
`dev-secret`. After changing the schema in `packages/db/src/schema`, run `pnpm db:generate`
and commit the new migration.

Check it works: `curl http://localhost:3300/health` returns `{"status":"ok","databaseTime":"…"}`.
Stop the database with `pnpm dev:down`.

### Trying the admin API

The seed registers two machine clients for the admin API (secret `dev-secret`): `demo-admin` with
the `admin` scope and `demo-import` with the `directory` scope (users and claims only). With
`pnpm dev` running:

```sh
TOKEN=$(curl -s -u demo-admin:dev-secret -d grant_type=client_credentials -d scope=admin \
  http://localhost:3300/token | jq -r .access_token)

# create or update a user (safe to repeat; says "unchanged" when nothing differs)
curl -X PUT -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace"}' \
  http://localhost:3300/admin/users/by-email/ada@example.com

curl -H "authorization: Bearer $TOKEN" 'http://localhost:3300/admin/users?search=ada'
```

Every change is recorded in the audit log with the client that made it.

### Ports

- The development Postgres is published on port **5433**, so it does not clash with a Postgres
  you already run on the usual 5432. If 5433 is taken too, pick another host port and use the
  same one in `DATABASE_URL`. Set both in `.env`; Docker Compose reads `PFORTE_DB_PORT` from there:

  ```sh
  # in .env
  PFORTE_DB_PORT=5434
  DATABASE_URL=postgres://pforte:pforte@localhost:5434/pforte
  ```

- `PORT` is a different setting: the port of the pforte server itself (default 3300).

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
| `examples/relying-party` | Example application that signs in with pforte; see its README |

## Rules for the repository

- No customer names, real data or secrets. Fixtures and seed data are fictional.
- Configuration comes from environment variables. Do not add defaults for secrets.
- Every secret (`DATABASE_URL`, `COOKIE_KEYS`, `JWKS`) can also be read from a file with the
  `_FILE` suffix, e.g. `COOKIE_KEYS_FILE=/run/secrets/cookie_keys`, for mounted secrets. Setting
  both the variable and the `_FILE` variant is an error.

## Security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
