#!/usr/bin/env bash
# Releases go through a pull request, because main is protected, and then a tag.
#
#   scripts/release.sh 0.2.0          Opens a pull request that turns "Unreleased" in CHANGELOG.md into the entry of 0.2.0.
#   (merge the pull request when its checks have passed, then: git checkout main && git pull)
#   scripts/release.sh --tag 0.2.0    Tags the merged release commit as v0.2.0.
#   git push origin v0.2.0            Pushing the tag starts the release workflow. Only administrators can create these tags.
#
# RELEASE_OFFLINE=1 skips talking to the remote, RELEASE_NO_PR=1 pushes the branch but leaves opening the pull request to you.
set -euo pipefail

die() { echo "Not releasing: $*" >&2; exit 1; }
usage() { echo "usage: scripts/release.sh <version>   |   scripts/release.sh --tag <version>      (version such as 0.2.0 or 0.2.0-rc.1)" >&2; exit 2; }

MODE=prepare
if [ "${1:-}" = --tag ]; then MODE=tag; shift; fi
VERSION=${1:-}
[ -n "$VERSION" ] || usage
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "\"$VERSION\" is not a version such as 0.2.0 or 0.2.0-rc.1"
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "this is not the main branch"
git diff --quiet && git diff --cached --quiet || die "there are uncommitted changes"
if [ -z "${RELEASE_OFFLINE:-}" ]; then
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not the same as origin/main: pull first"
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "the tag v$VERSION exists"

if [ "$MODE" = tag ]; then
  # The commit of the merged pull request: its subject is "Release X", with " (#123)" added when it was squashed.
  COMMIT=$(git log -1 --format=%H --extended-regexp --grep="^Release ${VERSION//./\\.}( \\(#[0-9]+\\))?\$" main)
  [ -n "$COMMIT" ] || die "main has no commit \"Release $VERSION\": merge the pull request first, and pull"
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT
  git show "$COMMIT:CHANGELOG.md" > "$TMP"
  node scripts/changelog.mjs notes "$VERSION" "$TMP" >/dev/null || die "the changelog of that commit has no entry for $VERSION"
  git tag -a "v$VERSION" -m "pforte $VERSION" "$COMMIT"
  echo "Tagged $(git log -1 --format='%h %s' "$COMMIT") as v$VERSION. Look at it with: git show v$VERSION"
  echo "To publish: git push origin v$VERSION     (to take it back before pushing: git tag -d v$VERSION)"
  exit 0
fi

BRANCH="release/$VERSION"
git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null && die "the branch $BRANCH exists"
node scripts/changelog.mjs notes Unreleased >/dev/null || die "there is nothing under \"Unreleased\" in CHANGELOG.md"

git switch -q -c "$BRANCH"
node scripts/changelog.mjs release "$VERSION" "$(date +%F)"
git add CHANGELOG.md
git commit -q -s -m "Release $VERSION"

if [ -n "${RELEASE_OFFLINE:-}" ]; then
  echo "Prepared the branch $BRANCH with the commit \"Release $VERSION\" (nothing was pushed)."
  exit 0
fi
git push -q -u origin "$BRANCH"
if [ -z "${RELEASE_NO_PR:-}" ] && command -v gh >/dev/null; then
  gh pr create --base main --head "$BRANCH" --title "Release $VERSION" \
    --body "Turns \"Unreleased\" in CHANGELOG.md into the entry of $VERSION. After merging: \`git checkout main && git pull && scripts/release.sh --tag $VERSION\`."
else
  echo "Pushed $BRANCH. Open a pull request titled \"Release $VERSION\" against main."
fi
echo "When it is merged: git checkout main && git pull && scripts/release.sh --tag $VERSION"
