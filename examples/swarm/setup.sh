#!/usr/bin/env bash
# Makes the secrets of a new installation in ./secrets and a first .env. Run it once, on the machine you deploy
# from. Needs Docker (to make pforte's keys) and openssl. The mail server address can be given as SMTP_URL, or
# it is asked for. The name of the stack is part of the database address: give another one as STACK_NAME.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v openssl >/dev/null || { echo "openssl is needed to make the database password." >&2; exit 1; }

if [ -e secrets/cookie_keys ] || [ -e secrets/jwks ]; then
  echo "./secrets already has keys. Not touching them: new keys would sign everybody out and invalidate every token." >&2
  echo "Delete the folder first if that is what you want." >&2
  exit 1
fi

# The stack name of an .env that exists wins: the database address must match what is deployed.
if [ -e .env ]; then
  STACK_NAME=$(sed -n 's/^STACK_NAME=//p' .env | tail -1)
fi
STACK_NAME=${STACK_NAME:-pforte}

if [ -z "${SMTP_URL:-}" ]; then
  echo "Address of your mail server, such as smtps://user:password@mail.example.com:465 (not shown, not stored anywhere else):"
  read -rs SMTP_URL
  echo
fi
case "$SMTP_URL" in smtp://*|smtps://*) ;; *) echo "The address must start with smtp:// or smtps://" >&2; exit 1 ;; esac

# The keys are made by a pforte image on this machine, whichever version the swarm will run.
KEYS=$(DOCKER_HOST='' docker run --rm "${KEYS_IMAGE:-ghcr.io/progwise/pforte:latest}" keys)
DB_PASSWORD=$(openssl rand -hex 24)

install -d -m 700 secrets
printf '%s' "$DB_PASSWORD" > secrets/db_password
# The database is the service `db` of this stack. Its full name is used, because pforte is also on the network of
# the edge proxy, where another stack may have a service called `db`.
printf 'postgres://pforte:%s@%s_db:5432/pforte' "$DB_PASSWORD" "$STACK_NAME" > secrets/database_url
printf '%s\n' "$KEYS" | sed -n 's/^COOKIE_KEYS=//p' > secrets/cookie_keys
printf '%s\n' "$KEYS" | sed -n 's/^JWKS=//p' > secrets/jwks
printf '%s' "$SMTP_URL" > secrets/smtp_url
chmod 600 secrets/*

if [ ! -e .env ]; then
  sed "s/^STACK_NAME=.*/STACK_NAME=${STACK_NAME}/" .env.example > .env
  echo "Made .env for the stack \"${STACK_NAME}\": set PFORTE_HOST, MAIL_FROM and the rest in it, then ./deploy.sh --check"
else
  echo ".env exists and was left as it is (stack \"${STACK_NAME}\")."
fi
echo "Made ./secrets. Back it up apart from the swarm: without these keys nobody can be signed in again."
