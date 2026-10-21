# Quick start

There are two ways to start: try pforte on your own machine with seeded demo data, or run it on a server.

## Try it on your machine

You need Node.js 22, pnpm and Docker.

```sh
git clone https://github.com/progwise/pforte.git
cd pforte
cp .env.example .env
pnpm install
pnpm dev:keys            # makes COOKIE_KEYS and JWKS for development
pnpm dev:up              # Postgres and Mailpit (a mailbox that catches everything pforte sends)
pnpm db:migrate && pnpm db:seed
pnpm dev                 # pforte on http://localhost:3300
```

The seed makes demo users with the password `dev-password`, demo clients, claim types and an administrator. In a second terminal
start the example application:

```sh
pnpm dev:example         # an example application on http://localhost:3400
```

Open <http://localhost:3400>, choose **Sign in**, and use `anna.schmidt@example.com` with `dev-password`. pforte then asks for a
6-digit code: it was sent by e-mail, and you find it in Mailpit at <http://localhost:8026>. Back in the example application you see
the claims pforte put in the ID token.

To look at the administration, open <http://localhost:3300/manage> and sign in as `admin@example.com` with `dev-password`, and the
code from Mailpit. There you find the users, the clients, the claim types, the audit log and the CSV import
([the administration](administration.md)).

The demo users and clients have passwords and secrets everybody knows. They are for development only: a production start refuses
to run while they exist.

## Run it on a server

[Production with Docker Compose](../examples/production/README.md) runs pforte, Postgres and Caddy, which gets and renews the TLS
certificate, with secrets as files and an unprivileged pforte on a read-only filesystem. You need a machine with Docker, a host
name that points to it, ports 80 and 443, and a mail server. In short:

```sh
cd examples/production
./setup.sh               # makes the secrets, asks for the address of your mail server
$EDITOR .env             # the host name, the sender address, the name of your organisation
docker compose up -d
```

The image is `ghcr.io/progwise/pforte`. Pin a version in `.env` (`PFORTE_IMAGE=ghcr.io/progwise/pforte:0.1.0`); the changes of each
version are in the [changelog](../CHANGELOG.md). Every setting is described in the [configuration reference](configuration.md).

## What next

- Put people into pforte: create them in the administration, or [import them from a CSV file](import.md). A system of record can
  keep them current through the admin API.
- Look at the [example application](../examples/relying-party) to see what an application needs to do to sign users in. It uses the
  standard `openid-client` library and nothing specific to pforte.
- Make the pages your own: [branding and languages](branding-and-languages.md).
- Read what pforte does against attacks, and what it asks of you: [security measures](security.md).
