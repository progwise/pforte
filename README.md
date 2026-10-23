# pforte

A small, self-hosted OpenID Connect identity service for organisations whose users are managed
by a back office rather than by self-registration.

**Documentation: <https://pforte.dev>**

**Status: early release, 0.2.0.** Sign-in with e-mail and password and a second factor by code, remembered devices, password
reset and activation links, the authorization code flow with PKCE, refresh tokens, logout, an admin API, an administration
(users, clients, claim types, audit log, CSV import), a login audit with rate limits, your own name, colours and languages,
and a Docker image all work and are tested. The image is `ghcr.io/progwise/pforte`; what changed in each release is in the
[changelog](CHANGELOG.md). While the version starts with 0, a release can break things: read the changelog before you update.

## Why another identity service

Most self-hosted identity providers assume that users sign themselves up, log in with an e-mail
address, and that the identity provider is the system of record for who exists. pforte is for
the other case:

- The list of people comes from somewhere else: an ERP, a membership system, an HR tool.
- Back-office staff create, lock and remove accounts. Version 1 has no public sign-up.
- Applications need more than "who is this": they need **claims** such as a customer number,
  a partner number or a branch code, and one person may hold several.
- The second factor is a code by SMS or e-mail, not an authenticator app, because the users are
  not technical.
- It has to run as one container next to a Postgres, on a server the organisation owns.

Keycloak can be configured to do all of this, but with a Java extension for SMS codes, a custom
theme, and an admin console nobody in the back office wants to learn. pforte does the small set
of things above and nothing else.

## What it is

- An OpenID Connect provider built on [node-oidc-provider](https://github.com/panva/node-oidc-provider),
  the certified OpenID Provider library for Node.js. The protocol comes from the library;
  pforte adds the user store, the login flow, the claims and the administration.
- One service, one Postgres database, one Docker image.
- Applications are ordinary OIDC relying parties. They never see passwords and do not know how
  the user was authenticated.

## Concepts

| Term | Meaning |
| --- | --- |
| **User** | A person with an e-mail address, a password and a phone number. E-mail is the login name and is unique. |
| **Claim** | A typed key and value attached to a user, e.g. `partner_no = 00892`. A user can hold several values of one type. Claim types are declared per client application and appear in the ID token and the userinfo response. |
| **Client** | An application that authenticates users through pforte: web app, mobile app or server. |
| **Administrator** | A user with access to the admin UI and the admin API. |
| **Source** | A system of record that keeps users and claims in sync through the admin API, e.g. an hourly import from an ERP. |

Terms used in the API and UI for the user lifecycle: **create, update, delete, lock, activate,
deactivate, reset password**. "Onboarding" is deliberately not one of them; that word belongs
to the applications.

## Planned for version 1

Protocol

- Authorization code flow with PKCE, for browser, mobile and server clients
- Refresh tokens with rotation, so a phone stays signed in
- Discovery, JWKS, userinfo, RP-initiated and back-channel logout

Login

- E-mail and password
- Second factor by SMS code, with a code by e-mail as fallback while no phone number is stored
- "Remember this device" to skip the second factor on a known device
- Password reset by SMS or e-mail code
- Activation link for new users, who set their first password on activation
- Login pages in several languages, with the organisation's name, colours and logo from configuration

Administration

- Admin API: users, claims, clients, sessions; everything the UI does
- Minimal admin UI: search, create, lock, deactivate, delete users; reset a password; see last login and open sessions
- CSV import of users with claims
- Audit log of every administrative action and every login

Operations

- Docker image, configuration by environment variables, Postgres as the only dependency
- Adapters for SMS and e-mail providers; the first ones are a European SMS gateway and SMTP
- Rate limiting on login and code requests

## Not planned

SAML, LDAP, social logins, federation to other identity providers, multi-tenancy in the UI,
passkeys, public self-registration. Some of these may come later when an application needs them; none are needed to ship.

## How an application integrates

```text
Browser / app  ──(authorization code + PKCE)──▶  pforte  ──▶  ID token with claims
                                                                   {
                                                                     "sub": "7f3e…",
                                                                     "email": "anna@example.com",
                                                                     "partner_no": ["00892"]
                                                                   }
```

The application verifies the token with the JWKS endpoint, reads the claims, and decides itself
what the user may see. pforte does not do authorization beyond "this person holds these claims".
A complete, runnable example of such an application is in
[examples/relying-party](examples/relying-party).

A system of record keeps users current:

```text
ERP ──(hourly)──▶ import job ──(admin API)──▶ pforte
                                              create or update user, set partner_no claims,
                                              lock users that disappeared
```

## Quick start

For a server: [examples/production](examples/production/README.md) runs pforte, Postgres and Caddy (automatic TLS) with
Docker Compose, with secrets as files and a read-only, unprivileged pforte. Every setting is in
[docs/configuration.md](docs/configuration.md). The image is `ghcr.io/progwise/pforte`, for amd64 and arm64; pin a version.

## Development

To run pforte from source (Node.js 22, pnpm and Docker required):

```sh
cp .env.example .env
pnpm install
pnpm dev:keys            # development signing and cookie keys
pnpm dev:up              # local Postgres
pnpm db:migrate && pnpm db:seed
pnpm dev                 # pforte on http://localhost:3300
pnpm dev:example         # example application on http://localhost:3400, sign in as
                         # anna.schmidt@example.com / dev-password
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details, and [docs/configuration.md](docs/configuration.md) for every setting.

## Roadmap

Done: the OpenID Connect provider, the admin API, CSV import, the administration, the second factor, remembered devices and
password reset, the audit log and rate limits, branding and languages, the Docker image and a production example, and the
releases 0.1.0 and 0.2.0.

Next: a page where people manage their own account ([#18](https://github.com/progwise/pforte/issues/18)), and ideas that wait
for a need: a consent screen, custom URL schemes for native apps, self-service sign-up, a first-party login API.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Contributions need
a Developer Certificate of Origin sign-off (`git commit -s`); there is no contributor agreement.
Please report security issues privately, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE). "pforte" is the name of this project; please do not use it
for forks or derived services.
