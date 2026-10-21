# Security measures

What pforte does about the web's usual attacks, and what it asks of the operator. For limits on trying to sign in
see [rate limits](rate-limiting.md), for what is recorded [the audit log](audit-log.md), and for what is and is not defended
the [threat model](threat-model.md).

## Response headers

Every response, from the pages to the admin API and the OpenID endpoints, carries:

| Header | Why |
| --- | --- |
| `X-Content-Type-Options: nosniff` | A browser must not guess that data is a script or a page. |
| `Referrer-Policy: no-referrer` | An address with a token in it (the activation link) is not passed on when a link is followed. |
| `X-Frame-Options: DENY` | Nothing of pforte can be shown in a frame, so nothing can be clicked invisibly. |
| `Permissions-Policy` | Camera, microphone, location, payment and USB are switched off; pforte needs none. |
| `Strict-Transport-Security: max-age=31536000` | Only when `ISSUER` is https: for a year browsers use https for this host only. It has no `includeSubDomains` and no `preload`: those would bind the other services on your domain, which is your decision. |

The pages with forms add a strict **Content-Security-Policy**: no scripts at all, styles only from the one stylesheet in
the page, fonts and the logo only from pforte itself, no framing, no `<base>`. They also send `Cache-Control: no-store`.

Two headers are left out on purpose:

- **`Cross-Origin-Opener-Policy`.** With `same-origin` an application that opens the sign-in in a popup loses its link
  to that popup, and popup sign-ins are part of OpenID Connect (`display=popup`).
- **A global Content-Security-Policy.** The provider's own logout page needs inline styles and script. Our pages have
  their own policy.

## Forms only from pforte's own pages

A form of pforte is only ever submitted from a page of pforte. A POST to the sign-in, code, reset or activation pages
whose browser says it came from somewhere else (`Sec-Fetch-Site` is not `same-origin`, or `Origin` is not the `ISSUER`)
is refused with 403 before anything happens: no password is checked, no code sent, no counter changed. A request that says
neither is not a browser (curl, a script) and cannot be tricked by a page, so it passes. This is on top of the
`SameSite=Strict` cookies of pforte's own steps, and needs no token in the forms and no JavaScript.

Links that lead to pforte from other places (the activation link in an e-mail) are GETs and are not affected. The
endpoints of the OpenID provider (`/auth`, `/token`, …) are called by applications from their own sites and are not
affected either.

## Cookies

| Cookie | Holds | Flags |
| --- | --- | --- |
| `pforte_second_factor` | The step between password and code: user, sign-in, language, time. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 15 minutes, only for that sign-in's path |
| `pforte_phone_step` | The step of confirming a phone after activation. Signed. | like the above, 30 minutes, path `/activate` |
| `pforte_device` | Tokens of remembered devices. Their hashes are in the database. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 90 days |
| `_session`, `_interaction`, … | The provider's own: the single sign-on session and the open sign-in. Signed with `COOKIE_KEYS`. | `HttpOnly`, `Secure` (https). `SameSite=None` over https, because OpenID Connect requires the authorization endpoint to accept POST; `Lax` over http |

A test signs in over https and checks that every cookie has `HttpOnly`, `Secure` and a `SameSite` value.

## Weak secrets stop a production start

With `NODE_ENV=production` pforte checks its configuration and refuses to start, listing **every** problem at once so they
can be fixed in one go (the messages say what to change, never what the secret is):

- `ISSUER` is not https.
- The password in `DATABASE_URL` is empty or a well-known default (`pforte`, `postgres`, `password`, …).
- A key in `COOKIE_KEYS` has fewer than 12 different characters (`kkkkkkkk…`).
- A signing key in `JWKS` is RSA below 2048 bits, an EC key on another curve than P-256, P-384 or P-521, or another type.
- Neither `SMTP_URL` nor `MAIL_FROM` is set: every sign-in needs a code, so nobody could sign in.
- A client still has the secret `dev-secret`, or a user at `example.com` the password `dev-password` (both come from the
  development seed). Rotate or delete them: `POST /admin/clients/{id}/rotate-secret`.

Without `NODE_ENV=production` the same findings are only a warning in the log at startup, so development stays easy.

Secrets come from the environment or from files (`NAME_FILE`, for Docker and Kubernetes secrets). Setting both is an error.

## Logs

The request log hides the values of sensitive parameters in addresses: the token of an activation link, e-mail addresses
(`email`, `login_hint`), `id_token_hint`, codes and secrets appear as `REDACTED`. Passwords, codes and tokens are not logged
anywhere else either. Sign-in events in the audit log keep an address that no user has only as a hash.

Everything in pforte's log can contain client addresses (`remoteAddress`), which are personal data in many places. Keep the
logs as short as your obligations allow.

## Dependencies

- Versions are **pinned exactly** and the lock file is installed as it is in CI (`--frozen-lockfile`).
- The workflow `audit.yml` runs `pnpm audit` on every push and pull request and **every Monday**. For what pforte ships
  (`--prod`) it **fails on moderate or worse**. A second run covers the development tools and only informs.
- **Dependabot** proposes updates weekly. A new release waits **14 days** before a pull request is opened, so one that turns
  out to be malicious or broken has time to be found; security fixes are not delayed. The pull requests of Dependabot are
  exempt from the sign-off check, as it cannot sign off.
- **The image** is built, started against a fresh Postgres and scanned by the workflow `image.yml` on every pull request and
  push and **every Monday**. The scan (Trivy) fails on high or critical findings that have a fix, in the operating system
  packages of the base image and in the Node packages. Accepted findings go into `.trivyignore`, each with its reason and a date
  to look at it again. The base image is pinned by digest, and Dependabot proposes new ones (after the same 14 days).
- **The repository** protects `main` with rules: changes arrive only through pull requests, which can be merged when `check`,
  `dependencies`, `image` and `signoff` have passed, with linear history, and no force-push or deletion. Tags `v*`, which start
  a release and publish the image, can only be created by administrators and cannot be moved or deleted without that right.
  Administrators can bypass the checks of a pull request in an emergency, but not push to `main`.
- **Accepted advisory:** `GHSA-67mh-4wv8-2f99` (moderate), in `esbuild` through `drizzle-kit`, a tool that writes database
  migrations during development. It is not part of what runs in production. It stays accepted until `drizzle-kit` ships a
  fix, and is checked again each time it is updated.
