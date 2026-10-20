# Releasing

For maintainers. A release is a tag `vX.Y.Z` on `main`. Pushing it starts the workflow `release.yml`, which does everything else.

## Before

- Everything for the release is merged and CI is green on `main`.
- The OpenID conformance suite was run again against `main` ([conformance](conformance.md)); it cannot run in CI.
- The section **Unreleased** of [CHANGELOG.md](../CHANGELOG.md) says what changed, in words an operator understands, and says
  clearly what **breaks**: a renamed or removed variable, a changed admin API, a change that needs action before updating.
- After the very first release only: in [README.md](../README.md) and
  [examples/production/README.md](../examples/production/README.md) remove the sentences that say there is no published image yet.

## Cut it

```bash
scripts/release.sh 0.1.0      # checks that main is clean and current, turns "Unreleased" into "0.1.0 (date)", commits and tags
git show v0.1.0               # look at what will go out
git push origin main v0.1.0   # this starts the release
```

Taking it back before pushing: `git tag -d v0.1.0 && git reset --hard HEAD~1`.

## What the workflow does

1. Runs the checks of CI and the dependency audit again, for this commit.
2. Refuses a tag that is not on `main`, and one without an entry in the changelog.
3. Builds the image, starts it against a fresh Postgres ([smoke test](../scripts/smoke-test-image.sh)), starts the
   [production example](../examples/production/README.md) with it, and scans it for known vulnerabilities (high and critical
   findings that have a fix stop the release; see [security](security.md#dependencies)).
4. Builds it for amd64 and arm64 and pushes `ghcr.io/progwise/pforte` with the tags `1.2.3`, `1.2`, `1` and `latest`
   (for `0.x`: `0.1.0` and `0.1`, and `latest`), with an SBOM and a provenance attestation.
5. Starts the pushed image by its digest and runs the smoke test again, and checks that the arm64 image starts.
6. Signs an attestation of where the image comes from, and creates the **GitHub release** with the changelog entry as its text.

The release is the last step: if anything fails before it, there is no release, and the workflow can be run again.

**Rehearsing.** *Actions → Release → Run workflow* with a version does the same without publishing anything: it builds both
platforms, tests and scans, and takes the notes from "Unreleased" if the version has no entry yet.

**Pre-releases.** A tag such as `v0.2.0-rc.1` makes a pre-release on GitHub. It gets no `latest` and no `0.2` tag.

## Verifying an image

```bash
gh attestation verify oci://ghcr.io/progwise/pforte:0.1.0 --owner progwise
docker buildx imagetools inspect ghcr.io/progwise/pforte:0.1.0     # platforms, SBOM and provenance
```

## Versions

[Semantic versioning](https://semver.org). While the version starts with `0`, a minor release (`0.2.0`) may break things and a patch
release (`0.1.1`) only fixes. From `1.0.0` a breaking change means a new major version. These count as breaking:

- an environment variable that is renamed, removed or changes its meaning ([configuration](configuration.md)),
- a change of the admin API that clients of it must follow (the OpenAPI document is the contract),
- a change in the claims or tokens that applications receive,
- a migration that needs action before it can run.

Migrations only go forward: there is no downgrade. That is why the update instructions say "back up first".

## If something goes wrong

- **The workflow fails before the release exists**: fix it and run the failed workflow again, or delete the tag
  (`git push origin :refs/tags/v0.1.0`) and cut it again.
- **A published version is bad**: do not reuse its number. Publish a fixed version, and say in its changelog entry what was wrong.
  A GitHub release can be edited to warn about the version; an image can be deleted in the package settings.
