# pforte in production, with Docker Compose

pforte, Postgres and [Caddy](https://caddyserver.com) on one machine. Caddy gets and renews the TLS certificate, so nothing
here needs a certificate to be handled by hand. You need:

- a machine with Docker and Docker Compose v2,
- a host name such as `id.example.com` whose DNS record points to it, and the ports **80 and 443** reachable from the internet
  (Caddy needs both to get the certificate),
- a mail server (SMTP) to send sign-in codes and activation links.

## Set up

```bash
cd examples/production
./setup.sh                  # makes ./secrets and a first .env; asks for the address of your mail server
$EDITOR .env                # PFORTE_HOST, MAIL_FROM, ORGANISATION_NAME, BOOTSTRAP_ADMIN_EMAIL, TIME_ZONE
docker compose up -d
docker compose logs -f pforte
```

Use a published version: `PFORTE_IMAGE=ghcr.io/progwise/pforte:0.1.0` in `.env` (the available versions are on the
[releases page](https://github.com/progwise/pforte/releases)). **Pin a version** rather than `latest`, so an update is something
you decide.

`setup.sh` makes five secrets in `./secrets`: the database password and its address, the key that signs cookies, the key that
signs tokens, and your mail server's address. They are files, not values in the compose file or in `.env`, so they do not show up
in `docker inspect` or in a `git diff`. **Back the folder up apart from the server**: without the keys nobody's sign-in survives
a lost server. It is in `.gitignore`.

## First sign-in

With `BOOTSTRAP_ADMIN_EMAIL` set, pforte mails that address a link to choose a password on the first start. After that open
`https://<your host>/manage`, sign in, and enter the code that is mailed to you. From there you create users, clients and claim
types, or import users from a CSV file; see [the administration](../../docs/administration.md). The setting does nothing once
an administrator exists, so it can stay.

## What this setup does for you

- Only Caddy is reachable from outside, on ports 80 and 443. http is redirected to https. pforte and the database publish no ports.
- The database sits on a network that is closed in both directions: only pforte can reach it, and it cannot reach the internet.
- pforte runs as an unprivileged user, with all capabilities dropped and a read-only filesystem.
- Secrets are files. The database password is random and long; pforte refuses to start in production with a weak one.
- `TRUST_PROXY=1` tells pforte that Caddy is the one proxy in front of it, so that rate limits count by the visitor's address
  ([rate limits](../../docs/rate-limiting.md)).

## Update

```bash
# set PFORTE_IMAGE to the new version in .env, then
docker compose pull && docker compose up -d
```

Pending database migrations are applied when pforte starts (instances that start together take turns). Migrations cannot be
undone, so **back up before updating**.

## Back up

```bash
docker compose exec -T db pg_dump -U pforte pforte | gzip > pforte-$(date +%F).sql.gz        # the database
# the ./secrets folder, apart from the server
```

To restore into an empty database: `gunzip -c pforte-….sql.gz | docker compose exec -T db psql -U pforte pforte`.

## Your own name, colours and texts

Put a folder `branding` next to `compose.yaml` and remove the `#` in front of `BRANDING_DIR` and the volume in `compose.yaml`;
see [branding and languages](../../docs/branding-and-languages.md).

## Another proxy than Caddy

Remove the `caddy` service, publish pforte's port to your proxy only (`ports: ['127.0.0.1:3300:3300']`), set `PFORTE_ISSUER` to
the public address, and set `TRUST_PROXY` to the number of proxies in front of pforte
([configuration](../../docs/configuration.md)). Your proxy must pass the original host and `X-Forwarded-For`.

## Try it on your own machine

`PFORTE_HOST=localhost` makes Caddy use a certificate of its own, which your browser will warn about. `scripts/smoke-test-compose.sh <image>`
in the repository does exactly this and checks the result: it is what CI runs against this example.

## Keys

New keys sign everybody out and make every issued token unverifiable, so `setup.sh` refuses to run twice. To rotate them without
that, add the new key in front of the old one and remove the old one when its tokens and cookies have expired; see
[configuration](../../docs/configuration.md#what-a-production-start-needs). `docker run --rm <image> keys` prints new ones.
