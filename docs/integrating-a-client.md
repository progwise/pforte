# Integrating an application

pforte is a standard OpenID Connect provider. An application sends people to pforte with the **authorization code flow and PKCE**,
and gets back an **ID token** with claims about the person. Nothing on this page is specific to pforte: any OpenID Connect library
works. The page shows what the example application does, how to register your own, what the tokens contain, and what pforte decides.

## See it work first

Follow the [quick start](quick-start.md) up to the point where `pnpm dev` and `pnpm dev:example` run, open
<http://localhost:3400>, choose **Sign in**, use `anna.schmidt@example.com` with `dev-password`, and enter the code from Mailpit
(<http://localhost:8026>). The example application then shows what it received from pforte:

```json
{
  "sub": "01a14558-a5a4-71b4-931f-387c4736542a",
  "email": "anna.schmidt@example.com",
  "email_verified": true,
  "acr": "urn:pforte:acr:mfa",
  "amr": ["pwd", "otp"],
  "partner_no": ["00892"],
  "name": "Anna Schmidt",
  "given_name": "Anna",
  "family_name": "Schmidt",
  "locale": "de",
  "nonce": "dEkth8gBUKCOZPQVTboafxxfIamGvyyE8LcT_LnOAIg",
  "aud": "demo-web",
  "exp": 1792594709,
  "iat": 1792591109,
  "iss": "http://localhost:3300"
}
```

Below the ID token it shows the response of the userinfo endpoint, and has buttons to refresh the tokens and to sign out.

## What the example does

All of it is in one file, [examples/relying-party/src/server.ts](../examples/relying-party/src/server.ts), with the standard
[`openid-client`](https://github.com/panva/openid-client) library.

**1. Discovery.** The application only needs the address of pforte (the issuer) and its own client ID. Every endpoint and the keys
come from `<issuer>/.well-known/openid-configuration`.

```ts
const config = await client.discovery(issuer, clientId, undefined, client.None())
```

**2. Sign-in.** The application makes a one-time secret (the PKCE *verifier*), a `state` and a `nonce`, keeps them in the user's
session, and redirects the browser to pforte with the *challenge*, the SHA-256 of the verifier:

```ts
const authorizationUrl = client.buildAuthorizationUrl(config, {
  redirect_uri: redirectUri,
  scope: 'openid profile',
  code_challenge: await client.calculatePKCECodeChallenge(verifier),
  code_challenge_method: 'S256',
  state,
  nonce,
})
```

pforte asks for the password and the code. This is its page, not the application's: the application never sees a password.

**3. Callback.** pforte redirects back with a `code`. The application exchanges it for tokens and sends the verifier along, which
proves that it is the one that started the sign-in. The library checks `state`, `nonce`, the verifier, the signature of the ID token
and its claims.

```ts
const tokens = await client.authorizationCodeGrant(config, url, {
  pkceCodeVerifier: verifier,
  expectedState: state,
  expectedNonce: nonce,
  idTokenExpected: true,
})
```

**4. Claims.** `tokens.claims()` are the claims of the ID token, and `client.fetchUserInfo(...)` returns them from the userinfo
endpoint. They are the same ones (except for what is only meaningful in a token).

**5. Refresh and sign-out.** The application refreshes tokens before they expire and keeps the newest refresh token. To sign out
it redirects to pforte's end-session endpoint, which ends the session and revokes the refresh tokens of it.

## Register your application

In the administration open *Clients → New client → Application* ([the administration](administration.md)). It asks for:

| Setting | What to know |
| --- | --- |
| Public or confidential | **Public** for an application that cannot keep a secret: a browser or mobile app. **Confidential** for one that runs on a server: it gets a secret, shown once, and uses it at the token endpoint. |
| Start address | Where your application starts, for example `https://app.example.com/`. Optional, `https` only (`http` for `localhost`). When a person has chosen their password from an activation link, or has reset it, the last page of pforte shows a button *Continue to your application* that leads here, because the mail is often opened on another device than the application. It is not a redirect URI: it carries no code or token, and your application starts its own sign-in. Only this registered address is ever linked. In the Admin API it is `clientUri`. |
| Redirect URIs | Where pforte may send the browser back. They must match **exactly** (scheme, host, port, path, a trailing slash). `https` only; `http` is allowed for `localhost`, `127.0.0.1` and `[::1]` during development. No wildcards, no fragments. |
| After signing out, return to | The addresses the application may name as `post_logout_redirect_uri`, again exactly. |
| Scopes | `openid` is always there. `profile` adds the name and language, `email` the address (it is part of `openid` anyway), `phone` the mobile number. |
| Refresh tokens | Whether the application may stay signed in with refresh tokens. Usually yes. |
| Back-channel logout | An address pforte calls when the person signs out ([signing out](#signing-out)). |
| PKCE | Always on for public clients. A confidential client that cannot do PKCE can be allowed without it, as a last resort. |

Then, on the page of the client, tick the **claim types** it receives: an application only ever gets the claims you assign to it. In
your library you configure the issuer address, the client ID (and the secret, for a confidential client), and the redirect URI.
The same can be done with the admin API (`POST /admin/clients`; the OpenAPI document is at `/admin/openapi.json`).

## What your application receives

### The ID token

| Claim | Meaning |
| --- | --- |
| `iss`, `aud`, `exp`, `iat` | Who issued it (the issuer address, exactly), for whom (your client ID), and when it was issued and expires. The ID token is valid for one hour. |
| `sub` | The person's permanent ID, a UUID. **Use it as the key of your own records**: the e-mail address can change. |
| `nonce` | The value you sent. It must be the same. |
| `email`, `email_verified` | The address; `true` once the person has received and entered a code sent to it. Always present. |
| `acr`, `amr` | How the person signed in, see below. Always present. |
| `name`, `given_name`, `family_name`, `locale` | With the scope `profile`. `locale` is the person's language. |
| `phone_number`, `phone_number_verified` | With the scope `phone`, if the person has a mobile number. |
| Your claim types | The claim types assigned to the client, such as `partner_no`. A type that holds several values per person is an **array** (`"partner_no": ["00892", "01234"]`), another is a string. A claim the person has no value for is left out. |
| `auth_time` | When the person last signed in, if you asked for `max_age`. |

The userinfo endpoint returns the same claims without those of the token itself (`acr`, `amr`, `nonce` and so on).

**`acr` and `amr`** tell you whether a second factor was used for this sign-in:

| `acr` | `amr` | Meaning |
| --- | --- | --- |
| `urn:pforte:acr:mfa` | `["pwd", "otp"]` | The password and a code from an e-mail or an SMS, entered now. |
| `urn:pforte:acr:pwd` | `["pwd"]` | The password only: the person's browser is remembered and skips the code. |

You can ask for the stronger one, see [asking for more](#asking-for-more).

### The access token

An opaque string, valid for one hour (`expires_in` says so), which is good for one thing: calling pforte's userinfo endpoint. It is
**not a JWT**, so do not try to decode it, and pforte has no introspection endpoint. Let your backend create its own session from a
verified ID token. If an API must know who calls it with a bearer token, it can call the userinfo endpoint with that token.

### Refresh tokens

An application that may use refresh tokens gets one with the first tokens, and each refresh returns **a new refresh token** and
a new ID token. Two rules follow:

- **Always keep the newest one.** Using an old refresh token again is taken as a theft and **revokes the whole sign-in**: the old
  and the new token stop working, and the person must sign in again.
- **Refresh in one place at a time.** Two processes that refresh with the same token at once look like a reuse.

An answer of `invalid_grant` means: sign in again. It is also what a refresh gets when the person was locked or deactivated.

## Checks when you verify tokens yourself

A library does all of this. If you verify an ID token without one:

1. Check the signature with the key of the **JSON Web Key Set** at `<issuer>/jwks`, chosen by the `kid` in the token header. The
   algorithm is `RS256`. Cache the keys, and fetch them again when a token names a `kid` you do not have: pforte can rotate its keys,
   and publishes the old ones until they have been retired.
2. `iss` must be the issuer, exactly. `aud` must contain your client ID. `exp` must be in the future.
3. `nonce` must be the one you sent. On the callback, `state` must be the one you sent.

With [`jose`](https://github.com/panva/jose):

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'

const keys = createRemoteJWKSet(new URL(`${issuer}/jwks`))
const { payload } = await jwtVerify(idToken, keys, { issuer, audience: clientId })
if (payload.nonce !== expectedNonce) throw new Error('The nonce does not match')
```

## Signing out

**Signing out at pforte.** Redirect the browser to the `end_session_endpoint` (`/session/end`) with `id_token_hint` (the ID token)
and `post_logout_redirect_uri` (registered for the client). pforte asks the person to confirm, ends the browser's session, revokes the
refresh tokens of it, and sends the browser back.

**Back-channel logout.** If the client has a back-channel logout address, pforte sends a `logout_token` (a signed JWT with the
`sid` of the session) to it with a POST when the person signs out. Use it to end your own session of that person. pforte refuses
to call addresses on private networks unless the operator allows it (`OUTBOUND_ALLOW_PRIVATE_ADDRESSES` in the
[configuration](configuration.md)).

**Only in your application.** If you only end your own session, pforte still knows the person: the next *Sign in* signs them
in again without a password. That is single sign-on. To let somebody else sign in, end the session at pforte, or send `prompt=login`.

When an administrator locks or deactivates a person, their sessions and refresh tokens end ([the administration](administration.md)).

## Asking for more

These are standard parameters of the authorization request:

| Parameter | Effect |
| --- | --- |
| `prompt=login` | Ask for the password again, although the person is signed in. |
| `prompt=none` | Never show a page: you get the code at once, or the error `login_required` when the person is not signed in. Good for a quiet check. |
| `max_age=300` | Sign in again if the last sign-in is older than 300 seconds. The ID token then has `auth_time`. |
| `acr_values=urn:pforte:acr:mfa` | Require the code, even when the browser is remembered. Use it before something sensitive. Check the `acr` of the ID token: a library does not do it for you. |
| `login_hint=anna@example.com` | Fills in the e-mail address. |
| `ui_locales=de` | The language of pforte's pages: `de`, `en`, `fr` or `hu`. Without it pforte follows the browser, then its default language. |

## Browser and mobile applications

- **Browser applications** (single-page apps) register as a **public** client. Such an application can do the flow itself with
  PKCE and keeps no secret, because pforte answers its cross-origin requests (CORS): the discovery document and the keys to
  every page, and the token and userinfo endpoints **only to the origin of a redirect URI of the client** (the page at
  `https://app.example.com/callback` may call from `https://app.example.com`). A page on any other origin, and the origin `null`,
  cannot read the answers, and nothing else of pforte (the sign-in pages, the administration, the admin API) can be read from
  another origin. Credentials are never allowed. If your page and its callback are on different origins, put them on one.
  A backend that does the flow and keeps the session in a cookie is the safer design.
- **Mobile applications** use a public client. The redirect must be an `https` address that your app opens (a universal or app link),
  or `http://127.0.0.1:<port>/callback` with a fixed port. Custom URL schemes such as `myapp://` are not supported yet
  ([#12](https://github.com/progwise/pforte/issues/12)).
- **Servers** use a confidential client and send the secret at the token endpoint, as `client_secret_basic` (the HTTP basic
  header) or `client_secret_post`.

## The requests without a library

For a language without a good library, this is what goes over the wire. It is what the example application does, written as `curl`
and `openssl`, against the development setup.

Make the verifier and the challenge:

```sh
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
```

Send the browser to (one line, with the parameters URL-encoded):

```text
http://localhost:3300/auth?client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A3400%2Fcallback
  &response_type=code&scope=openid%20profile&state=abc123&nonce=n-0S6_WzA2Mj
  &code_challenge=<CHALLENGE>&code_challenge_method=S256
```

After the sign-in, pforte redirects to `http://localhost:3400/callback?code=<CODE>&state=abc123&iss=http%3A%2F%2Flocalhost%3A3300`.
Check `state`, then exchange the code (the code works once, for a few minutes):

```sh
curl -s http://localhost:3300/token \
  -d grant_type=authorization_code -d code="$CODE" -d client_id=demo-web \
  -d redirect_uri=http://localhost:3400/callback -d code_verifier="$VERIFIER"
```

```json
{
  "access_token": "NtIZahcS1PUxTyos-n3cum67JU7B…",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6…",
  "refresh_token": "DUZYJztoexv7Z8uhh43EoU2B488P…",
  "scope": "openid profile",
  "token_type": "Bearer"
}
```

A confidential client adds its secret with `-u "$CLIENT_ID:$CLIENT_SECRET"` instead of `-d client_id=…`. Verify the ID token as described
above, then, if you need the claims from the endpoint, and later to refresh:

```sh
curl -s http://localhost:3300/me -H "Authorization: Bearer $ACCESS_TOKEN"

curl -s http://localhost:3300/token -d grant_type=refresh_token -d refresh_token="$REFRESH_TOKEN" -d client_id=demo-web
```

## When it does not work

| You see | Usually |
| --- | --- |
| A page: *redirect_uri did not match any of the client's registered redirect_uris* | The redirect URI is not registered exactly as sent: look at the scheme, the port and a trailing slash. |
| A page: *client is invalid* | The client ID is wrong or the client was deleted. |
| Redirect with `error=invalid_request`: *Authorization Server policy requires PKCE* | The request has no `code_challenge` (and `code_challenge_method=S256`). |
| Redirect with `error=invalid_scope`: *requested scope is not allowed* | The client is not registered for that scope. `admin` and `directory` are for machine clients only. |
| `invalid_grant`: *grant request is invalid* at the token endpoint | The code was used before or has expired, the verifier or the redirect URI is not the one of the sign-in, or the refresh token was used before. |
| `invalid_client`: *client authentication failed* at the token endpoint | A wrong secret, or the wrong way to authenticate: a public client sends no secret (only its `client_id`), a confidential one sends it as basic header or in the body. |
| The library refuses an `http` issuer | Libraries insist on https. For `localhost` most have an option for it (the example uses `allowInsecureRequests`); anywhere else use https. |
| A claim is missing | The claim type is not assigned to the client, the person has no value for it, or the scope for it (`profile`, `phone`) was not requested. |

The error pages and the sign-in pages follow the language of the browser, and the operator can give them the look of your organisation
([branding and languages](branding-and-languages.md)).
