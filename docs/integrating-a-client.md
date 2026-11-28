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
it ends its own session and redirects to pforte's end-session endpoint, which revokes its refresh tokens and asks the person
whether to end the sign-in at pforte too ([signing out](#signing-out)).

## Register your application

In the administration open *Clients → New client → Application* ([the administration](administration.md)). It asks for:

| Setting | What to know |
| --- | --- |
| Public or confidential | **Public** for an application that cannot keep a secret: a browser or mobile app. **Confidential** for one that runs on a server: it gets a secret, shown once, and uses it at the token endpoint. |
| Start address | Where your application starts, for example `https://app.example.com/`. Optional, `https` only (`http` for `localhost`). When a person has chosen their password from an activation link, or has reset it, the last page of pforte shows a button *Continue to your application* that leads here, because the mail is often opened on another device than the application. It is not a redirect URI: it carries no code or token, and your application starts its own sign-in. Only this registered address is ever linked. In the Admin API it is `clientUri`. An administrator who sends an activation link or resets a password from the administration chooses among the applications that have one, and where yours is the only one, a link that names no application leads here too. |
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
| `picture` | With the scope `profile`, if the person gave themselves a picture on [the account pages](account.md#a-picture): the address of a square JPEG of 512 pixels, which your server or the person's browser fetches without a sign-in. The address changes when the picture does, so it can be kept as long as it is the one in the claim. A person without a picture has no such claim. |
| `phone_number`, `phone_number_verified` | With the scope `phone`, if the person has a mobile number. |
| Your claim types | The claim types assigned to the client, such as `partner_no`. A type that holds several values per person is an **array** (`"partner_no": ["00892", "01234"]`), another is a string. A claim the person has no value for is left out. |
| `auth_time` | When the person last signed in, if you asked for `max_age`. |

The userinfo endpoint returns the same claims without those of the token itself (`acr`, `amr`, `nonce` and so on).

**`acr` and `amr`** tell you whether a second factor was used for this sign-in:

| `acr` | `amr` | Meaning |
| --- | --- | --- |
| `urn:pforte:acr:mfa` | `["pwd", "otp"]` | The password and a code from an e-mail or an SMS, entered now. |
| `urn:pforte:acr:mfa` | `["pop", "mfa"]` | A [passkey](passkeys.md): the person's device checked them (face, finger or PIN) and signed with a key only it holds. |
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

**Signing out at pforte.** End your own session first, then redirect the browser to the `end_session_endpoint` (`/session/end`)
with `id_token_hint` (the ID token) and `post_logout_redirect_uri` (registered for the client). Your application is left
whatever the person answers: with either answer pforte revokes the refresh tokens your application got in that browser
session. What pforte asks the person is whether to sign out *completely*, that is to end the sign-in at pforte as well:

- **Yes** ends the browser's session at pforte and revokes the refresh tokens of every application in it. The next sign-in
  is a fresh one: the person signs in again, with password and code or with a passkey.
- **No** leaves only your application. The browser's session at pforte stays, and pforte reuses it while it is valid: the
  next sign-in to your application, or to another one, is single sign-on and shows no page. A request that asks for more
  than the session has (`prompt=login`, a `max_age` that is exceeded, `acr_values`) still leads to a fresh sign-in
  ([asking for more](#asking-for-more)).

Either way pforte then sends the browser to `post_logout_redirect_uri`, without saying which answer it was. So do not wait
for the return to end your session, and do not show "you are signed in" there.

Add `ui_locales` (for example `ui_locales=de`) to have the question in the language of your application, as with the
authorization request. Without it the question is in the person's own language, then the browser's
([which language is used](branding-and-languages.md#which-language-is-used)).
`color_scheme` works here as well ([light or dark](#light-or-dark)).

**Back-channel logout.** If the client has a back-channel logout address, pforte sends a `logout_token` (a signed JWT) to it
with a POST when a session of the person ends. Use it to end your own session of that person. Answer `200` or `204`. The
token is sent in two cases:

- **The person signs out at pforte.** The token goes to the applications of that browser session.
- **Somebody ends the person's sessions for them:** an administrator locks, deactivates or deletes the person, signs them out
  everywhere or starts a password reset, or the person completes a password reset. The token goes to every application the
  person has a session with or still holds tokens for, so also to an application that kept refreshing after the browser
  session at pforte had expired.

What the token names depends on how the client is registered. With `backchannelLogoutSessionRequired` (in the administration:
*Send the session ID with the logout message*), it carries the `sid` of one session, the same `sid` as in the ID token, and
you get one token per session. pforte also finds the `sid` in the tokens it issued in that session, so a session that has
expired at pforte while your application kept refreshing is still named. Without the setting, the token carries only `sub`,
which means: end all sessions of this person.

The second case is **best effort**. pforte calls after the change is saved and does not wait for your answer. It tries three
times within about ten seconds, each time with a new token and a timeout of 2.5 seconds, and then gives up; an application
that is down for longer, or a restart of pforte in those seconds, means the token is lost. A token without `sid` is not sent
a second or third time once the person has signed in to your application again: it would be dated after that sign-in and end
the new session too. The administrator's action never fails because of any of this; an application that pforte gave up on is
recorded in the [audit log](audit-log.md#telling-applications).
So keep renewing your tokens as well: a refresh fails once the person's sessions were ended, and that is the check that
cannot be missed.

pforte refuses to call addresses on private networks unless the operator allows it (`OUTBOUND_ALLOW_PRIVATE_ADDRESSES` in the
[configuration](configuration.md)).

**Only in your application.** If you only end your own session, pforte still knows the person: the next *Sign in* signs them
in again without a password. That is single sign-on. To let somebody else sign in, end the session at pforte, or send `prompt=login`.

When an administrator locks or deactivates a person, their sessions and refresh tokens end ([the administration](administration.md)),
and applications with a back-channel logout address are told, as described above.

## Asking for more

These are standard parameters of the authorization request:

| Parameter | Effect |
| --- | --- |
| `prompt=login` | Ask for the password again, although the person is signed in. |
| `prompt=none` | Never show a page: you get the code at once, or the error `login_required` when the person is not signed in. Good for a quiet check. |
| `max_age=300` | Sign in again if the last sign-in is older than 300 seconds. The ID token then has `auth_time`. |
| `acr_values=urn:pforte:acr:mfa` | Require the code, even when the browser is remembered. Use it before something sensitive. Check the `acr` of the ID token: a library does not do it for you. |
| `login_hint=anna@example.com` | Fills in the e-mail address. |
| `ui_locales=de` | The language of pforte's pages: `de`, `en`, `fr`, `hu` or one the installation added; several are a list, most preferred first (`ui_locales=fr hu`). Without it pforte uses the person's own language once it knows who is signing in, before that the browser's, then its default language. The end-session request takes the same parameter. |

### Light or dark

Your application is light or dark by its own choice: it follows the device, or it has a switch. pforte cannot see
that, so say it. Add `color_scheme=dark` or `color_scheme=light` to the query of a request that leads to one of
pforte's pages:

- the authorization request (`…/auth?client_id=…&color_scheme=dark`),
- the end-session request,
- a link to the [account pages](account.md) (`…/account?color_scheme=dark`).

pforte's pages then look like your application, and they keep that look in this browser: the parameter leaves a cookie
([`pforte_color_scheme`](security.md#cookies)), so no page has to pass it on, and the pages that follow without a
request of yours (the code, a password reset, the account pages) have it too. It holds until a request says something
else. So **send it with every authorization request**, with the value your application has at that moment: an
application that is light and says nothing gets the look the last application asked for. `color_scheme=auto` removes
the cookie.

A browser in which no application ever said anything gets pforte's pages as the device is set
(`prefers-color-scheme`). The parameter is pforte's own, not part of OpenID Connect; a library passes it on as any
additional parameter of the authorization request. It is read from the query of a `GET` request that is answered with a page or with a redirect to one; a request for a file or to the API changes nothing. An installation
can be light for everybody ([`"dark": false`](branding-and-languages.md#light-and-dark)); it ignores the parameter.

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
