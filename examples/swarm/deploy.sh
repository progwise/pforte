#!/usr/bin/env bash
# Deploys or updates pforte on a Docker Swarm behind caddy-docker-proxy (README.md). Run it from a checkout of
# the repository, on the machine that holds .env and ./secrets: the Docker CLI reaches the swarm through
# SWARM_MANAGER (an SSH host), and nothing secret is copied to a server as a file. Everything on a server is done
# through its Docker; no command is run there in a shell.
#
#   ./deploy.sh --check    # validates .env and the stack files and says what would be deployed; touches nothing
#   ./deploy.sh            # data folder, branding, images, secrets, docker stack deploy, pinned to the node of the data
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

# Whether a file holds a JSON object whose values are all strings, as pforte wants the headers for the SMS
# provider. Written out as a pattern, because this script can count on neither jq nor node. It must never say
# yes where pforte's JSON.parse says no, so it is the stricter of the two: between the parts only the four
# characters JSON allows there (not a form feed, which [[:space:]] would let through), and in a string no control
# character at all. scripts/swarm-deploy.test.mjs holds it against JSON.parse.
is_json_object_of_strings() {
  local ws=$'[ \t\n\r]*' string pair
  # The shell drops NUL bytes when it reads a file, and JSON allows none.
  [ "$(LC_ALL=C tr -d '\000' < "$1" | wc -c)" -eq "$(wc -c < "$1")" ] || return 1
  string='"([^"\\[:cntrl:]]|\\(["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
  pair="${string}${ws}:${ws}${string}"
  local object="^${ws}\\{${ws}(${pair}(${ws},${ws}${pair})*)?${ws}\\}${ws}\$"
  [[ "$(< "$1")" =~ ${object} ]]
}

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
# Codes by SMS are optional (stack.sms.yml). The headers are the credentials of the provider: a file in ./secrets
# like the other secrets, not a line of .env, which would put them into the definition of the service.
if [ -n "${SMS_PROVIDER:-}" ]; then
  [ -z "${SMS_HEADERS:-}" ] || fail "SMS_HEADERS is set in .env. The headers carry the credentials of the SMS provider: put the JSON object into the file secrets/sms_headers and remove the line."
  [ -s secrets/sms_headers ] || fail "SMS_PROVIDER is set, but secrets/sms_headers is missing or empty. It holds the headers for the SMS provider as a JSON object (README.md)."
  # pforte refuses to start with headers that are not a JSON object of strings, and the one instance is stopped
  # before the new one starts: a typo in the file would take sign-in offline. What is in the file is never shown,
  # also not the part that is wrong.
  is_json_object_of_strings secrets/sms_headers \
    || fail 'secrets/sms_headers is not a JSON object whose values are all strings, such as {"X-Api-Key":"...","Accept":"application/json"}. pforte would not start with it. Look for a missing or doubled quote, comma or brace.'
  [ -n "${SMS_BODY:-}" ] || fail "SMS_BODY is not set in .env."
fi

# A branding folder is optional (stack.branding.yml). It is a folder on this machine, given from here or as an
# absolute path; the deploy copies it to the node.
if [ -n "${BRANDING_DIR:-}" ]; then
  [ -d "${BRANDING_DIR}" ] || fail "BRANDING_DIR is set in .env, but there is no folder \"${BRANDING_DIR}\" on this machine (seen from examples/swarm, or an absolute path)."
fi

# Two Dockers. The manager's takes the stack. The one of the node the services run on gets the data folder and
# the images, and the services are pinned to that node (below): on any other the database would start next to an
# empty folder. A host that .env names is addressed with -H, which no Docker context and no DOCKER_HOST of the
# shell can redirect. Where .env names none, both are the Docker of this shell, wherever that is: the folder is
# made through it too, so it cannot end up on another machine than the one the services are pinned to.
NODE="${DATA_NODE:-${SWARM_MANAGER:-}}"
on_swarm() { docker ${SWARM_MANAGER:+-H "ssh://${SWARM_MANAGER}"} "$@"; }
on_node() { docker ${NODE:+-H "ssh://${NODE}"} "$@"; }

# A secret of a swarm cannot be changed, so each is named after what is in it.
fingerprint() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -c1-12; }
export DB_PASSWORD_PRINT="$(fingerprint secrets/db_password)"
export DATABASE_URL_PRINT="$(fingerprint secrets/database_url)"
export COOKIE_KEYS_PRINT="$(fingerprint secrets/cookie_keys)"
export JWKS_PRINT="$(fingerprint secrets/jwks)"
export SMTP_URL_PRINT="$(fingerprint secrets/smtp_url)"
SMS_HEADERS_PRINT=''
if [ -n "${SMS_PROVIDER:-}" ]; then
  export SMS_HEADERS_PRINT="$(fingerprint secrets/sms_headers)"
  # A swarm reads {{...}} in the environment of a service as a template of its own and refuses {{to}}. Each
  # placeholder is passed as a template that gives the placeholder itself: {{to}} becomes {{"{{to}}"}}.
  export SMS_BODY_FOR_SWARM="$(printf '%s' "${SMS_BODY}" | sed 's/{{[^{}]*}}/{{"&"}}/g')"
