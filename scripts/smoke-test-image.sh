#!/usr/bin/env bash
# Starts the pforte image the way an operator would, against a fresh Postgres, and checks that it works.
# Usage: scripts/smoke-test-image.sh <image> [expected-version]
# Needs only Docker. Used by CI and by the release workflow, and runs the same on a developer's machine.
set -euo pipefail

IMAGE=${1:?usage: smoke-test-image.sh <image> [expected-version]}
EXPECTED_VERSION=${2:-}
RUN=$$
NETWORK=pforte-smoke-$RUN
DATABASE=pforte-smoke-db-$RUN
SERVER=pforte-smoke-$RUN
ISSUER=https://id.example.test

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  if docker inspect "$SERVER" >/dev/null 2>&1; then docker logs "$SERVER" 2>&1 | tail -40 >&2; fi
  exit 1
}
cleanup() {
  docker rm -f "$SERVER" "$DATABASE" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Database"
docker network create "$NETWORK" >/dev/null
PASSWORD=$(openssl rand -hex 16)
docker run -d --name "$DATABASE" --network "$NETWORK" \
  -e POSTGRES_USER=pforte -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=pforte postgres:18-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DATABASE" pg_isready -U pforte -d pforte >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DATABASE" pg_isready -U pforte -d pforte >/dev/null 2>&1 || fail "Postgres did not become ready"
DATABASE_URL="postgres://pforte:$PASSWORD@$DATABASE:5432/pforte"

step "Version and help"
if [ -n "$EXPECTED_VERSION" ]; then
  [ "$(docker run --rm "$IMAGE" --version)" = "$EXPECTED_VERSION" ] || fail "--version is not $EXPECTED_VERSION"
fi
HELP=$(docker run --rm "$IMAGE" --help)
printf '%s' "$HELP" | grep -q "pforte migrate" || fail "--help does not list the commands"

step "Keys"
KEYS=$(docker run --rm "$IMAGE" keys)
printf '%s\n' "$KEYS" | grep -q '^COOKIE_KEYS=.\{40,\}' || fail "keys printed no COOKIE_KEYS"
printf '%s\n' "$KEYS" | grep -q '^JWKS={"keys":\[' || fail "keys printed no JWKS"

step "Refuses to start without keys"
if OUTPUT=$(docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" -e ISSUER="$ISSUER" "$IMAGE" 2>&1); then
  fail "started without COOKIE_KEYS"
fi
printf '%s' "$OUTPUT" | grep -q 'COOKIE_KEYS is required' || fail "the message does not name COOKIE_KEYS: $OUTPUT"

step "Migrations"
FIRST=$(docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" "$IMAGE" migrate)
printf '%s' "$FIRST" | grep -q 'Applied' || fail "migrate applied nothing to an empty database: $FIRST"
SECOND=$(docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" "$IMAGE" migrate)
printf '%s' "$SECOND" | grep -q 'up to date' || fail "a second migrate found something to do: $SECOND"

step "Start, read-only and without privileges"
KEYS_FILE=$(mktemp)
printf '%s\n' "$KEYS" > "$KEYS_FILE"
docker run -d --name "$SERVER" --network "$NETWORK" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::3300 --env-file "$KEYS_FILE" \
  -e DATABASE_URL="$DATABASE_URL" -e ISSUER="$ISSUER" \
  -e SMTP_URL=smtp://localhost:1025 -e MAIL_FROM="pforte <no-reply@example.test>" "$IMAGE" >/dev/null
rm -f "$KEYS_FILE"

for _ in $(seq 1 90); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$SERVER")" = healthy ] && break
  [ "$(docker inspect --format '{{.State.Running}}' "$SERVER")" = true ] || fail "the container stopped"
  sleep 1
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "$SERVER")" = healthy ] || fail "the healthcheck did not turn healthy"
URL="http://$(docker port "$SERVER" 3300/tcp | head -1)"

step "Serves discovery"
DISCOVERY=$(curl -fsS --max-time 10 "$URL/.well-known/openid-configuration") || fail "no discovery document"
printf '%s' "$DISCOVERY" | grep -q "\"issuer\":\"$ISSUER\"" || fail "the issuer in discovery is not $ISSUER"
JWKS_PUBLISHED=$(curl -fsS --max-time 10 "$URL/jwks") || fail "no /jwks"
KEY_COUNT=$(printf '%s' "$JWKS_PUBLISHED" | grep -o '"kid"' | wc -l | tr -d ' ')
[ "$KEY_COUNT" = 1 ] || fail "expected one published signing key, found $KEY_COUNT"
curl -fsS --max-time 10 -o /dev/null "$URL/health" || fail "/health is not ok"
STATUS=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$URL/manage")
[ "$STATUS" = 303 ] || fail "/manage did not send a stranger to sign in (HTTP $STATUS)"

step "Runs as nobody in particular"
[ "$(docker exec "$SERVER" id -u)" != 0 ] || fail "the process runs as root"
docker exec "$SERVER" sh -c 'touch /app/probe 2>/dev/null' && fail "the root filesystem is writable" || true

step "Logs show no errors"
LOGS=$(docker logs "$SERVER" 2>&1)
if printf '%s' "$LOGS" | grep -q '"level":\(50\|60\)'; then fail "error-level log lines"; fi

printf '\nThe image works.\n'
