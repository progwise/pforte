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
nothing specific to pforte for this, so the same code works with any OpenID provider. Sessions are
in memory; a real application needs a session store.

## Things to try

The page of the application is also a place to try pforte from, made for a phone: nothing has to be typed.

- **Two switches** for what the application tells pforte: the look (`color_scheme`: `light`, `dark`, `auto` or
  nothing) and the language (`ui_locales`: one of the languages pforte offers, or nothing). The choice is kept in the
  browser and sent with the sign-in and the sign-out. The application itself is as light or dark as it says.
- **A button for each thing to try**, with a line on what to look at: signing in and out, refreshing the tokens, and
  pforte's own pages (the account pages, the administration, the page to set or reset the password). These links
  are the one part that knows pforte; they carry the look that is chosen.

## Run it

From the repository root, with the setup from [CONTRIBUTING.md](../../CONTRIBUTING.md) done
(`pnpm dev:keys`, `pnpm dev:up`, `pnpm db:migrate`, `pnpm db:seed`):

```sh
pnpm dev            # pforte on http://localhost:3300
pnpm dev:example    # this application on http://localhost:3400
```

Open <http://localhost:3400>, choose **Sign in** and use `anna.schmidt@example.com` with the
password `dev-password`, then enter the 6-digit code that pforte sends by e-mail (in development
you find it in Mailpit at <http://localhost:8026>, or in the pforte log when `SMTP_URL` is not set).
The seed registers this application as the public client `demo-web`
with the redirect `http://localhost:3400/callback`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ISSUER` | `http://localhost:3300` | Where pforte runs |
| `CLIENT_ID` | `demo-web` | The client registered in pforte |
| `PORT` | `3400` | Port of this application |
| `UI_LOCALES` | none | The language the application asks pforte's pages to be in, for example `de` or `fr hu`, until the switch on its page is used. Sent as `ui_locales` with the sign-in and with the sign-out. Without it pforte chooses by the person and the browser |
| `COLOR_SCHEME` | none | Whether the application is `light` or `dark`, until the switch on its page is used. Sent as `color_scheme` with the sign-in and with the sign-out; pforte's pages then look like it and stay so in that browser. Without it pforte's pages follow the device, or what an application said before |
| `BASE_URL` | `http://localhost:<PORT>` | The address people reach it under, if that is not where it listens (behind a proxy). The redirect URI of the client registration is `<BASE_URL>/callback` |

`demo-web` is a public client (no secret). Plain `http` for the issuer is accepted only for
local development.

## On a server

[`Dockerfile`](Dockerfile) builds the application as an image (from the root of the repository), and
[examples/swarm](../swarm/README.md) deploys it next to pforte under a name of its own. The application has a web
manifest, so a phone can put it on its home screen and start it in a window of its own: a way to try how signing
in at pforte behaves from there.
