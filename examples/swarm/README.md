# pforte on a Docker Swarm

pforte and Postgres as a stack on a Docker Swarm that already has an edge proxy:
[caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy), which routes by labels on the services and gets
the TLS certificates. The stack publishes no ports. For one machine without a swarm, use
[Docker Compose](../production/README.md) instead.

You need:

- a Docker Swarm with caddy-docker-proxy running and its overlay network (here called `caddy`),
- a host name such as `id.example.com` whose DNS record points to the node of the edge proxy,
- a mail server (SMTP) to send sign-in codes and activation links,
- on the machine you deploy from: Docker, a checkout of this repository, and SSH access to the swarm.

Everything is run from that machine. `.env` and `./secrets` stay on it; the secrets reach the swarm as swarm secrets,
never as files on a server.

## Set up

```bash
cd examples/swarm
STACK_NAME=pforte ./setup.sh   # makes ./secrets and a first .env; asks for the address of your mail server
$EDITOR .env                   # PFORTE_HOST, PFORTE_IMAGE, SWARM_MANAGER, PLACEMENT, DATA_DIR, MAIL_FROM, ...
./deploy.sh --check            # validates and says what would be deployed; touches nothing
./deploy.sh
```

| Setting | What it is |
| --- | --- |
| `STACK_NAME` | The name of the stack. Services, secrets and the database address carry it: choose it before `./setup.sh` and keep it. |
| `PFORTE_HOST` | The public name of pforte. |
| `PFORTE_IMAGE` | A released version such as `ghcr.io/progwise/pforte:0.2.0`, or `build` (below). **Pin a version**, so an update is something you decide. |
| `SWARM_MANAGER` | An SSH host of a manager node. The Docker CLI talks to it as `ssh://<host>`. Empty: the Docker of your shell. |
| `PLACEMENT` | The constraint that names the node the services run on, such as `node.role == worker` or `node.hostname == node-2`. The database's files are a folder on that node, so the services must not move. |
| `DATA_DIR`, `DATA_NODE` | The folder on that node, and the SSH host to reach the node by. `deploy.sh` makes the folder. |
| `PROXY_NETWORK` | The overlay network of caddy-docker-proxy. |
| `TRUST_PROXY` | `1` for the edge proxy alone, `2` with a CDN in front of it ([rate limits](../../docs/rate-limiting.md)). |
| `MAIL_FROM`, `ORGANISATION_NAME`, `DEFAULT_LANGUAGE`, `TIME_ZONE`, `BOOTSTRAP_ADMIN_EMAIL` | As in the [configuration reference](../../docs/configuration.md). |

`deploy.sh` loads `.env` with the shell, so a value with spaces needs quotes: `PLACEMENT="node.role == worker"`.

## First sign-in

With `BOOTSTRAP_ADMIN_EMAIL` set, pforte mails that address a link to choose a password on the first start. After that
open `https://<your host>/manage`, sign in, and enter the code that is mailed to you
([the administration](../../docs/administration.md)).

```bash
export DOCKER_HOST=ssh://<SWARM_MANAGER>
docker stack services pforte
docker service logs -f pforte_pforte
```

## What this setup does for you

- **No ports.** Only the edge proxy is reachable from outside; it finds pforte by the `caddy` labels and speaks to it
  over the proxy's network.
- **The database is on a network of its own** that is closed in both directions: only pforte can reach it, and it
  cannot reach the internet. pforte names it in full (`<stack>_db`), because on the proxy's network another stack may
  have a service called `db`.
- **Secrets are swarm secrets**: the database password and address, the two keys and the mail server's address are
  mounted into the containers as files and appear neither in the stack file nor in `docker service inspect`. A swarm
  secret cannot be changed, only replaced, so each carries a fingerprint of its file in its name. Change a file in
  `./secrets`, run `./deploy.sh`, and the service restarts with a new secret; the old one is removed.
- **pforte's container** has a read-only filesystem and no Linux capabilities, runs as an unprivileged user, and is
  restarted when its health check fails.
- **One instance, stopped before the new one starts**, so the migrations of a new version never run next to an old
  pforte.

**Back up `./secrets`, apart from the swarm**: without the keys nobody's sign-in survives. And back up the database:

```bash
ssh <DATA_NODE> 'docker exec $(docker ps -q -f name=pforte_db) pg_dump -U pforte pforte' | gzip > pforte-$(date +%F).sql.gz
```

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
