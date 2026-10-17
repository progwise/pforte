# OpenID conformance tests

pforte is tested against the official [OpenID conformance suite](https://openid.net/certification/about-conformance-suite/)
(Basic OP profile). The suite acts as an application and calls pforte, so pforte has to be
reachable from the internet while a test runs. This is done with a Cloudflare tunnel to a
separate pforte instance with its own database and keys, never your development data.

The suite cannot run in CI. A run is manual, takes about an hour, and is repeated before a
release.

## One-time setup

1. **A Cloudflare tunnel** for `conformance.pforte.dev` pointing at `http://localhost:3301`. The
   domain must use Cloudflare DNS.

   ```sh
   brew install cloudflared
   cloudflared tunnel login
   cloudflared tunnel create pforte-conformance
   cloudflared tunnel route dns pforte-conformance conformance.pforte.dev
   ```

   Then create `~/.cloudflared/config.yml` (replace `<UUID>` with the tunnel's id):

   ```yaml
   tunnel: <UUID>
   credentials-file: /Users/<you>/.cloudflared/<UUID>.json
   ingress:
     - hostname: conformance.pforte.dev
       service: http://localhost:3301
     - service: http_status:404
   ```

   Never commit anything from `~/.cloudflared`; the credentials file is a login for the tunnel.

2. **An account on the suite**: sign in at <https://www.certification.openid.net> with a Google
   or GitLab account.

## Each run

1. Start the local Postgres and prepare the conformance instance. This creates the separate
   database `pforte_conformance`, `.env.conformance` with fresh keys, and the clients and test
   user the suite needs. It prints their values, new on every run.

   ```sh
   pnpm dev:up
   pnpm conformance:setup
   ```

2. Start pforte for the suite and the tunnel, each in its own terminal:

   ```sh
   pnpm conformance:start
   cloudflared tunnel run pforte-conformance
   ```

   Check <https://conformance.pforte.dev/.well-known/openid-configuration> in a browser.

3. In the suite choose **Create a new test plan** and the plan *OpenID Connect Core: Basic
   Certification Profile Authorization server test*. Variants: `client_secret_basic`, response
   type `code`, server metadata `discovery`, static client registration. Enter the values printed
   by `pnpm conformance:setup`: the alias, the discovery URL, client 1 and client 2 with their
   secrets, and for the `client_secret_post` client use client 1 again (pforte accepts the secret
   in either place).

4. Run the tests one by one. Read the blue box at the top of each test; most only need you to
   sign in on pforte's login page with the printed test user. Some tests need a screenshot.

   Signing in has a second step: pforte asks for a 6-digit code. The conformance instance has no
   mail or SMS, so it writes the code to the terminal where `pnpm conformance:start` runs, in a
   line with `[development notifier] Sign-in code for …`. Copy the code from there. To find it
   among the other log lines, start pforte through a filter instead:

   ```sh
   pnpm conformance:start 2>&1 | grep --line-buffered 'development notifier'
   ```

   Tick **Remember this device** when you enter the first code (`conformance:start` ticks it by
   default). The suite runs all tests in the same browser, so later sign-ins ask for the password
   only. If you delete the cookies of `conformance.pforte.dev`, the next sign-in asks for a code
   again.

5. Stop the tunnel and pforte when you are done. The conformance instance has no rate limiting
   yet, so do not leave it running.

## Tips for a run

- The second factor is part of every sign-in, including the tests that need a new sign-in
  (`oidcc-prompt-login`, `oidcc-max-age-1`): with a remembered device they ask for the password
  only, the others show the code step. The ID token then carries `acr` `urn:pforte:acr:pwd` and
  `amr` `["pwd"]` for a remembered device, and `urn:pforte:acr:mfa` and `["pwd","otp"]` after a code.

- The suite runs all tests in the same browser, so pforte's session cookie stays between tests.
  This is intended for most tests, but `oidcc-prompt-none-not-logged-in` asks you to remove the
  provider's cookies first, and it fails with "expected an error but got a code" otherwise. Run
  that test in a private window, or delete the cookies of `conformance.pforte.dev` before it.
- Restart `pnpm conformance:start` after every code change; the instance does not reload itself.
- Do not run other commands that stop or start pforte on port 3301 while a plan is running.
- Test `oidcc-max-age-1` needs the previous sign-in to be more than a couple of seconds old
  (the library compares whole seconds).

## Accepted warnings

Warnings are accepted for certification. These are known and intended:

- `oidcc-scope-profile`, `oidcc-scope-email`: not all standard claims of the scope are returned.
  pforte only returns claims it holds (for example no `picture` or `birthdate`); inventing values
  would be wrong. (`email_verified` is returned since #6.)
- `oidcc-scope-email`: the e-mail is also in the ID token. Claims for the granted scopes are
  deliberately placed in the ID token so applications can read them without a second request.
- `oidcc-claims-essential`: `name` is not in the userinfo, because pforte does not support the
  `claims` request parameter (`claims_parameter_supported` is false) and ignores it, which is
  allowed. Applications get claims through scopes.
- `oidcc-alternate-happy-flow`: the same two warnings as `oidcc-scope-email` (the e-mail is also in
  the ID token; not all standard claims of the scope are returned).
- `oidcc-ensure-request-with-acr-values-succeeds`: in the run below the request succeeded, but pforte
  returned no `acr` claim although `acr_values` were requested (a SHOULD). Since #6 pforte returns `acr`
  and `amr` and advertises `acr_values_supported`, so this warning is expected to be gone in the next
  run. If it is not, record why here.
- `oidcc-scope-address`, `oidcc-scope-all`: skipped, because pforte does not support the
  `address` scope (`scope-all` includes it).
- `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported`: skipped,
  because pforte does not support request objects (`request_parameter_supported` is false).

## PKCE and the suite's clients

pforte requires PKCE (S256) for every client by default. The suite's Basic profile does not send
PKCE, which OpenID Connect Core makes optional for confidential clients. The conformance seed
therefore registers its two clients with `pkce_required = false`. This is a per-client setting
that an administrator can also use for older applications that cannot send PKCE. Public clients
always require PKCE; the database enforces it. A client that is not required to send a challenge
but does is still verified.

## The https requirement

OpenID Connect requires the authorization endpoint to accept POST as well as GET. A POST comes
from the application's site, so pforte's session cookie must be sent cross-site: `SameSite=None`,
which browsers only accept together with `Secure`. pforte therefore enables POST and sets that
cookie attribute when the issuer is an https URL, which every real deployment uses. For the http
issuer of local development, POST stays off.

## Reading results

`PASSED`, `REVIEW`, `WARNING` and `SKIPPED` are acceptable; `FAILED` and `INTERRUPTED` are not.
Keep the link to each test's log. Record the outcome of each run below.

## Results

### Run of 2026-10-16: no failures

This run predates the second factor (#6). The sign-in now has a code step, and the ID token has `acr`,
`amr` and `email_verified`, so the next run should be a full one; update the lists above with what it shows.

Plan `oidcc-basic-certification-test-plan`, suite version 5.3.3, variant
`server_metadata=discovery, client_registration=static_client`, alias `progwise-pforte`,
issuer `https://conformance.pforte.dev`. The table shows the latest result of each test; tests
were repeated while the gaps listed below were fixed, so this was not one uninterrupted pass. The
final code is pforte commit `1f7811a`. A clean full run is repeated before each release.

**35 tests: 23 passed, 5 warnings, 4 to review, 3 skipped, 0 failed, 0 interrupted.**

| Result | Tests |
| --- | --- |
| Passed | `server`, `response-type-missing`, `userinfo-get`, `userinfo-post-header`, `userinfo-post-body`, `ensure-request-without-nonce-succeeds-for-code-flow`, `scope-phone`, `display-page`, `display-popup`, `prompt-none-not-logged-in`, `prompt-none-logged-in`, `max-age-10000`, `ensure-request-with-unknown-parameter-succeeds`, `id-token-hint`, `login-hint`, `ui-locales`, `claims-locales`, `codereuse`, `codereuse-30seconds`, `ensure-post-request-succeeds`, `server-client-secret-post`, `refresh-token`, `ensure-request-with-valid-pkce-succeeds` |
| Warning (accepted, see above) | `scope-profile`, `scope-email`, `alternate-happy-flow`, `ensure-request-with-acr-values-succeeds`, `claims-essential` |
| Review | `prompt-login`, `max-age-1`, `ensure-registered-redirect-uri`, `ensure-request-object-with-redirect-uri` |
| Skipped | `scope-address`, `scope-all`, `unsigned-request-object-supported-correctly-or-rejected-as-unsupported` |

The four tests marked *review* only need a human to look at evidence (screenshots of the login
page or of an error page). They are required for a formal certification submission, which has
not been made. The suite's "private link" for the plan is not published here, because the logs
contain the generated test credentials.

### What the run found and fixed

The first runs exposed gaps that unit tests had missed, all fixed with tests:

- PKCE was required for every client, but the suite's confidential clients do not send it. It is
  now a per-client setting (`pkce_required`, default on; always on for public clients).
- A browser that was already signed in and asked for more scopes was sent to a consent page that
  does not exist. The grant is now extended, and `prompt=consent` is accepted automatically.
- The authorization endpoint did not accept POST, which OpenID Connect requires. It does now, for
  https issuers (it needs a `SameSite=None; Secure` session cookie).
- `login_hint` is used to prefill the e-mail field.
