# pforte on a Docker Swarm

pforte and Postgres as a stack on a Docker Swarm that already has an edge proxy:
[caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy), which routes by labels on the services and gets
the TLS certificates. The stack publishes no ports. For one machine without a swarm, use
[Docker Compose](../production/README.md) instead.

You need:

- a Docker Swarm with caddy-docker-proxy running and its overlay network (here called `caddy`),
- a host name such as `id.example.com` whose DNS record points to the node of the edge proxy,
- a mail server (SMTP) to send sign-in codes and activation links,
- on the machine you deploy from: Docker, a checkout of this repository, and SSH access to the swarm, as a user who may
  use Docker there.

Everything is run from that machine. `.env` and `./secrets` stay on it; the secrets reach the swarm as swarm secrets,
never as files on a server.

## Set up

```bash
cd examples/swarm
STACK_NAME=pforte ./setup.sh   # makes ./secrets and a first .env; asks for the address of your mail server
$EDITOR .env                   # PFORTE_HOST, PFORTE_IMAGE, SWARM_MANAGER, DATA_NODE, DATA_DIR, MAIL_FROM, ...
./deploy.sh --check            # validates and says what would be deployed; touches nothing
./deploy.sh
```

| Setting | What it is |
| --- | --- |
| `STACK_NAME` | The name of the stack. Services, secrets and the database address carry it: choose it before `./setup.sh` and keep it. |
| `PFORTE_HOST` | The public name of pforte. |
| `PFORTE_IMAGE` | A released version such as `ghcr.io/progwise/pforte:0.3.0`, or `build` (below). **Pin a version**, so an update is something you decide. |
| `SWARM_MANAGER` | An SSH host of a manager node. The Docker CLI talks to it as `ssh://<host>`. Empty: the Docker of your shell. |
| `DATA_NODE` | The node the services run on, as an SSH host. Empty: the manager above, and without one the Docker of your shell. `deploy.sh` makes the data folder there, builds there, and pins the services to that node by its ID: the database's files are a folder on it, so nothing may start anywhere else. All three go through the Docker of that node, so they cannot land on different machines. |
| `DATA_DIR` | The folder on that node. |
| `PROXY_NETWORK` | The overlay network of caddy-docker-proxy. |
| `TRUST_PROXY` | `1` for the edge proxy alone, `2` with a CDN in front of it ([rate limits](../../docs/rate-limiting.md)). |
| `MAIL_FROM`, `ORGANISATION_NAME`, `DEFAULT_LANGUAGE`, `TIME_ZONE`, `BOOTSTRAP_ADMIN_EMAIL` | As in the [configuration reference](../../docs/configuration.md). |

`deploy.sh` loads `.env` with the shell, so a value with spaces needs quotes: `ORGANISATION_NAME="Example Inc."`.

The services stay on `DATA_NODE` also when that node is down: they wait for it. Moving to another node means moving
the data folder first, then changing `DATA_NODE`.

## First sign-in

With `BOOTSTRAP_ADMIN_EMAIL` set, pforte mails that address a link to choose a password on the first start. After that
open `https://<your host>/manage`, sign in, and enter the code that is mailed to you
([the administration](../../docs/administration.md)).

```bash
export DOCKER_HOST=ssh://<SWARM_MANAGER>
docker stack services pforte
docker service logs -f pforte_pforte
```

## Codes by SMS

Optional. Without it every code goes by e-mail ([sending codes by SMS](../../docs/sms.md)).

1. Put the settings of your provider into `.env`, as that page has them for your provider: `SMS_PROVIDER=http`, `SMS_URL`,
   `SMS_CONTENT_TYPE`, `SMS_BODY`, `SMS_FROM` and, where the provider needs it, `SMS_SUCCESS_PATTERN`. Keep the single
   quotes around the body and the pattern.
2. **Not `SMS_HEADERS`.** The headers carry your credentials, so they are a secret like the others: a file with the JSON
   object, and `deploy.sh` refuses the line in `.env`.

   ```bash
   printf '%s' '{"X-Api-Key":"your-api-key","Accept":"application/json"}' > secrets/sms_headers
   chmod 600 secrets/sms_headers
   ```

3. `./deploy.sh --check`, then `./deploy.sh`. With `SMS_PROVIDER` set it adds `stack.sms.yml`. Both first read the
   file as pforte will and stop when it is not a JSON object of strings: pforte would not start with it.

`SMS_URL` is part of the service definition, where everybody who may use Docker on the swarm can read it. That is fine
for an address; a provider that wants a key in the address itself does not fit this example.

