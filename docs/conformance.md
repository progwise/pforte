# OpenID conformance tests

pforte is tested against the official [OpenID conformance suite](https://openid.net/certification/about-conformance-suite/)
(Basic OP profile). The suite acts as an application and calls pforte, so pforte has to be
reachable from the internet while a test runs. This is done with a Cloudflare tunnel to a
separate pforte instance with its own database and keys, never your development data. A test
instance that is deployed anyway serves as well ([below](#against-a-test-instance-that-is-deployed)).

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

## Against a test instance that is deployed

A test instance that is reachable anyway, for example one deployed with the
[Swarm example](../examples/swarm/README.md), needs no tunnel, and it tests pforte as it runs: the
image, in production mode, behind the proxy, with real mail. Never use an instance people rely
on: the suite's clients are weaker than a client should be (no PKCE, and a redirect address at
another site).

`pnpm conformance:setup` is not for such an instance. It makes a database of its own, refuses
to run in production mode, and gives its user a made-up phone number. Set the instance up once,
in its administration:

1. **Two clients**: *Clients → New client → Application*, with the IDs `conformance-1` and
   `conformance-2`, **Confidential**, *Require PKCE* switched off, and profile, e-mail and phone
   under *What the application may ask for*. For both, with the alias of your test plan:

   | Field | Value |
   | --- | --- |
   | Redirect URIs | `https://www.certification.openid.net/test/a/<alias>/callback` and, on a second line, the same address with `?dummy1=lorem&dummy2=ipsum` at its end |
   | After signing out, return to | `https://www.certification.openid.net/test/a/<alias>/post_logout_redirect` |

   The secret of each client is shown once, when it is created. Keep both where the secrets of
   the instance are kept.

2. **A test user**: *Users → New user* with an address whose mail you can read, then *Send
   activation link*, and choose a password from the mail. **Give it no made-up phone number.**
   Where codes go by SMS, every code of a person with a confirmed number is sent to that number.
   Without a phone number the codes come by e-mail, and the user has no `phone_number` claim;
   `oidcc-scope-phone` passed without one in the run of 2026-11-19.

The run itself is the one above, from step 3, with these differences:

- The discovery URL is `https://<the instance>/.well-known/openid-configuration`.
- The codes come by e-mail (or SMS), not into a terminal. Tick **Remember this device** yourself
  when you enter the first one.
- The rate limits of the instance are on. One person in one browser is not expected to reach
  them; if a page says "not now", wait the time it names.
- Do not deploy while a plan runs: the instance is gone for a minute.
- In the results, name the commit that is deployed. Leave the address of the instance out if it
  is not public.

**After the run.** The two secrets are in the logs of the suite, which only your account there
can read, until a plan is published. Either delete the two clients and the user, or keep them
for the next run. If you keep them, replace both secrets (*Clients* → the client → *Replace the
secret*) before the logs of a plan are shared or published, and keep the instance free of data
that matters.

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
  pforte only returns claims it holds (for example no `birthdate`, and `picture` only for a person
  who gave themselves one); inventing values would be wrong. (`email_verified` is returned since #6.)
- `oidcc-scope-email`: the e-mail is also in the ID token. Claims for the granted scopes are
  deliberately placed in the ID token so applications can read them without a second request.
- `oidcc-claims-essential`: `name` is not in the userinfo, because pforte does not support the
  `claims` request parameter (`claims_parameter_supported` is false) and ignores it, which is
  allowed. Applications get claims through scopes.
- `oidcc-alternate-happy-flow`: the same two warnings as `oidcc-scope-email` (the e-mail is also in
  the ID token; not all standard claims of the scope are returned).
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

### Since the last run

The run below is the last one, on the code of 0.3.2. Nothing merged after it changes pforte: the release adds a sentence of
documentation and the changelog entry to it.

The suite signs in with a password and a code and uses the endpoints of the provider. It does not use passkeys, the account
pages, the administration, an activation or a password reset, so a run says nothing about those; they have tests of their own.
A run is due again before the next release and before 1.0 ([#48](https://github.com/progwise/pforte/issues/48)).

### Run of 2026-11-19: no failures

The first run since the one for the first release, and the first against a test instance that is deployed
([above](#against-a-test-instance-that-is-deployed)) instead of a local instance behind a tunnel: the image built from pforte
commit `54fd9c5`, in production mode behind a proxy, with real mail, with the rate limits on and with a branding folder. That
commit is the code of 0.3.2. The address of the instance is not published here.

Plan `oidcc-basic-certification-test-plan` (id `TL2JfL0L9W71N`), suite version 5.3.4 (revision `23353b3`), variant
`server_metadata=discovery, client_registration=static_client`, alias `progwise-pforte`. The plan was started on 2026-11-19 at
09:06 (UTC) and was through within twenty minutes. The table shows the latest result of each test.

**35 tests: 24 passed, 4 warnings, 4 to review, 3 skipped, 0 failed, 0 interrupted.**

| Result | Tests |
| --- | --- |
| Passed | `server`, `response-type-missing`, `userinfo-get`, `userinfo-post-header`, `userinfo-post-body`, `ensure-request-without-nonce-succeeds-for-code-flow`, `scope-phone`, `display-page`, `display-popup`, `prompt-none-not-logged-in`, `prompt-none-logged-in`, `max-age-10000`, `ensure-request-with-unknown-parameter-succeeds`, `id-token-hint`, `login-hint`, `ui-locales`, `claims-locales`, `ensure-request-with-acr-values-succeeds`, `codereuse`, `codereuse-30seconds`, `ensure-post-request-succeeds`, `server-client-secret-post`, `refresh-token`, `ensure-request-with-valid-pkce-succeeds` |
| Warning (accepted, see above) | `scope-profile`, `scope-email`, `alternate-happy-flow`, `claims-essential` |
| Review | `prompt-login`, `max-age-1`, `ensure-registered-redirect-uri`, `ensure-request-object-with-redirect-uri` |
| Skipped | `scope-address`, `scope-all`, `unsigned-request-object-supported-correctly-or-rejected-as-unsupported` |

Every test ended as it did in the run of 2026-10-20. So nothing that was merged in between changed a result on the paths the
suite takes. That covers the releases 0.2.0 to 0.3.2, for which no run had been made: among other things the logout token for
applications, `auth_time` in the ID tokens of the two built-in clients, passkeys as a second way in, `prompt=login` for another
person than the one signed in, and in 0.3.2 the parameter `color_scheme` and the language of the sign-out pages.

Two things about this run:

- `prompt-none-not-logged-in` failed at the first attempt, because the browser still had its session at pforte (see the
  [tips](#tips-for-a-run)), and passed when it was repeated in a window without one.
- The test user had no phone number, so the codes came by e-mail. `scope-phone` passed all the same.

The four tests marked *review* only need a human to look at evidence (screenshots of the login page or of an error page); they are
required for a formal certification submission, which has not been made. The suite's "private link" for the plan is not published
here, because the logs contain the credentials of the test clients.

### Run of 2026-10-20: no failures

The run for the first release: a complete run on pforte commit `16970cc`, the head of `main` when it started. The release
adds only the changelog entry to it, so the image is built from this code.

Plan `oidcc-basic-certification-test-plan` (id `CbyR5vcTxLfZR`), suite version 5.3.3 (revision `7d420f7`), variant
`server_metadata=discovery, client_registration=static_client`, alias `progwise-pforte`, issuer `https://conformance.pforte.dev`.
The plan was started on 2026-10-20 at 18:46 (Berlin time); some tests were run on the following day. The table shows the latest
result of each test.

**35 tests: 24 passed, 4 warnings, 4 to review, 3 skipped, 0 failed, 0 interrupted.**

| Result | Tests |
| --- | --- |
| Passed | `server`, `response-type-missing`, `userinfo-get`, `userinfo-post-header`, `userinfo-post-body`, `ensure-request-without-nonce-succeeds-for-code-flow`, `scope-phone`, `display-page`, `display-popup`, `prompt-none-not-logged-in`, `prompt-none-logged-in`, `max-age-10000`, `ensure-request-with-unknown-parameter-succeeds`, `id-token-hint`, `login-hint`, `ui-locales`, `claims-locales`, `ensure-request-with-acr-values-succeeds`, `codereuse`, `codereuse-30seconds`, `ensure-post-request-succeeds`, `server-client-secret-post`, `refresh-token`, `ensure-request-with-valid-pkce-succeeds` |
| Warning (accepted, see above) | `scope-profile`, `scope-email`, `alternate-happy-flow`, `claims-essential` |
| Review | `prompt-login`, `max-age-1`, `ensure-registered-redirect-uri`, `ensure-request-object-with-redirect-uri` |
| Skipped | `scope-address`, `scope-all`, `unsigned-request-object-supported-correctly-or-rejected-as-unsupported` |

Compared with the run of 2026-10-16, this one has the second factor (#6) in every sign-in, and the ID token carries `acr`, `amr`
and `email_verified`. `ensure-request-with-acr-values-succeeds` therefore moved from warning to passed. The four tests marked
*review* only need a human to look at evidence (screenshots of the login page or of an error page); they are required for a formal
certification submission, which has not been made. The suite's "private link" for the plan is not published here, because the logs
contain the generated test credentials.

### Earlier run of 2026-10-16: no failures

This run predates the second factor (#6) and is superseded by the run above.

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
