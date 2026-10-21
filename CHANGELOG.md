# Changelog

What changed in each release of pforte. Newest first. While the version starts with 0, breaking changes can happen in any
release: read the entry before you update, and back up the database first (migrations cannot be undone).

The entry of a release becomes the text of its GitHub release. Changes that are not released yet are collected under
"Unreleased" and turned into the entry of the version by `scripts/release.sh` (see [docs/releasing.md](docs/releasing.md)).

## Unreleased

## 0.1.0 (2026-10-21)

The first release.

### Added

- **OpenID Connect provider**: authorization code flow with PKCE, refresh tokens with rotation, discovery, JWKS, userinfo,
  RP-initiated and back-channel logout, claims in the ID token. Run against the OpenID conformance suite (Basic OP plan)
  without failures; certification has not been applied for ([docs/conformance.md](docs/conformance.md)).
- **Sign-in**: e-mail and password, a second factor by a code sent by e-mail or SMS (any provider with an HTTP API, see
  [docs/sms.md](docs/sms.md)), "remember this device", activation links for new users and password reset.
- **Admin API** for users, claims, claim types, clients, sessions and devices, with an OpenAPI document and an audit log of
  every change.
- **Administration** at `/manage`, in English and German: users (search, create, edit, lock, deactivate, delete, reset a
  password, end sessions, revoke devices), clients, claim types, the audit log and CSV import. It signs in like any application,
  with the second factor, and everything it does goes through the admin API under the administrator's name
  ([docs/administration.md](docs/administration.md)).
- **CSV import** of users and claims, on the command line (`pforte import`) and on a page of the administration, with a dry run,
  rejected rows with line and reason, and a plan for users who are not in the file ([docs/import.md](docs/import.md)).
- **Security**: rate limits on sign-in and codes, an audit of sign-in events, security headers, a check of where forms come
  from, and a production start that refuses weak secrets ([docs/security.md](docs/security.md),
  [docs/threat-model.md](docs/threat-model.md)).
- **Your own look and languages**: name, logo, colours, fonts and footer links from a folder, and pages, e-mails and SMS in German,
  English, French and Hungarian, with the texts you can replace ([docs/branding-and-languages.md](docs/branding-and-languages.md)).
- **Docker image** `ghcr.io/progwise/pforte` for amd64 and arm64, with the commands `start`, `migrate` and `keys`; database
  migrations are applied at start. A [configuration reference](docs/configuration.md) and a
  [production example](examples/production/README.md) with Docker Compose, Postgres and automatic TLS.
