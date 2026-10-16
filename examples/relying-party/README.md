# Example relying party

A minimal web application that signs users in with pforte. It shows what an application needs
to do, in one file ([src/server.ts](src/server.ts)):

1. Send the browser to pforte with the authorization code flow and PKCE.
2. On the way back, exchange the code for tokens. The library checks the state, the nonce, the
   PKCE verifier and the ID token's signature.
3. Read the claims (for example `partner_no`) from the ID token and the userinfo endpoint.
4. Refresh the tokens. Refresh tokens rotate, so the application keeps the newest one.
5. Sign out at pforte, which revokes this session's refresh tokens.

It uses the standard [`openid-client`](https://github.com/panva/openid-client) library and
nothing specific to pforte, so the same code works with any OpenID provider. Sessions are
in memory; a real application needs a session store.

## Run it

From the repository root, with the setup from [CONTRIBUTING.md](../../CONTRIBUTING.md) done
(`pnpm dev:keys`, `pnpm dev:up`, `pnpm db:migrate`, `pnpm db:seed`):

```sh
pnpm dev            # pforte on http://localhost:3300
pnpm dev:example    # this application on http://localhost:3400
```

Open <http://localhost:3400>, choose **Sign in** and use `anna.schmidt@example.com` with the
password `dev-password`. The seed registers this application as the public client `demo-web`
with the redirect `http://localhost:3400/callback`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ISSUER` | `http://localhost:3300` | Where pforte runs |
| `CLIENT_ID` | `demo-web` | The client registered in pforte |
| `PORT` | `3400` | Port of this application; the redirect URI must match the client registration |

`demo-web` is a public client (no secret). Plain `http` for the issuer is accepted only for
local development.
