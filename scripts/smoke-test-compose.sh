#!/usr/bin/env bash
# Starts the production example (examples/production) with Caddy, Postgres and the given pforte image, and checks it from
# the outside like a visitor would. Needs Docker and the free ports 80 and 443. For a host name that is not public Caddy
# makes a certificate of its own, so the checks use `curl -k`.
# Usage: scripts/smoke-test-compose.sh <image>
set -euo pipefail

IMAGE=${1:?usage: smoke-test-compose.sh <image>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
cp -R "$ROOT/examples/production/." "$WORK/"
cd "$WORK"

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  docker compose logs --tail 30 2>&1 >&2 || true
  exit 1
}
cleanup() {
  cd "$WORK" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

export PFORTE_IMAGE="$IMAGE"
export COMPOSE_PROJECT_NAME=pforte-smoke-$$

step "Setup"
SMTP_URL=smtp://localhost:1025 ./setup.sh >/dev/null
cat > .env <<'ENV'
PFORTE_HOST=localhost
MAIL_FROM=no-reply@example.test
ORGANISATION_NAME=Smoke Test
ENV
for file in db_password database_url cookie_keys jwks smtp_url; do [ -s "secrets/$file" ] || fail "secrets/$file is empty"; done
[ "$(stat -c '%a' secrets 2>/dev/null || stat -f '%Lp' secrets)" = 700 ] || fail "./secrets is not for its owner alone"

step "Start"
docker compose up -d --wait --wait-timeout 180 >/dev/null || fail "the services did not become healthy"

step "Reached from outside, through Caddy"
for _ in $(seq 1 30); do
  DISCOVERY=$(curl -ksS --max-time 10 https://localhost/.well-known/openid-configuration 2>/dev/null) && break
  sleep 2
done
[ -n "${DISCOVERY:-}" ] || fail "no discovery document through https://localhost"
printf '%s' "$DISCOVERY" | grep -q '"issuer":"https://localhost"' || fail "the issuer is not https://localhost: $DISCOVERY"
HEADERS=$(curl -ksSI --max-time 10 https://localhost/.well-known/openid-configuration)
printf '%s' "$HEADERS" | grep -qi '^strict-transport-security:' || fail "no HSTS header: $HEADERS"
REDIRECT=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://localhost/)
case "$REDIRECT" in 301|302|307|308) ;; *) fail "http was not sent to https (HTTP $REDIRECT)" ;; esac

step "Only Caddy is reachable"
for service in pforte db; do
  PORTS=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$(docker compose ps -q $service)")
  printf '%s' "$PORTS" | grep -q HostPort && fail "$service is published to the host: $PORTS"
done

step "pforte runs without privileges, and the database has no way out"
[ "$(docker compose exec -T pforte id -u)" != 0 ] || fail "pforte runs as root"
docker compose exec -T pforte sh -c 'touch /app/probe 2>/dev/null' && fail "pforte's root filesystem is writable" || true
if docker compose exec -T db sh -c 'wget -q -T 3 -O /dev/null http://1.1.1.1' >/dev/null 2>&1; then fail "the database can reach the internet"; fi

step "No errors in the logs"
LOGS=$(docker compose logs 2>&1)
if printf '%s' "$LOGS" | grep -q '"level":\(50\|60\)'; then fail "error-level log lines"; fi
if printf '%s' "$LOGS" | grep -q 'ERROR:'; then fail "the database logged an error"; fi

printf '\nThe production example works.\n'
