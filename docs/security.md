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
The pages that deal with passkeys are the exception to "no scripts": their policy allows [one script](#the-one-script),
by its exact address.

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
| `pforte_second_factor` | The step between password and code: user, sign-in, language, time, and how often the person's sessions had been ended when the password was accepted (see [below](#a-sign-in-under-way-ends-with-the-persons-sessions)). Signed. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 15 minutes, only for that sign-in's path |
| `pforte_phone_step` | The step of confirming a phone after activation. Signed. | like the above, 30 minutes, path `/activate` |
| `pforte_device` | Tokens of remembered devices. Their hashes are in the database. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 90 days, path `/interaction` |
| `pforte_device_new` | The token of a device that an activation remembered, until the next sign-in in that browser moves it into `pforte_device`. | like `pforte_device` |
| `pforte_manage`, `pforte_manage_login`, `pforte_manage_flash` | The session of a person in the administration, the sign-in on its way there and back, and the message an action leaves for the next page. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, path `/manage`; 8 hours at most, 10 minutes, 2 minutes |
| `pforte_account`, `pforte_account_login`, `pforte_account_flash` | The same for [the account pages](account.md). The session holds who the person is, which sign-in it came from and when, no token. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Lax`, path `/account`; 1 hour, 10 minutes, 2 minutes |
| `pforte_account_phone` | The new mobile number a person asked for on the account pages, while its code can be entered: whose it is, the number, which code was sent to it, and until when. Signed. The code is bound to the number as well, so the cookie alone changes nothing. | `HttpOnly`, `Secure` (https), `SameSite=Lax`, path `/account/phone/change`; 10 minutes |
| `pforte_passkey_step` | A random token for a sign-in that is complete while the person is asked to [confirm their phone number](sms.md#phone-numbers) and whether they want a [passkey](passkeys.md). Who signed in and how is kept at pforte, under the hash of the token, and ends with the person's sessions. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 15 minutes, only for that sign-in's path |
| `pforte_activation_passkey` | The same for the question at the end of an activation. | like the above, path `/activate` |
| `pforte_passkey_offer` | Who has answered the offer of a passkey in this browser, and until when each is left alone: 90 days after "not now", 400 days after a passkey was created or used. A person is a short hash in it, not their id. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 400 days, path `/`: the sign-in pages and the activation both read and write it |
| `pforte_phone_later` | Who has answered "not now" in this browser when asked to confirm their phone number, and until when each is left alone: 30 days. A person and their number are a short hash in it, neither the id nor the number. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Strict`, 30 days, path `/`: the sign-in pages read and write it, the activation writes it |
| `pforte_logout_language` | The language of a sign-out on its way from the question to the page that says how it ended ([which language is used](branding-and-languages.md#which-language-is-used)). Nothing but a language code. Signed. | `HttpOnly`, `Secure` (https), `SameSite=Lax`, 10 minutes, path `/`: the end-session request writes it, the page at the end reads and removes it, and the answer to the question removes it where no such page follows, because it leads back to an application |
| `pforte_color_scheme` | Whether an application asked for light or dark pages in this browser ([light or dark](integrating-a-client.md#light-or-dark)). One of the two words, checked when read, so it is not signed. Any site can set it with a link; it changes the look of the pages and nothing else. | `HttpOnly`, `Secure` (https), `SameSite=Lax`, 400 days, path `/`: a request with `color_scheme` that is answered with a page or a redirect to one writes it (never the answer with a file of the branding folder, which a cache may keep), every page reads it |
| `_session`, `_interaction`, … | The provider's own: the single sign-on session and the open sign-in. Signed with `COOKIE_KEYS`. | `HttpOnly`, `Secure` (https). `SameSite=None` over https, because OpenID Connect requires the authorization endpoint to accept POST; `Lax` over http |

A test signs in over https and checks that every cookie has `HttpOnly`, `Secure` and a `SameSite` value.

The cookies of the account pages are `Lax` where pforte's others are `Strict`. People reach those pages by a link from
their application, and a browser does not send a `Strict` cookie along with such a click, nor with the redirects of the
sign-in that follows, so the person would be asked to sign in again and again. `Lax` sends the cookie with that click and
still with no request another site makes itself: a form posted from elsewhere arrives without it, and is refused anyway
(see above).

### Remembered devices

A browser is remembered only when the person ticks "Remember this device", in one of two places: with the sign-in code, or on
the page where they choose their first password. Both show the same thing, that the person holds the mailbox (or the phone):
the code was sent there, and so was the activation link. So a person who has just activated is not mailed a code for their
first sign-in in that browser. Everything else is the same for both: 90 days, the administration lists the device and can
forget it, and an application that asks for `urn:pforte:acr:mfa` gets the code whatever the browser remembers. What this
means for a link that gets into the wrong hands is in the [threat model](threat-model.md).

A password reset is not a third place. The page that takes the reset code and the new password has no such box, and the
reset forgets every device that was remembered, so the next sign-in always asks for a code. The reset code shows the same
thing as that sign-in code, but a reset is also what a person does after a takeover, and what an administrator starts when
an account may be compromised: it is the moment to take trust away, not to hand it out. The price is one more mail after a
forgotten password ([#46](https://github.com/progwise/pforte/issues/46)).

## A sign-in under way ends with the person's sessions

Ending a person's sessions ("sign out everywhere", a password reset, locking, deactivating) also ends a sign-in of
theirs that is between password and code. Without this, somebody who typed the password before a reset, and holds the
code that was sent for it, could finish that sign-in after the reset.

pforte counts on the person how often their sessions were ended. The step between password and code notes the count
when the password is accepted, read together with the password. The code is refused when the count has moved on:
the code page, "send a new code" and the code itself all lead back to the login page, and the code is not looked at.
The check that decides is made with the person's row held, the row that ending sessions takes first, so the two cannot
cross. A sign-in that is refused this way is recorded (`login.code_failed`, `reason: sessions_ended`).

## A changed password is announced

When a password was changed with a reset code, pforte sends the person an e-mail that says so. It names no time, no
address and no browser (an administrator finds those in the [audit log](audit-log.md), under
`user.password_reset.complete`); it gives the page where a new password is chosen and asks the person to tell their
administration if the change was not theirs. The notice is always an e-mail, also when the reset code went by SMS, so
it reaches the mailbox, which somebody who holds only the phone cannot read. The page does not wait for it: a mail
server that is down does not undo the reset, the failure is in the server log. Nothing is sent for a first
password, chosen with an activation link, and the mail cannot be turned off; its text can be replaced like every other
(see [languages and texts](branding-and-languages.md#changing-texts-and-adding-languages)). What the notice is worth
against each attacker is in the [threat model](threat-model.md).

## A new passkey is announced

When a passkey is added to an account, pforte sends the person an e-mail that says so, with the browser the passkey was
created with and the page where it can be removed. A passkey signs in without password and code, so one that somebody
else added must not go unnoticed. As with the changed password, the notice is always an e-mail, is sent after the
passkey is stored, and cannot be turned off; a mail server that is down does not undo the passkey.

## A new phone number is announced

When a person gives their account another mobile number on [the account pages](account.md), pforte sends them an
e-mail that says so, with the new number partly hidden and the address of the account pages. The codes go to that
number from then on, so a number that somebody else put in must not go unnoticed. The notice is always an e-mail and
never an SMS: it has to reach the person, not the new phone. Like the two above it is sent after the change is
stored and cannot be turned off; a mail server that is down does not undo the change. Nothing is sent when an
administrator, an import or a sync changes a number: those codes then go by e-mail until the person has confirmed it.

## Passkeys

A passkey is made on the person's device and pforte keeps its public half; with it the person signs in without
password and code ([passkeys](passkeys.md)). What pforte insists on, when one is made and when one is used:

- **The device checks the person every time** (user verification is required). An answer from a device that did not is
  refused.
- **The answer is for pforte's host and comes from pforte's own page.** The answer of the device names the origin of the
  page it was on and the host it is for; both must be the ones of `ISSUER`, to the port. This is what a fake login
  page cannot get around: the device signs the address of the page it is really on.
- **A question is answered once.** The challenge is random and is kept at pforte, not in the browser. The first answer
  that names it uses it up, right or wrong, in one database statement, so of two answers at the same moment one is too
  late. An answer cannot be sent a second time: not to sign in again, and not to bring back a passkey that was removed.
- **A question belongs to one place.** One about a new passkey is for one person and for where it was asked: the
  sign-in at the account pages, the sign-in in progress, the activation. It lasts five minutes on the account pages and a
  quarter of an hour in an offer. One about a sign-in belongs to that sign-in, is the only one it has (showing the login
  page again replaces it) and lasts as long as the sign-in may take, an hour. A question for a sign-in is never one for a
  new passkey, nor the other way round.
- **A sign-in is the passkey's own.** The signature is checked with the key stored for that passkey; the person is the
  one the passkey was made for, and must be able to sign in (not locked, not deactivated). A device that names another
  person than the passkey belongs to is refused, as is a signature counter that goes back, which a copy of a passkey
  that is not synced would show.
- **A sign-in is noted before it counts.** The time of use and the counter are written only if the passkey is still
  there and its counter is still the one the signature was checked against. Of two sign-ins checked against the same
  counter, the second is refused, so a counter never goes back; a passkey that was removed while its sign-in was being
  checked signs nobody in. A passkey that does not count (synced ones report 0) is not held up.
- **Who may make one.** Only the person themselves, right after showing who they are: with two factors at most five
  minutes ago on the account pages, with a code a moment ago in the offer after a sign-in, with the activation link and
  their new password at the end of an activation.
- **An offer is kept at pforte and ends there.** While a person is asked whether they want a passkey, their finished
  sign-in (or their activation) waits in the database; the browser holds a random token, of which pforte keeps the hash.
  The offer ends when it is answered, after a quarter of an hour, and **when the person's sessions are ended**: by
  "sign out everywhere", a password reset, locking or deactivating. From then on the token finishes no sign-in and
  makes no passkey, whoever holds a copy, and every question about a new passkey that was still open is gone with it.
- **An offer is opened in the same step as what entitles to it.** After a sign-in, the code is accepted and the offer
  opened in one transaction that holds the person's row, and only for a sign-in whose password was accepted after the
  person's sessions were last ended ([above](#a-sign-in-under-way-ends-with-the-persons-sessions)); at an activation, the offer is opened in the transaction that
  activates the account. There is no moment at which the code is used up, or the account active, and the offer not yet
  there for the ending of sessions to find. Confirming the phone number in between only carries the activation's offer
  on and cannot open another.
- **What entitles a person is asked again where the passkey is stored.** Checking a device's answer takes a moment.
  So the passkey is stored in a transaction that first locks the person's row and then asks once more: is the offer
  still open (it is closed in that same transaction), does the sign-in at the account pages still exist? Ending a
  person's sessions locks the same row first. The two therefore happen one after the other: a passkey is stored
  before the sessions were ended, or it is not stored.
- **A passkey is known once.** A credential that is stored already, for this person or another, is not stored again.
- **Twenty per person, also under load.** The person's row is locked while their passkeys are counted and the new one
  is stored, so passkeys that arrive at the same moment are counted one after the other.
- **No attestation.** pforte does not ask which make of device it is, and keeps nothing that identifies the device.
- **Nothing secret is stored.** The table holds the public key, the id of the credential and a label. A copy of the
  database signs nobody in.

The library that checks the answers is `@simplewebauthn/server`.

## The one script

pforte's pages run no script, with one exception. WebAuthn, the browser interface behind passkeys, can only be reached
from script, so the pages that deal with passkeys load one file: the login page (the passkey button and the autofill of
the e-mail field), the code page and the activation page (where it only finds out whether the device can make a
passkey), the offer of a passkey, and the page of the account pages that adds one.

- **One file, served by pforte**, under an address that contains a hash of its content. No inline script, no other
  origin, no dependency and no build step: the text in `apps/server/src/passkeys/script.ts` is what the browser gets.
- **The policy allows that address and nothing else**: `script-src` names the one file. A script that got into the page
  some other way does not run, nor does any other file of pforte loaded as a script. Pages that need no passkey keep
  the policy without any script.
- **It makes no requests.** What the device is to be asked comes with the page; the device's answer goes into a hidden
  field of a form that is sent like any other. So the policy has no `connect-src`, there is no endpoint that answers
  JSON to a page, and the check that [forms come from pforte's own pages](#forms-only-from-pfortes-own-pages) covers
  this form too.
- **It decides nothing.** It asks the device what the page tells it to ask and hands back what the device said. What a
  sign-in is worth, who a passkey is for and whether an answer holds is decided by pforte, from the answer.
- **Every page works without it.** With the script blocked, or in a browser without passkeys, the login page is the one
  for password and code (the passkey button is hidden until the script shows it), no passkey is offered after a code or
  an activation, and the page that adds one keeps its button disabled and says that this browser cannot create a passkey.

Two kinds of test hold this: the server is driven with a device in software (right and wrong answers), and Chrome with
its virtual authenticator runs the script itself, including an attempt to run a second script, which the policy stops.

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
