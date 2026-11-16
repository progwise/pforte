# Changelog

What changed in each release of pforte. Newest first. While the version starts with 0, breaking changes can happen in any
release: read the entry before you update, and back up the database first (migrations cannot be undone).

The entry of a release becomes the text of its GitHub release. Changes that are not released yet are collected under
"Unreleased" and turned into the entry of the version by `scripts/release.sh` (see [docs/releasing.md](docs/releasing.md)).

## Unreleased

### Added

- **Activation can remember the device.** The page where a person chooses their first password has the box "Remember this
  device for 90 days", as the code page has. With it ticked, the first sign-in in that browser asks for the password only:
  no second mail with a code right after the activation link, which had already shown that the person reads that mailbox.
  The box starts ticked or unticked by `REMEMBER_DEVICE_DEFAULT`; without it nothing is remembered. The device is listed in
  the administration and can be forgotten there, and an application that asks for `urn:pforte:acr:mfa` still gets the code.
  The token waits in a new cookie, `pforte_device_new`, until the next sign-in in that browser moves it to the others
  ([#44](https://github.com/progwise/pforte/issues/44)).
- **Account pages.** Every person who has an account can open `/account`, see how they are signed in and protect
  themselves. *Overview*: name, e-mail address, mobile phone (mostly hidden) and language, read-only, because the back
  office owns these details. *Signed in*: the browsers and applications, and "sign out everywhere". *Devices*: the
  remembered devices, forget one or all. *Sign-ins*: the last ten sign-ins and failed attempts. *Password*: starts the
  existing reset with a code, so there is no password field. The pages sign in at pforte like any application, always
  with a code, and come in English, German, French and Hungarian. A change needs a sign-in that is at most five minutes
  old and is recorded with the person as the actor and `self: true`. A person only ever sees themselves: no address of
  the pages carries an id, and a session ends with the sign-in it came from, so in every browser when the person is
  locked, signed out everywhere or gets a new password. Nothing in pforte links to the pages; link to them from your
  application. **After the update the list of clients shows a second built-in client, `pforte-account-ui`.** If you
  registered a client under that ID yourself, it is not touched and the pages stay off until you have moved it to another
  ID; the log says so at every start
  ([the account pages](docs/account.md), [#18](https://github.com/progwise/pforte/issues/18)).
- **Passkeys.** A person can sign in with the check their device has anyway (face, finger or the device's PIN) instead
  of password and code: one step, through the autofill of the e-mail field or the button *Sign in with a passkey*.
  Password and code stay as the way in on a device without a passkey. A passkey is offered after a sign-in with a code
  and at the end of an activation, on devices that can make one ("Not now" is remembered in that browser for 90 days),
  and is added and removed on the account pages. Every new passkey is announced to the person by e-mail. An
  administrator sees and removes them on the person's page and with `GET /admin/users/{id}/passkeys` and
  `DELETE /admin/users/{id}/passkeys/{passkeyId}`; locking or deactivating a person refuses their passkeys too, while a
  password reset and "sign out everywhere" leave them alone. What to know before you update:
  - **A passkey is bound to the host in `ISSUER`. If that host changes later, every passkey stops working.**
  - **Applications receive a new `amr`:** a sign-in with a passkey has `acr` `urn:pforte:acr:mfa` and `amr`
    `["pop", "mfa"]`. An application that checks `acr` needs no change; one that expects `amr` to contain `pwd` does.
  - **pforte's pages now run one script**, on the pages that deal with passkeys, the login page among them: one file
    served by pforte, allowed in those pages' policy by its exact address, making no requests. Every other page keeps
    the policy without script, and every page works with the script blocked.
  - **Everybody sees the passkey button and, once per browser, the offer.** There is no setting that turns passkeys off.
  - **The answer of `GET /admin/users/{id}/sessions` has a new field `amr`** in each session. A client that checks
    answers against the OpenAPI document of 0.2.0 rejects it, as with `staysSignedIn` below.
  - New audit events `login.passkey_failed`, `user.passkey.add`, `user.passkey.remove`, and `method: passkey` on
    `login.succeeded`; a new rate limit of 30 refused passkeys per address in 15 minutes; new cookies
    `pforte_passkey_step`, `pforte_activation_passkey` and `pforte_passkey_offer`; new tables `passkeys`,
    `passkey_challenges` and `passkey_offers`.
  - Try passkeys on the devices your people use before you announce them: pforte's tests use a device in software.

  ([passkeys](docs/passkeys.md), [security measures](docs/security.md#passkeys),
  [#45](https://github.com/progwise/pforte/issues/45)).
- **An example for Docker Swarm.** `examples/swarm` runs pforte and Postgres as a stack behind caddy-docker-proxy, with
  the secrets as swarm secrets and a deploy script that runs from your own machine. It can also build and run a
  checkout that is not released, and deploy the example application next to pforte, for a test instance
  ([pforte on a Docker Swarm](examples/swarm/README.md)). The example application got an image, a `BASE_URL` setting
  for running behind a proxy, and a web manifest, so a phone can put it on its home screen.
- **Applications are told when somebody else ends a person's sessions** (back-channel logout). Until now a client with a
  back-channel logout address got a logout token only when the person signed out at pforte. Now it also gets one when an
  administrator locks, deactivates or deletes the person, signs them out everywhere or starts a password reset, and when the
  person completes a password reset, so "locking a person ends their session in the application" holds without waiting for
  the next token refresh. The token goes to every application the person has a session with or still holds tokens for. It
  is sent after the change is saved, three attempts within about ten seconds, and never holds up or fails the action. The
  audit event of the action says how many applications are to be told (`clientsToNotify`); one that pforte gave up on gets
  the new event `user.sessions.notify_failed`. **If your application has a back-channel logout address, it now receives
  tokens on these occasions**; a client registered without `backchannelLogoutSessionRequired` gets a token without `sid`, which
  means all sessions of the person ([#27](https://github.com/progwise/pforte/issues/27)).
- **A changed password is announced by e-mail.** After a password reset the person gets a mail that says their password was
  changed, with the page where they choose another one and the request to tell their administration if it was not them. Until
  now a reset that somebody else did showed only when the old password stopped working. The mail is always an e-mail, also
  when the reset code went by SMS; it is not sent for a first password, and it cannot be turned off. **After the update
  every installation sends it.** To reword it, replace `mail.passwordChanged.subject` and `mail.passwordChanged.text` in
  your `locales` folder ([#51](https://github.com/progwise/pforte/issues/51)).
- **The audit log says when a device was remembered**: `deviceRemembered: true` on `user.activate.complete` (by an activation)
  and on `login.succeeded` (with a code). Until now remembering a device left no trace in the log.

### Fixed

- **A sign-in that is under way ends with the person's sessions.** Somebody who had typed the password and was at the
  code step could finish that sign-in after "sign out everywhere", after a lock that was lifted again, and after a
  password reset, that is with the password that had just been replaced. Now the step between password and code is
  over when the person's sessions are ended: the code leads back to the login page and is recorded as
  `login.code_failed` with `reason: sessions_ended`. A person who is in the middle of signing in at that moment starts
  again. The update adds the column `users.session_epoch`
  ([security measures](docs/security.md#a-sign-in-under-way-ends-with-the-persons-sessions)).
- **"Applications that stay signed in" lists only those that do.** A person's page in the administration listed every
  application the person had signed in to, also one that is signed in only as long as its browser session lasts. Now the
  table has the applications that hold a refresh token, such as an app on a phone, as the account pages show them; the
  others are in the table of browsers. `GET /admin/users/{id}/sessions` still returns every grant and says which is which
  with the new field `staysSignedIn`. **If your client of the admin API checks answers against the OpenAPI document of
  0.2.0, it rejects this one**: that document allows no other fields in a grant. Use the document of this version. A
  client that ignores fields it does not know needs no change ([#60](https://github.com/progwise/pforte/issues/60)).
- **The question at sign-out says what the answers do.** An application that signs a person out has ended its own
  session before pforte asks anything, and loses its refresh tokens whatever the answer is. The page asked "Sign out?"
  all the same and offered "No, stay signed in", after which the person was signed out of the application. Now it says
  that the application is being left and asks whether to sign out completely: "Yes, sign me out" ends the sign-in at
  pforte too, "No, only leave *application*" keeps it, so the next sign-in needs no password. Nothing about what the
  answers do has changed. When there is no address to go back to, the page after a "no" says "You are still signed in"
  instead of "You are signed out". The new texts are `logout.titleFrom`, `logout.textFrom`, `logout.noFrom`,
  `logout.keptTitle` and `logout.kept`; **if you replaced `logout.text` or `logout.no` in your `locales` folder, or added
  a language**, add them there, or they appear as built in, in English for a language of your own
  ([signing out](docs/integrating-a-client.md#signing-out)).

## 0.2.0 (2026-10-23)

**Before you update:** back up the database. This release has one migration (it adds the client start address and the application of an
invitation); run it with `pforte migrate`, or let `MIGRATE_ON_START` do it. Two changes can affect what you already run:
**CORS** (below) now blocks a browser application whose page is not on the origin of one of its registered redirect URIs, and
**self-service activation** is on by default, so people who were created but never activated can now ask for their link
(`SELF_SERVICE_ACTIVATION=false` turns that off).

### Added

- **A person without a password can ask for their activation link.** On the page *Set or reset your password* (from "Forgot your
  password?"), an address that belongs to a user who was created but never activated gets a new activation link instead of nothing.
  The answer is the same for every address, the limits are those of the reset request, and the audit log has a new event,
  `user.activation.request`. When the person came from an application's sign-in page, the mail names that application and the
  page after choosing a password has the button to it. Set `SELF_SERVICE_ACTIVATION=false` to switch it off
  ([#26](https://github.com/progwise/pforte/issues/26)).
- **Continue to the application.** A client has an optional start address (`clientUri`, settable in the administration and the
  Admin API). `POST /admin/users/{id}/activate` accepts an optional `clientId`: the e-mail then names the application, and the
  page after choosing a password (also after confirming the phone number) has a button to its start address. A password reset
  that began on the sign-in page of an application ends with the same button. Needs a database migration (`pforte migrate`, or MIGRATE_ON_START)
  ([#28](https://github.com/progwise/pforte/issues/28)).

### Changed

- **A back-channel logout address may be http on a private network when `OUTBOUND_ALLOW_PRIVATE_ADDRESSES=true`**: a private or
  link-local IP address, `host.docker.internal`, or a name without dots such as a Compose service. Without the setting nothing
  changes (https, or http for localhost). This makes back-channel logout testable with pforte in a container and the application
  beside it ([#32](https://github.com/progwise/pforte/issues/32)).
- **`BOOTSTRAP_ADMIN_EMAIL`**: the error for an address like `admin@localhost` says that a domain such as `you@example.com` is
  expected, and the configuration reference says so too. The admin API has always required a domain with a dot, so the rule is
  unchanged ([#33](https://github.com/progwise/pforte/issues/33)).
- **Cross-origin requests (CORS) are limited to registered applications.** Until now pforte repeated whatever origin a page
  asked about on its discovery, keys, token and userinfo endpoints. Now discovery and keys answer `*`; the token and userinfo
  endpoints answer only the origin of a redirect URI of the client (and a preflight request only an origin of any registered
  client); everything else sends no CORS headers. A browser application whose page is not on the origin of one of its
  redirect URIs is now blocked: register its callback on the page's origin
  ([#25](https://github.com/progwise/pforte/issues/25)).

## 0.1.0 (2026-10-21)

The first release.

### Added

- **OpenID Connect provider**: authorization code flow with PKCE, refresh tokens with rotation, discovery, JWKS, userinfo,
  RP-initiated and back-channel logout, claims in the ID token. Run against the OpenID conformance suite (Basic OP plan)
  without failures; certification has not been applied for ([docs/conformance.md](docs/conformance.md)).
- **Sign-in**: e-mail and password, a second factor by a code sent by e-mail or SMS (any provider with an HTTP API, see
  [docs/sms.md](docs/sms.md)), "remember this device", activation links for new users and password reset.
- **Admin API** for users, claims, claim types, clients, sessions and devices, with an OpenAPI document and an audit log of
  every change.
- **Administration** at `/manage`, in English and German: users (search, create, edit, lock, deactivate, delete, reset a
  password, end sessions, revoke devices), clients, claim types, the audit log and CSV import. It signs in like any application,
  with the second factor, and everything it does goes through the admin API under the administrator's name
  ([docs/administration.md](docs/administration.md)).
- **CSV import** of users and claims, on the command line (`pforte import`) and on a page of the administration, with a dry run,
  rejected rows with line and reason, and a plan for users who are not in the file ([docs/import.md](docs/import.md)).
- **Security**: rate limits on sign-in and codes, an audit of sign-in events, security headers, a check of where forms come
  from, and a production start that refuses weak secrets ([docs/security.md](docs/security.md),
  [docs/threat-model.md](docs/threat-model.md)).
- **Your own look and languages**: name, logo, colours, fonts and footer links from a folder, and pages, e-mails and SMS in German,
  English, French and Hungarian, with the texts you can replace ([docs/branding-and-languages.md](docs/branding-and-languages.md)).
- **Docker image** `ghcr.io/progwise/pforte` for amd64 and arm64, with the commands `start`, `migrate` and `keys`; database
  migrations are applied at start. A [configuration reference](docs/configuration.md) and a
  [production example](examples/production/README.md) with Docker Compose, Postgres and automatic TLS.
