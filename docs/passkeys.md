# Passkeys

With a passkey a person signs in with the check their device has anyway: their face, their finger or the device's PIN.
No password, no code, one step. Password and code stay: they are the way in on a device without a passkey, and the way
back in when a device is lost.

Passkeys need no setting and cannot be turned off. A person who never creates one notices a button on the login page and,
after their next sign-in with a code, one question.

## What a person sees

- **Signing in.** The e-mail field of the login page offers the passkey through the browser's autofill; the button
  *Sign in with a passkey* does the same on request. The device checks the person, and they are signed in.
- **The offer.** After a sign-in with a code, and at the end of an activation, one page asks "Sign in faster next
  time?" with *Create passkey* and *Not now*. It comes only on a device that can check its person itself. The sign-in is
  complete before the page is shown: whatever the person answers, also if they close the page and start again, they get
  to their application. Somebody who is asked to [confirm their phone number](sms.md#phone-numbers) at the same sign-in
  sees that page first and the offer after it.
- **"Not now"** is remembered in that browser, for that person, for 90 days. After a passkey was created or used in a
  browser, that person is not asked there again.
- **Their passkeys** are listed on [the account pages](account.md#passkeys), where they add and remove them.
- **A mail** announces every new passkey ([why](security.md#a-new-passkey-is-announced)).
- **A lost device** needs nothing special: password and code still work. A passkey that is synced by the person's
  password manager (iCloud Keychain, Google Password Manager) arrives on their new device by itself. The passkey of a
  device that is gone is removed on the account pages or by an administrator.

Without script, and in a browser that knows no passkeys, the pages are the ones for password and code: the passkey
button is hidden, and the offer does not come.

## What your application sees

A sign-in with a passkey counts as two factors: the person holds the key, and their device checked them before using
it.

| Claim | Value |
| --- | --- |
| `acr` | `urn:pforte:acr:mfa`, as after a code |
| `amr` | `["pop", "mfa"]`: proof of possession of a key, several factors. The device does not tell pforte whether it was a face, a finger or a PIN. |

So an application that asks for `acr_values=urn:pforte:acr:mfa` is satisfied by a passkey, as are `prompt=login` and
`max_age`. A remembered device plays no part: a passkey always gives `mfa`. Nothing changes for an application that
does not look at `amr`.

## What an administrator can do

- **See and remove** a person's passkeys on their page in [the administration](administration.md), or with
  `GET /admin/users/{id}/passkeys` and `DELETE /admin/users/{id}/passkeys/{passkeyId}`. Nobody can create a passkey for
  somebody else.
- **Lock or deactivate** the person: their passkeys are refused like their password.
- **A password reset and "sign out everywhere" leave passkeys alone.** A forgotten password says nothing about a
  device. Where an account may have been taken over, remove the passkeys nobody recognises, then reset the password.
  Both do end an offer that is waiting for its answer, with the sign-in behind it: what was begun before cannot be
  finished after.
- **Read the audit log:** `login.succeeded` with `method: passkey`, `login.passkey_failed`, `user.passkey.add`,
  `user.passkey.remove` ([the audit log](audit-log.md)).

## The address of pforte binds every passkey

A passkey is made for the host in `ISSUER`, such as `id.example.com`, and no device offers it to any other host.

**If the host of `ISSUER` changes, every passkey stops working.** People sign in with password and code and create new
ones; the old ones stay on their devices until they delete them. Choose the address you will keep before people create
passkeys. The path and the port may change, the host may not.

## What pforte asks of a passkey

- **Found without a user name** (a discoverable credential): the login page names nobody, so it says nothing about who
  has an account.
- **The device checks the person every time** (user verification is required). A security key that is only touched is
  not enough.
- **No attestation:** pforte does not ask which make of device it is and keeps nothing that identifies the device.
- **Twenty per person.**

How answers are checked, how often a question may be answered, and what the one script of the pages does is in
[security measures](security.md#passkeys).

## Not included

Accounts without any password, rules about which devices are allowed, passkeys as a mere second factor next to the
password, and a way for an application to insist on a passkey (`acr` is the same as for a code). A native app that
signs in through the system browser gets passkeys there like any other application.

## Try it on the devices your people use

pforte's tests drive Chrome with a device in software. That shows that the pages and the checks work; it does not show
how each real device behaves. Before you tell people about passkeys, create one and sign in with it on what they use:
Safari on an iPhone, a web app started from the iPhone's home screen, Chrome on Android, Windows Hello, a Mac.
