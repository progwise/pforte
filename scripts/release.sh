#!/usr/bin/env bash
# Prepares a release: turns "Unreleased" in CHANGELOG.md into the entry of the version, commits that (signed off) and tags it.
# Pushing is yours: the tag starts the release workflow, which builds, tests and publishes.
# Usage: scripts/release.sh <version>      e.g. scripts/release.sh 0.1.0
set -euo pipefail

VERSION=${1:?usage: scripts/release.sh <version>  (for example 0.1.0)}
die() { echo "Not releasing: $*" >&2; exit 1; }

[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "\"$VERSION\" is not a version such as 0.1.0 or 0.2.0-rc.1"
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "this is not the main branch"
git diff --quiet && git diff --cached --quiet || die "there are uncommitted changes"
if [ -z "${RELEASE_OFFLINE:-}" ]; then
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not the same as origin/main: pull or push first"
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "the tag v$VERSION exists"

node scripts/changelog.mjs notes Unreleased >/dev/null || die "there is nothing under \"Unreleased\" in CHANGELOG.md"
node scripts/changelog.mjs release "$VERSION" "$(date +%F)"

git add CHANGELOG.md
git commit -q -s -m "Release $VERSION"
git tag -a "v$VERSION" -m "pforte $VERSION"

echo "Prepared pforte $VERSION: the changelog entry is committed and v$VERSION is tagged. Look at it with: git show v$VERSION"
echo "To publish: git push origin main v$VERSION     (to take it back before pushing: git tag -d v$VERSION && git reset --hard HEAD~1)"