If you write a stack file of your own: a swarm reads `{{...}}` in the environment of a service as a template of its own
and refuses `{{to}}` (`function "to" not defined`), so the task never starts. `deploy.sh` passes each placeholder of
`SMS_BODY` as `{{"{{to}}"}}`, which the swarm turns back into `{{to}}`.

## What this setup does for you

- **No ports.** Only the edge proxy is reachable from outside; it finds pforte by the `caddy` labels and speaks to it
  over the proxy's network.
- **The database is on a network of its own** that is closed in both directions: only pforte can reach it, and it
  cannot reach the internet. pforte names it in full (`<stack>_db`), because on the proxy's network another stack may
  have a service called `db`.
- **Secrets are swarm secrets**: the database password and address, the two keys, the mail server's address and the
  headers for the SMS provider are mounted into the containers as files and appear neither in the stack file nor in
  `docker service inspect`. They are not in an image either: a build leaves out `./secrets` and `.env`.
- **pforte's container** has a read-only filesystem and no Linux capabilities, runs as an unprivileged user, and is
  restarted when its health check fails.
- **One instance, stopped before the new one starts**, so the migrations of a new version never run next to an old
  pforte.

**Back up `./secrets`, apart from the swarm**: without the keys nobody's sign-in survives. And back up the database:

```bash
ssh <DATA_NODE> 'docker exec $(docker ps -q -f name=pforte_db) pg_dump -U pforte pforte' | gzip > pforte-$(date +%F).sql.gz
```

## Changing a secret

A swarm secret cannot be changed, only replaced, so each carries a fingerprint of its file in its name.

**The mail server's address, the headers for the SMS provider and the keys:** change the file in `./secrets` and run
`./deploy.sh`. pforte restarts with
the new secret, and the one it replaces is removed. For `cookie_keys` and `jwks`, add the new key in front of the old
one instead of replacing it: new keys alone sign everybody out
([configuration](../../docs/configuration.md#what-a-production-start-needs)).

**The database password is different.** Postgres reads `db_password` only once, when it makes the database in an empty
folder. Changing the file later changes nothing in the database, and a new password in `database_url` alone locks
pforte out. Change the password in the database first, then in both files, then deploy:

```bash
NEW=$(openssl rand -hex 24)
ssh <DATA_NODE> 'docker exec -i $(docker ps -q -f name=pforte_db) psql -U pforte -d pforte' <<< "ALTER ROLE pforte PASSWORD '${NEW}'"
printf '%s' "$NEW" > secrets/db_password
printf 'postgres://pforte:%s@pforte_db:5432/pforte' "$NEW" > secrets/database_url
./deploy.sh
```

`pforte_db` is the database of the stack `pforte`; with another stack name it is `<stack>_db`, in both places. From the
first of these lines until the deploy is through, pforte cannot open new connections to the database, so run them in
one go.

## Update

Set `PFORTE_IMAGE` in `.env` to the new version and run `./deploy.sh`. Read the
[changelog](../../CHANGELOG.md) first; migrations run at start and cannot be undone, so back up before.

## Running what is not released yet

`PFORTE_IMAGE=build` builds the checkout this folder is in, on the node that will run it, and deploys that image. Nothing
is pushed to a registry, so this works for any commit, also one of your own. The image is named after the commit
(`pforte:<stack>-<commit>`). It is meant for a test instance; production runs a released version. Old images stay on
the node until you remove them (`docker image prune`).

## An application to sign in to

For trying pforte on real devices it helps to have an application next to it. With `APP_HOST` set in `.env`,
`deploy.sh` also deploys the [example application](../relying-party/README.md) under that name (`stack.app.yml`), built
from the checkout. It needs its own DNS record, and a client in pforte's administration:

- **Clients → New client → Application**, ID `example-app` (or what `APP_CLIENT_ID` says), **public**,
- redirect URI `https://<APP_HOST>/callback`, after sign-out `https://<APP_HOST>/`,
- scopes `openid` and `profile`, refresh tokens on.

The application starts once pforte answers. It has a web manifest, so a phone can put it on its home screen. Its
sessions are in memory: it is for trying things, not for production.

## Another edge proxy

The `caddy` labels are the only part that is about caddy-docker-proxy. With Traefik or another proxy that reads labels,
replace the three labels under `deploy.labels` with that proxy's and keep the rest; pforte listens on port 3300 and
needs `X-Forwarded-For` from the proxy.
