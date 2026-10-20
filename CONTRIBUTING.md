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
pnpm dev:up        # Postgres and Mailpit from compose.dev.yaml, waits until they are healthy
pnpm db:migrate    # create the tables
pnpm db:seed       # fictional dev data: an admin, four clients, ten users with claims
pnpm dev           # server on http://localhost:3300, loads .env
pnpm dev:example   # optional: example application on http://localhost:3400
```

The seed is safe to run again and refuses to run when `NODE_ENV=production`. All seeded users
have the password `dev-password`; the confidential client `demo-backend` uses the secret
`dev-secret`. Signing in asks for a second factor: the 6-digit code arrives as an e-mail, which you
read in Mailpit at <http://localhost:8026> (without `SMTP_URL` the code is written to the server
log instead). After changing the schema in `packages/db/src/schema`, run `pnpm db:generate`
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

Add `?dryRun=true` to the upsert to see what it would do (`created`, `updated` or `unchanged`, and
what would change) without writing anything or recording an audit event.

Users can ask pforte to remember a device after entering the code (90 days). `GET
/admin/users/{id}/devices` lists them and `DELETE /admin/users/{id}/devices[/{deviceId}]` revokes one or
all, so the next sign-in asks for a code again. Locking, deactivating, resetting the password and ending
sessions revoke them too.

A user created through the API starts as `created`. `POST /admin/users/{id}/activate` e-mails the link
to `/activate`, where they choose their first password (at least 10 characters). `POST
/admin/users/{id}/reset-password` e-mails a code for `/reset/code`; users can also ask for one themselves
at `/reset`, linked from the login page. In development both mails land in Mailpit.

Codes can also go by SMS; see [docs/sms.md](docs/sms.md). To try it without a provider, set `SMS_PROVIDER=http`
and any `SMS_URL`/`SMS_BODY`: without `SMTP_URL` the development notifier then writes the SMS codes to the log.

Every change is recorded in the audit log with the client that made it.

The API describes itself: `GET /admin/openapi.json` (with a token) returns an OpenAPI 3.1 document
generated from the route schemas. `GET /admin/audit-events` lists the audit log (admin scope), newest
first, with filters for actor, action (`user.*` matches a prefix), target and time.

Clients are managed under `/admin/clients` (admin scope): register an application or a machine,
change it, rotate its secret, delete it. The secret is returned once, when the client is created
or rotated. An application signs users in and has OpenID scopes and https redirect URIs; a machine
uses the `client_credentials` grant with only the scopes `admin` and/or `directory`.

Users have a lifecycle: `POST /admin/users/{id}/lock`, `unlock`, `activate`, `deactivate`,
`reset-password` and `end-sessions`. Locking, deactivating, deleting and resetting the password
end the user's sessions and refresh tokens. Activation links and reset requests go through a
notifier; until e-mail and SMS exist, the development notifier writes them to the server log
(and refuses to run with `NODE_ENV=production`, so secrets never reach production logs).

The administration UI is at <http://localhost:3300/manage>: sign in as `admin@example.com` (`dev-password`) and enter the code
from Mailpit. See [docs/administration.md](docs/administration.md).

### Importing users

`pnpm pforte import users.csv --dry-run` imports a CSV file through the admin API; see [docs/import.md](docs/import.md).

### Building the image

`docker build -t pforte:dev .` builds the image: our own code is bundled into one file (`apps/server/build.mjs`) and the
third-party packages are installed from the lockfile. Try it against the database of `pnpm dev:up`:

```bash
docker run --rm pforte:dev keys > /tmp/pforte-keys.env     # COOKIE_KEYS and JWKS
docker run --rm -p 3300:3300 --env-file /tmp/pforte-keys.env \
  -e DATABASE_URL=postgres://user:a-long-password@host.docker.internal:5433/pforte \
  -e ISSUER=https://id.example.com -e SMTP_URL=smtp://host.docker.internal:1026 -e MAIL_FROM=no-reply@example.com \
  pforte:dev
```

The image runs in production mode, so it needs the settings production needs (https `ISSUER`, keys, mail, no default database
password). It applies pending database migrations at start (`MIGRATE_ON_START=false` skips that); `pforte:dev migrate` only
migrates. `pforte:dev --help` lists the commands.

### Ports

- Mailpit, which catches the e-mails pforte sends, listens for SMTP on **1026** and shows the mails on
  **http://localhost:8026** (`PFORTE_SMTP_PORT` and `PFORTE_MAIL_UI_PORT` change them; 1025 and 8025
  are left free because Mailpit's own defaults are often taken). `SMTP_URL` in `.env` points to it.
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