fi

# pforte reads the branding folder when it starts, and a swarm restarts a service only when its definition changed.
# So the folder on the node is named after a fingerprint of the names and the content of the files: a changed
# folder is another folder, and with it a changed service. Links are followed, as the copy follows them.
#
# The same lines work it out here and on the node, where the copy is held against it before it is used: so they
# are a text that both shells read, and plain sh. A file that cannot be read ends it.
read -r -d '' FOLDER_FINGERPRINT <<'SH' || true
folder_fingerprint() {
  (cd "$1" && find -L . -type f ! -name .DS_Store | LC_ALL=C sort | while IFS= read -r file; do printf '%s\n' "$file"; cat "$file" || exit 1; done) \
    | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12
}
SH
eval "${FOLDER_FINGERPRINT}"
if [ -n "${BRANDING_DIR:-}" ]; then
  # Not `export NAME="$(...)"`: that answers for the export, and a folder read by half would pass.
  BRANDING_PRINT="$(folder_fingerprint "${BRANDING_DIR}")" && [[ "${BRANDING_PRINT}" =~ ^[0-9a-f]{12}$ ]] \
    || fail "The branding folder \"${BRANDING_DIR}\" could not be read in full: see the message above. Nothing was deployed."
  export BRANDING_PRINT
fi

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
[ -z "${SMS_PROVIDER:-}" ] || FILES+=(-c stack.sms.yml)
[ -z "${BRANDING_DIR:-}" ] || FILES+=(-c stack.branding.yml)
if [ -n "${APP_HOST:-}" ]; then
  FILES+=(-c stack.app.yml)
  if [ "${APP_IMAGE:-build}" = build ]; then
    export APP_IMAGE="pforte-example-app:${STACK_NAME}-${revision}"
    BUILDS+=("${APP_IMAGE}|examples/relying-party/Dockerfile")
    RESOLVE=never
  fi
fi

# The image of the database, as the stack file names it: it also makes the data folder.
DB_IMAGE="$(sed -n 's/^ *image: *\(postgres:[^ ]*\) *$/\1/p' stack.yml)"
[ -n "${DB_IMAGE}" ] || fail "stack.yml names no postgres image for the database."

echo "Stack:      ${STACK_NAME} on ${SWARM_MANAGER:-the Docker of this shell}"
echo "pforte:     https://${PFORTE_HOST}  (${PFORTE_IMAGE})"
[ -z "${APP_HOST:-}" ] || echo "Application: https://${APP_HOST}  (${APP_IMAGE}, client ${APP_CLIENT_ID:-example-app})"
echo "Runs on:    ${NODE:-the node of the Docker of this shell}, and only there; data in ${DATA_DIR}"
echo "Mail from:  ${MAIL_FROM}"
# Nothing of the SMS address: with some providers it carries an account or a key, and no pattern of a shell reads
# an address exactly as pforte does.
[ -z "${SMS_PROVIDER:-}" ] || echo "SMS:        on"
[ -z "${BRANDING_DIR:-}" ] || echo "Branding:   ${BRANDING_DIR}  (on the node: ${DATA_DIR}/branding/${BRANDING_PRINT})"
[ -z "${BOOTSTRAP_ADMIN_EMAIL:-}" ] || echo "First administrator: ${BOOTSTRAP_ADMIN_EMAIL} (gets the activation link while the database has no administrator)"

if ${CHECK}; then
  # Reads the files as the deploy would, with every variable filled in. The swarm is not asked anything, so the
  # node has no ID yet.
  NODE_ID=known-at-the-deploy docker stack config "${FILES[@]}" > /dev/null
  echo "The stack files are valid. Nothing was deployed."
  exit 0
fi

on_swarm node ls --format '{{.Hostname}} {{.Status}} {{.ManagerStatus}}'
on_swarm network inspect "${PROXY_NETWORK:-caddy}" > /dev/null 2>&1 || fail "The network \"${PROXY_NETWORK:-caddy}\" of the edge proxy does not exist on this swarm."

# The services are pinned to the node whose Docker gets the folder and the images, by its ID: a role or a label
# can fit a second node tomorrow. That node must belong to the swarm that is deployed to.
NODE_ID="$(on_node info --format '{{.Swarm.NodeID}}')"
[ -n "${NODE_ID}" ] || fail "The Docker of ${NODE:-this shell} is not part of a swarm."
node_name="$(on_swarm node inspect "${NODE_ID}" --format '{{.Description.Hostname}}' 2> /dev/null)" \
  || fail "${NODE:-The Docker of this shell} is not a node of the swarm of ${SWARM_MANAGER:-the Docker of this shell}. DATA_NODE must be a node of that swarm."
