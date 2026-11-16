#!/usr/bin/env bash
# Deploys or updates pforte on a Docker Swarm behind caddy-docker-proxy (README.md). Run it from a checkout of
# the repository, on the machine that holds .env and ./secrets: the Docker CLI reaches the swarm through
# SWARM_MANAGER (an SSH host), and nothing secret is copied to a server as a file.
#
#   ./deploy.sh --check    # validates .env and the stack files and says what would be deployed; touches nothing
#   ./deploy.sh            # data folder, images, secrets, docker stack deploy
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY="$(cd ../.. && pwd)"

CHECK=false
case "${1:-}" in
  '') ;;
  --check) CHECK=true ;;
  *) echo "Usage: ./deploy.sh [--check]" >&2; exit 2 ;;
esac
fail() { echo "$*" >&2; exit 1; }

[ -f .env ] || fail "There is no .env here. Run ./setup.sh first, then fill in .env."
set -a && source .env && set +a
export STACK_NAME="${STACK_NAME:-pforte}"

for name in PFORTE_HOST PFORTE_IMAGE MAIL_FROM DATA_DIR; do
  [ -n "${!name:-}" ] || fail "${name} is not set in .env."
done
for secret in db_password database_url cookie_keys jwks smtp_url; do
  [ -s "secrets/${secret}" ] || fail "secrets/${secret} is missing or empty. ./setup.sh makes the secrets."
done
grep -q "@${STACK_NAME}_db:" secrets/database_url || fail "secrets/database_url does not name the database of the stack \"${STACK_NAME}\" (${STACK_NAME}_db). The stack name was changed after ./setup.sh."
case "${DATA_DIR}" in /*) ;; *) fail "DATA_DIR must be an absolute path on the node that runs the services." ;; esac

# The node the services run on: where the data folder is made and where an image is built.
NODE="${DATA_NODE:-${SWARM_MANAGER:-}}"
on_node() { if [ -n "${NODE}" ]; then ssh "${NODE}" "$@"; else bash -c "$*"; fi; }
[ -z "${SWARM_MANAGER:-}" ] || export DOCKER_HOST="ssh://${SWARM_MANAGER}"

# A secret of a swarm cannot be changed, so each is named after what is in it.
fingerprint() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -c1-12; }
export DB_PASSWORD_PRINT="$(fingerprint secrets/db_password)"
export DATABASE_URL_PRINT="$(fingerprint secrets/database_url)"
export COOKIE_KEYS_PRINT="$(fingerprint secrets/cookie_keys)"
export JWKS_PRINT="$(fingerprint secrets/jwks)"
export SMTP_URL_PRINT="$(fingerprint secrets/smtp_url)"

# `build` as an image means: this checkout, built on the node that will run it. Nothing is pushed to a registry,
# so the swarm must not look the image up there.
revision="$(git -C "${REPOSITORY}" rev-parse --short HEAD)"
git -C "${REPOSITORY}" diff --quiet HEAD -- || revision="${revision}-changed-$(date +%Y%m%d%H%M%S)"
RESOLVE=always
BUILDS=()
if [ "${PFORTE_IMAGE}" = build ]; then
  export PFORTE_IMAGE="pforte:${STACK_NAME}-${revision}"
  BUILDS+=("${PFORTE_IMAGE}|Dockerfile")
  RESOLVE=never
fi
FILES=(-c stack.yml)
if [ -n "${APP_HOST:-}" ]; then
  FILES+=(-c stack.app.yml)
  if [ "${APP_IMAGE:-build}" = build ]; then
    export APP_IMAGE="pforte-example-app:${STACK_NAME}-${revision}"
    BUILDS+=("${APP_IMAGE}|examples/relying-party/Dockerfile")
    RESOLVE=never
  fi
fi

echo "Stack:      ${STACK_NAME} on ${SWARM_MANAGER:-the Docker of this shell}"
echo "pforte:     https://${PFORTE_HOST}  (${PFORTE_IMAGE})"
[ -z "${APP_HOST:-}" ] || echo "Application: https://${APP_HOST}  (${APP_IMAGE}, client ${APP_CLIENT_ID:-example-app})"
echo "Runs on:    ${PLACEMENT:-node.role == manager}, data in ${DATA_DIR} on ${NODE:-this machine}"
echo "Mail from:  ${MAIL_FROM}"
[ -z "${BOOTSTRAP_ADMIN_EMAIL:-}" ] || echo "First administrator: ${BOOTSTRAP_ADMIN_EMAIL} (gets the activation link while the database has no administrator)"

if ${CHECK}; then
  # Reads the files as the deploy would, with every variable filled in. The swarm is not asked anything.
  DOCKER_HOST='' docker stack config "${FILES[@]}" > /dev/null
  echo "The stack files are valid. Nothing was deployed."
  exit 0
fi

docker node ls --format '{{.Hostname}} {{.Status}} {{.ManagerStatus}}'
docker network inspect "${PROXY_NETWORK:-caddy}" > /dev/null 2>&1 || fail "The network \"${PROXY_NETWORK:-caddy}\" of the edge proxy does not exist on this swarm."

echo "Preparing ${DATA_DIR} on ${NODE:-this machine} ..."
on_node "mkdir -p '${DATA_DIR}/db'"

for build in "${BUILDS[@]+"${BUILDS[@]}"}"; do
  image="${build%%|*}"
  echo "Building ${image} on ${NODE:-this machine} ..."
  DOCKER_HOST="${NODE:+ssh://${NODE}}" docker build --quiet -f "${REPOSITORY}/${build##*|}" -t "${image}" \
    --build-arg "VERSION=0.0.0-${revision}" --build-arg "REVISION=$(git -C "${REPOSITORY}" rev-parse HEAD)" "${REPOSITORY}"
done

echo "Deploying ${STACK_NAME} ..."
docker stack deploy --resolve-image "${RESOLVE}" --prune "${FILES[@]}" "${STACK_NAME}"

# Secrets of this stack that no service uses any more (the files changed) are removed. One that is in use cannot
# be removed, so this cannot take away what runs.
docker secret ls --filter "name=${STACK_NAME}_" --format '{{.Name}}' | while read -r secret; do
  case "${secret}" in
    "${STACK_NAME}_db_password_${DB_PASSWORD_PRINT}" | "${STACK_NAME}_database_url_${DATABASE_URL_PRINT}" | "${STACK_NAME}_cookie_keys_${COOKIE_KEYS_PRINT}" | "${STACK_NAME}_jwks_${JWKS_PRINT}" | "${STACK_NAME}_smtp_url_${SMTP_URL_PRINT}") ;;
    *) docker secret rm "${secret}" > /dev/null 2>&1 && echo "Removed the old secret ${secret}" || true ;;
  esac
done

echo "Done. Status: docker stack services ${STACK_NAME}; log: docker service logs -f ${STACK_NAME}_pforte"
