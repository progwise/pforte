# pforte

A small, self-hosted OpenID Connect identity service for organisations whose users are managed by a back office rather than by
self-registration. One container next to a Postgres, on a server you own.

[Quick start](quick-start.md) · [Run it on a server](../examples/production/README.md) · [Source on GitHub](https://github.com/progwise/pforte)

## Why another identity service

Most self-hosted identity providers assume that users sign themselves up, log in with an e-mail address, and that the identity
provider is the system of record for who exists. pforte is for the other case:

- The list of people comes from somewhere else: an ERP, a membership system, an HR tool.
- Back-office staff create, lock and remove accounts. There is no public sign-up.
- Applications need more than "who is this": they need **claims** such as a customer number, a partner number or a branch code,
  and one person may hold several.
- The second factor is a code by SMS or e-mail, not an authenticator app, because the users are not technical.
- It has to run as one container next to a Postgres, on a server the organisation owns.

Keycloak can be configured to do all of this, but with a Java extension for SMS codes, a custom theme, and an admin console nobody
in the back office wants to learn. pforte does the small set of things above and nothing else.

## What it is

- An OpenID Connect provider built on [node-oidc-provider](https://github.com/panva/node-oidc-provider), the certified OpenID
  Provider library for Node.js. The protocol comes from the library; pforte adds the user store, the login flow, the claims and
  the administration. It was run against the OpenID conformance suite without failures ([conformance](conformance.md)).
- One service, one Postgres database, one Docker image (`ghcr.io/progwise/pforte`, for amd64 and arm64).
- Applications are ordinary OIDC relying parties. They never see passwords and do not know how the user was authenticated.

## What it does

- **Sign-in**: e-mail and password, a second factor by a code sent by SMS or e-mail, "remember this device", activation links for
  new users, password reset. Pages in German, English, French and Hungarian, with your name, logo and colours
  ([branding and languages](branding-and-languages.md), [codes by SMS](sms.md)).
- **Protocol**: authorization code flow with PKCE, refresh tokens with rotation, discovery, JWKS, userinfo, RP-initiated and
  back-channel logout.
- **Administration**: users, clients, claim types, an audit log and CSV import, in the browser and through an admin API
  ([the administration](administration.md), [importing users](import.md)).
- **Safety**: rate limits on sign-in, an audit of sign-in events, security headers, and a production start that refuses weak
  secrets ([security measures](security.md), [threat model](threat-model.md)).
- **Operation**: configuration by environment variables, migrations at start, an image that runs unprivileged on a read-only
  filesystem ([configuration](configuration.md), [production with Docker Compose](../examples/production/README.md)).

## Concepts

| Term | Meaning |
| --- | --- |
| **User** | A person with an e-mail address, a password and a phone number. E-mail is the login name and is unique. |
| **Claim** | A typed key and value attached to a user, such as `partner_no = 00892`. A user can hold several values of one type. Claim types are assigned to each client application and appear in the ID token and the userinfo response. |
| **Client** | An application that authenticates users through pforte: a web app, a mobile app or a server. A *machine* is a client that calls the admin API without a person. |
| **Administrator** | A user with access to the administration and the admin API. |
| **Source** | A system of record that keeps users and claims in sync through the admin API, for example an hourly import from an ERP. |

The user lifecycle uses these words in the API and in the administration: **create, update, delete, lock, activate, deactivate,
reset password**. "Onboarding" is deliberately not one of them; that word belongs to the applications.

## How an application integrates

```text
Browser / app  ──(authorization code + PKCE)──▶  pforte  ──▶  ID token with claims
                                                                   {
                                                                     "sub": "7f3e…",
                                                                     "email": "anna@example.com",
                                                                     "partner_no": ["00892"]
                                                                   }
```

The application verifies the token with the JWKS endpoint, reads the claims, and decides itself what the user may see. pforte does
no authorization beyond "this person holds these claims". [Integrating an application](integrating-a-client.md) describes it step by
step; a complete, runnable example of such an application is in [examples/relying-party](../examples/relying-party).

A system of record keeps users current:

```text
ERP ──(hourly)──▶ import job ──(admin API)──▶ pforte
                                              create or update user, set partner_no claims,
                                              lock users that disappeared
```

## Not planned

SAML, LDAP, social logins, federation to other identity providers, multi-tenancy in the administration, passkeys, public
self-registration. Some of these may come later when an application needs them.
