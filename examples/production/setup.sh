#!/usr/bin/env bash
# Makes the secrets of a new installation in ./secrets and a first .env. Run it once.
# Needs Docker and openssl. The mail server address can be given as SMTP_URL, or it is asked for.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=${PFORTE_IMAGE:-ghcr.io/progwise/pforte:latest}
command -v openssl >/dev/null || { echo "openssl is needed to make the database password." >&2; exit 1; }

if [ -e secrets/cookie_keys ] || [ -e secrets/jwks ]; then
  echo "./secrets already has keys. Not touching them: new keys would sign everybody out and invalidate every token." >&2
  echo "Delete the folder first if that is what you want." >&2
  exit 1
fi

if [ -z "${SMTP_URL:-}" ]; then
  echo "Address of your mail server, such as smtps://user:password@mail.example.com:465 (not shown, not stored anywhere else):"
  read -rs SMTP_URL
  echo
fi
case "$SMTP_URL" in smtp://*|smtps://*) ;; *) echo "The address must start with smtp:// or smtps://" >&2; exit 1 ;; esac

KEYS=$(docker run --rm "$IMAGE" keys)
DB_PASSWORD=$(openssl rand -hex 24)

# The folder is for you alone. The files are readable, as the containers run as other users and read them as files.
install -d -m 700 secrets
printf '%s' "$DB_PASSWORD" > secrets/db_password
printf 'postgres://pforte:%s@db:5432/pforte' "$DB_PASSWORD" > secrets/database_url
printf '%s\n' "$KEYS" | sed -n 's/^COOKIE_KEYS=//p' > secrets/cookie_keys
printf '%s\n' "$KEYS" | sed -n 's/^JWKS=//p' > secrets/jwks
printf '%s' "$SMTP_URL" > secrets/smtp_url
chmod 644 secrets/*

if [ ! -e .env ]; then
  cp .env.example .env
  echo "Made .env: set PFORTE_HOST, MAIL_FROM and the rest in it, then start with: docker compose up -d"
else
  echo ".env exists and was left as it is."
fi
echo "Made ./secrets. Back it up apart from the server: without these keys nobody can be signed in again."