export NODE_ID
echo "Pinned to the node ${node_name} (${NODE_ID})."

# The folder is made by the Docker that was just asked for its ID, so it is on the node the services are pinned
# to, whatever this script was told or not told about where that is.
echo "Preparing ${DATA_DIR} on ${node_name} ..."
on_node run --rm --entrypoint mkdir -v "${DATA_DIR}:/data" "${DB_IMAGE}" -p /data/db

# The branding folder goes through the same Docker, as an archive on its standard input, into a folder named after
# its fingerprint: a pforte that is running keeps the folder it started with, and a folder that is there already is
# not copied again.
#
# What arrives is not trusted to be what was sent: an archive can leave a file out and say nothing (a name too
# long for its format). So the node unpacks into a folder of its own for this attempt, works out the fingerprint
# of what is there, and puts the folder in place only if it is the one of the folder here. A folder that is in
# place already is held against its name the same way. The files are made readable for the user pforte runs as,
# whatever they are on this machine. Nothing is removed: the folders of earlier deploys stay, and so does what a
# refused attempt unpacked.
archive_of() { COPYFILE_DISABLE=1 tar -c -h --exclude .DS_Store -C "$1" -f - .; }
# $1: the fingerprint, $2: the data folder as the container sees it.
read -r -d '' PLACE_BRANDING <<'SH' || true
set -e
final="$2/branding/$1"
if [ -d "$final" ]; then
  cat > /dev/null
  [ "$(folder_fingerprint "$final")" = "$1" ] && exit 0
  echo "The branding folder that is on the node under this name, branding/$1, does not hold what the name says. Look at it and remove it, then deploy again." >&2
  exit 1
fi
mkdir -p "$2/branding"
attempt="$(mktemp -d "$2/branding/$1.XXXXXX")"
tar -x -o -f - -C "$attempt"
chmod -R a+rX "$attempt"
if [ "$(folder_fingerprint "$attempt")" != "$1" ]; then
  echo "What arrived on the node is not the branding folder that was sent: a file is missing or differs. Nothing was put in place, and pforte keeps running as it is." >&2
  exit 1
fi
mv "$attempt" "$final"
SH
if [ -n "${BRANDING_DIR:-}" ]; then
  echo "Copying the branding folder to ${node_name} ..."
  archive_of "${BRANDING_DIR}" \
    | on_node run --rm -i --entrypoint sh -v "${DATA_DIR}:/data" "${DB_IMAGE}" -c "${FOLDER_FINGERPRINT}"$'\n'"${PLACE_BRANDING}" sh "${BRANDING_PRINT}" /data
fi

for build in "${BUILDS[@]+"${BUILDS[@]}"}"; do
  image="${build%%|*}"
  echo "Building ${image} on ${node_name} ..."
  on_node build --quiet -f "${REPOSITORY}/${build##*|}" -t "${image}" \
    --build-arg "VERSION=0.0.0-${revision}" --build-arg "REVISION=$(git -C "${REPOSITORY}" rev-parse HEAD)" "${REPOSITORY}"
done

echo "Deploying ${STACK_NAME} ..."
on_swarm stack deploy --resolve-image "${RESOLVE}" --prune "${FILES[@]}" "${STACK_NAME}"

# The secrets this stack had before a file changed are removed. Only what is certainly one of them: a secret that
# this stack made (its label; a name that starts the same can belong to the stack "${STACK_NAME}_other") and that
# is named as the ones above are. Nothing else on the swarm is touched.
replaced="^${STACK_NAME}_(db_password|database_url|cookie_keys|jwks|smtp_url|sms_headers)_[0-9a-f]{12}$"
on_swarm secret ls --filter "label=com.docker.stack.namespace=${STACK_NAME}" --format '{{.Name}}' | while read -r secret; do
  [[ "${secret}" =~ ${replaced} ]] || continue
  case "${secret}" in
    "${STACK_NAME}_db_password_${DB_PASSWORD_PRINT}" | "${STACK_NAME}_database_url_${DATABASE_URL_PRINT}" | "${STACK_NAME}_cookie_keys_${COOKIE_KEYS_PRINT}" | "${STACK_NAME}_jwks_${JWKS_PRINT}" | "${STACK_NAME}_smtp_url_${SMTP_URL_PRINT}" | "${STACK_NAME}_sms_headers_${SMS_HEADERS_PRINT}") ;;
    *) on_swarm secret rm "${secret}" > /dev/null 2>&1 && echo "Removed the old secret ${secret}" || true ;;
  esac
done

echo "Done. Status: docker stack services ${STACK_NAME}; log: docker service logs -f ${STACK_NAME}_pforte"
