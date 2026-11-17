# Changelog

What changed in each release of pforte. Newest first. While the version starts with 0, breaking changes can happen in any
release: read the entry before you update, and back up the database first (migrations cannot be undone).

The entry of a release becomes the text of its GitHub release. Changes that are not released yet are collected under
"Unreleased" and turned into the entry of the version by `scripts/release.sh` (see [docs/releasing.md](docs/releasing.md)).

## Unreleased

### Added

- **pforte has a signet:** an arched doorway with a keyhole, which is also a person standing in it. Every page now has an
  icon in the browser tab, and an installation without branding shows the signet above its pages. **If you have a
  branding folder:** with a `logo`, that logo is now the icon of the browser tab as well; with a `name` and no logo, the
  name stays above the pages and the tab shows the signet in the colours of your main button. The documentation site
  carries the signet too.

### Changed

- **The account pages fit a phone.** On a screen narrower than 640 pixels the bar took a third of the first screen: the
  logo, three rows of menu, then the name and the button to sign out. Now it is one line: the logo, the sections as a
  menu that opens and names the current page, and the button to sign out; who is signed in is said in the opened menu.
  The lists of browsers, devices, sign-ins and passkeys show one entry below the other there, each value named, so the
  button that forgets a device or removes a passkey no longer sits beside the screen. No script is needed for it. On a
  wide screen the pages are as before. The administration gets the same bar on a narrow screen and is otherwise
  unchanged ([the account pages](docs/account.md), [#83](https://github.com/progwise/pforte/issues/83)).
- **The account pages name a browser as a person knows it.** The remembered devices and the recent sign-ins showed
  the line a browser sends about itself (`Mozilla/5.0 (iPhone; CPU iPhone OS …`). They now say "Safari, iPhone", as the
  list of passkeys already did. A browser that pforte cannot name is still shown by its own line. The administration
  and the audit log keep the full line.

### Fixed

- **Password managers save a new password under the e-mail address.** After a password reset a password manager (Apple
  Passwords, Bitwarden and others) saved the new password under the code as the user name, and after an activation
  under no user name, so the next sign-in offered an entry that could not work. The pages where a person chooses a
  password now show the e-mail address of the account in a read-only field directly above the new password, marked as
  the user name: on the reset page below the code, on the activation page as the first field. Nothing else changes: an
  activation still goes by its link alone, whatever the page posts. **An entry that was saved before, under a code,
  stays wrong until the person corrects or deletes it in their password manager**
  ([#82](https://github.com/progwise/pforte/issues/82)).

## 0.3.0 (2026-11-17)

**Before you update:** back up the database. This release has five migrations (the tables for passkeys, and a counter on
every user that ends a sign-in under way with the person's sessions); run them with `pforte migrate`, or let
`MIGRATE_ON_START` do it. These changes can affect what you already run, and each is described below:

- **Passkeys** are on for everybody and are bound to the host in `ISSUER`: do not change that host afterwards. A sign-in
  with one has the `amr` `["pop", "mfa"]`, which matters to an application that expects `pwd` there.
- **An application with a back-channel logout address** now also receives a logout token when an administrator ends a
  person's sessions, and when a password reset is completed.
- **Two e-mails are new and cannot be turned off:** one after a password was changed, one for every new passkey.
- **A person whose phone number is not confirmed is asked at their next sign-in**, where this pforte sends SMS.
- **A second built-in client, `pforte-account-ui`,** appears in the list of clients, for the account pages at `/account`.
- **The admin API** answers `GET /admin/users/{id}/sessions` with the new fields `amr` and `staysSignedIn`, which a
  client that checks answers against the OpenAPI document of 0.2.0 rejects.
- **If you replaced texts or added a language** in your `locales` folder, add the new texts named below, or they appear
  as built in.

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
  the secrets as swarm secrets and a deploy script that runs from your own machine. Codes by SMS are an option of it,
  with the provider's credentials as a secret too. It can also build and run a
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
- **A phone number can be confirmed later, on the account pages.** Codes go by SMS only to a number its owner has
  confirmed, and the only place to do that was the step right after choosing the first password. Whoever skipped it,
  got a number afterwards (the first administrator, a later import or sync) or had it changed by the back office
  received every code by e-mail, with no way to change that. Now the overview of `/account` says "Not confirmed, so your
  sign-in codes come by e-mail" next to such a number and has the button "Confirm with a code by SMS": pforte sends a
  code to the stored number, the person enters it, and the next sign-in code comes by SMS. The button is there only
  when this pforte sends SMS. Sending the code needs a sign-in that is at most five minutes old and counts against the
  limits on asking for codes. A confirmation is recorded as `user.phone.confirm` with `self: true`, now also at the
  step after an activation. A code confirms the number it was sent to and no other: when an administrator changes
  the number, the code that is on its way is ended, and the page offers to send one to the new number. The new texts
  are `account.profile.phoneUnconfirmed`, `account.phone.send`, `account.phone.intro`, `account.phone.introSend` and
  `account.phone.unavailable`; **if you added a language in your `locales` folder**, add them there, or they appear in
  English ([the account pages](docs/account.md#what-a-person-can-do), [SMS](docs/sms.md#phone-numbers)).
- **A sign-in asks for a phone number that is not confirmed.** When the back office entered or changed a person's
  number, nothing told the person, and their codes came by e-mail until they found the account pages by themselves. Now
  the next sign-in asks: after the password and the code, with a remembered device or with a passkey, one page says
  that the number is not confirmed, with the buttons "Confirm with a code by SMS" and "Not now". No SMS goes out before
  the person asks for it. With the code the number is confirmed and the sign-in goes on; with "Not now" it goes on as
  well, and that browser is not asked again for 30 days unless the number changes. Skipping the step at the end of an
  activation counts as the same answer. The page comes before the offer of a passkey, only where this pforte sends
  SMS, and never without a sign-in page. The sign-in is complete before it is shown and waits at pforte as it does
  behind the offer of a passkey, so it ends with the person's sessions. A limit on codes from the person's network
  address is said on the page itself, where "Not now" still leads on. **Every application gets this without a
  change.** New: the cookie `pforte_phone_later`, the texts `phone.signIn` and `phone.later` (**add them if you
  replaced texts in your `locales` folder or added a language**, or they appear as built in), and `login.code_sent`
  with `purpose: activation` for a code sent at a sign-in ([phone numbers](docs/sms.md#phone-numbers)).
- **An application can let a person confirm their phone number in its own pages.** For applications whose people never
  see pforte's account pages: `POST /admin/users/{id}/send-phone-code` has pforte send the code by SMS to the stored
  number, `POST /admin/users/{id}/confirm-phone` checks the code the person typed into the application and confirms the
  number. pforte sends and checks; the application only shows the field. Both are open to the scopes `directory` and
  `admin`, follow the limits of every code (one a minute and five an hour per person, five attempts per code), and are
  recorded with the client as the actor (`user.phone.confirm.request`, `user.phone.confirm`)
  ([confirming a number in your own application](docs/sms.md#confirming-a-number-in-your-own-application)).

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
  pforte too, "No, only leave *application*" keeps it, so pforte can reuse it for the next sign-in. Nothing about what the
  answers do has changed. When there is no address to go back to, the page after a "no" says "You are still signed in"
  instead of "You are signed out". The new texts are `logout.titleFrom`, `logout.textFrom`, `logout.noFrom`,
  `logout.keptTitle` and `logout.kept`; **if you replaced `logout.text` or `logout.no` in your `locales` folder, or added
  a language**, add them there, or they appear as built in, in English for a language of your own
  ([signing out](docs/integrating-a-client.md#signing-out)).
- **The administration offers a way on to somebody who is not an administrator.** The page "Not an administrator" had no
  button, and opening `/manage` again led straight back to it, because the browser was still signed in at pforte as that
  person. An administrator who met it, on a shared computer or after signing in to an application with another account,
  had to know the address that signs out. Now the page has the button "Sign in with a different account": it asks for
  password and code although the browser is signed in, and when another person signs in, the first is signed out of
  pforte. The new text is `manage.notAdmin.other` ([the administration](docs/administration.md#who-can-use-it)).
- **`prompt=login` takes another person.** When an application asked for a new sign-in with `prompt=login` and somebody
  else than the person signed in to pforte entered their password, the sign-in ended on the page "Something went wrong"
  (`interaction session not found`): pforte signed the first person out, as it should, and removed the sign-in under way
  together with their tokens. Now the first person is signed out and loses their tokens as before, and the second arrives
  at the application.
- **The way back to the administration after choosing a password.** The first administrator chose their password from
  the activation link and was left on "Your account is active. You can now sign in from the application you came from",
  with no link to the administration; the same after a password reset that began with "Forgot your password?" on the
  sign-in page of the administration or of the account pages. The built-in clients `pforte-admin-ui` and
  `pforte-account-ui` now have a start address, `/manage` and `/account` of your pforte address, so those pages end with
  the button "Continue to Administration" or "Continue to Account", as they do for an application that has one. The
  button is a link: it carries no code or token, and the administration asks for password and code as always. The mail
  to the first administrator (`BOOTSTRAP_ADMIN_EMAIL`) now says that the account is for the administration. The list of
  clients and `GET /admin/clients` show the start address of the two built-in clients
  ([the first administrator](docs/administration.md#the-first-administrator)).
- **The way to the administration for every new administrator.** Only the first administrator got the button
  "Continue to Administration" after choosing a password. An administrator who was created later and sent the activation
  link from the administration ended on "You can now sign in from the application you came from", with no application
  to go back to. Now the administration says where it invites an administrator to: the mail names the administration,
  and the page after choosing the password has the button. Somebody without the admin right is invited as before,
  without an application. An activation through the API is unchanged; pass `clientId: "pforte-admin-ui"` there for
  the same ([the first administrator](docs/administration.md#the-first-administrator)).
- **A password reset from the mail leads on to the application.** The page after choosing a new password has the
  button "Continue to …" when it knows the application, and it knew it only in the browser that had asked on that
  application's sign-in page. The link in the mail with the code did not carry it, so a reset that an administrator
  started, or one finished on another device, ended on "Sign in again from your application" alone. Now the link
  carries the client. The administration names itself when it resets the password of an administrator, who then gets
  "Continue to Administration"; for everybody else it names nothing, as before. `POST /admin/users/{id}/reset-password`
  takes an optional `clientId` (a registered client; an unknown one is a 400), as `activate` does, and "Forgot your
  password?" puts the application it was opened from into the mail's link. Only the address registered for the
  client is ever linked ([activating people](docs/syncing-users.md#a-new-person-must-be-activated)).
- **The examples wait for the Postgres that pforte connects to.** On its first start, with an empty data folder,
  Postgres runs a server for its own set-up that answers on the socket only, and shuts it down before the real one
  starts. The health check of the database in `examples/production` and `examples/swarm` asked over the socket, so it
  could call the database healthy too early: with Docker Compose pforte was then started while there was no server,
  failed and was started again. The check now asks over the network (`pg_isready -h 127.0.0.1`). An installation that
  runs has its data and is not affected; take the line over if you want your copy of the example to match.

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
