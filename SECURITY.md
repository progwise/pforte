# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/progwise/pforte/security/advisories/new)
or by e-mail to security@progwise.net.

Include what you found, how to reproduce it, and which version or commit is affected.
You will get an acknowledgement within three working days and a status update when the
problem is confirmed, fixed or rejected. We credit reporters in the release notes unless
they prefer not to be named.

## Supported versions

pforte is in the design phase and has no releases yet. Once released, the latest minor
version receives security fixes.

## Scope

In scope: this repository, the published Docker image and the npm packages under the
`@progwise` scope that belong to pforte.

Out of scope: the OpenID Connect protocol implementation itself, which comes from
[node-oidc-provider](https://github.com/panva/node-oidc-provider). Please report issues in
that library to its maintainers.
