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

5. Stop the tunnel and pforte when you are done. The conformance instance has no rate limiting
   yet, so do not leave it running.

## Reading results

`PASSED`, `REVIEW`, `WARNING` and `SKIPPED` are acceptable; `FAILED` and `INTERRUPTED` are not.
Keep the link to each test's log. Record the outcome of each run below.

## Results

No run recorded yet.
