# The account pages

Every person who has an account can open `https://id.example.com/account` (your pforte address followed by `/account`),
see how they are signed in and protect themselves: end their sessions, forget devices, add and remove passkeys, change
the password. The pages
are for the people who sign in, not for those who run pforte: that is [the administration](administration.md).

## What a person can do

| Page | What it shows | What can be done |
| --- | --- | --- |
| **Overview** | Name, e-mail address, mobile phone number (all but its first and last digits hidden) and language. | Confirm the phone number, if it is not confirmed yet and this pforte [sends SMS](sms.md): see below. Nothing else. |
| **Signed in** | The browsers in which the person is signed in, with the applications of each and how they signed in there (with a code, with a passkey, or with the password only on a remembered device), and the applications that stay signed in without a browser because they hold a refresh token, such as an app on a phone. | *Sign out everywhere*: ends every session and application, this page included, and forgets the remembered devices. Applications with a back-channel logout address are told ([signing out](integrating-a-client.md#signing-out)). |
| **Devices** | The devices on which no code is asked for, with the browser, when it was last used and until when it is remembered. | Forget one, or all. The next sign-in there asks for a code. |
| **Sign-ins** | The last ten times somebody signed in to the account or tried to: a sign-in with a code, with a passkey or on a remembered device, a wrong password, a wrong code, a passkey that was refused, a hold after too many attempts, each with the time, the network address and the browser. Only what happened at the sign-in: a wrong code at the password reset or an activation is in the audit log, not here. | Nothing. A person who sees a line that was not them changes their password. |
| **Passkeys** | The person's passkeys, with the browser each was created with, when, and when it was last used. | Add one, remove one: see [passkeys](#passkeys). |
| **Password** | What happens next. | *Send me a code* starts the password reset pforte already has: a code by SMS to a confirmed phone, otherwise by e-mail, and then the page where the code and the new password are entered. As after every reset, all sessions end and the person is told by mail. |

The lists cannot mark "this browser" or "this device": pforte stores neither a browser nor an address with a session, and
the cookie of a remembered device is not sent to these pages. A passkey is listed with the browser it was created with,
such as "Safari, iPhone"; a synced one also works on the person's other devices.

**The overview is read-only.** Your back office or the system you [sync users](syncing-users.md) from owns the name, the
e-mail address and the phone number and would overwrite whatever a person typed here, so the page says that changes go
through the organisation. The links of your [branding](branding-and-languages.md), such as imprint and privacy policy,
are below the page as on every other one.

**The one thing a person does there is confirm their phone number.** Codes go by SMS only to a number the person has
confirmed, which normally happens right after they chose their first password. Somebody who skipped that step, had no
number then, or whose number the back office has changed since, sees "Not confirmed, so your sign-in codes come by
e-mail" next to the number, with the button *Confirm with a code by SMS*. pforte sends a code to the stored number, the
person enters it, and from the next sign-in on the codes come by SMS. The number itself is not changed. The button is
there only when this pforte sends SMS at all. The same question is asked [at a sign-in](sms.md#phone-numbers), so a
person need not find these pages for it.

**There is no password field.** The change of password is the reset, with a new code to the mailbox or the phone. So
somebody who finds a computer unlocked cannot set a password with what is on the screen.

The pages come in English, German, French and Hungarian and are shown in the language stored for the person. Their texts
start with `account.` and can be replaced like every other
([changing texts](branding-and-languages.md#changing-texts-and-adding-languages)).

## A change needs a recent sign-in

Looking needs a session. A change (signing out everywhere, forgetting a device, adding or removing a passkey, asking for
the code of a new password or of the phone number) needs a sign-in with a code or a passkey that is **at most five minutes old**, checked on every single
action. If the sign-in is
older, the person signs in again, with password and code or with their passkey, even though they are signed in, and comes back to the page they
were on. What they were about to do is not done for them: the page says to repeat it, however long the sign-in took.

Adding a passkey takes two steps, with the device's own question in between. The sign-in is checked when the page that
asks the device is opened, and the device's answer is accepted for five minutes from then, once, and only in the
sign-in the question was asked in. Checking again at the answer
could refuse a passkey the device has already made, and the person would keep a passkey on their phone that pforte does
not know.

Confirming the phone number takes two steps as well. The sign-in is checked when the code is sent. Entering the code is
not checked again: the code is newer than the sign-in and runs out after ten minutes, and the person may have waited for
the SMS.

Every change is written to the [audit log](audit-log.md) with the person as the actor and `self: true` in the details, so
an administrator can tell it from the same action done by the back office.

## Passkeys

A passkey is a key pair. The private half stays on the person's device or in their password manager and is used only
after the device has checked the person itself: face, finger or the device's PIN. pforte stores the public half. With
it the person signs in without password and code; what that means for people, applications and administrators is under
[passkeys](passkeys.md). This page is where a person looks after theirs. Most get their first one from the offer after
a sign-in with a code, not here.

- **Adding one.** *Add a passkey* opens a page that says what will happen; *Create passkey* lets the device ask. The
  passkey is one the device finds without a user name, it is made for the host of your pforte address, and the device must
  have checked the person. pforte does not ask which make of device it is (no attestation).
- **A mail follows.** Every new passkey is announced to the person by e-mail, with the browser it was created with and the
  link to this page, so that a passkey somebody else added is noticed. The mail is always sent; its texts are
  `mail.passkeyAdded.subject` and `mail.passkeyAdded.text` (`mail.passkeyAdded.textNoLink` where there are no account
  pages to link to).
- **Removing one.** The passkey is deleted at pforte. The device may still list it, because pforte cannot delete
  anything there; the page says so.
- **Twenty at most** per person.
- **A password reset leaves passkeys alone**, as does signing out everywhere. A forgotten password says nothing about a
  device. Where an account may have been taken over, the person or an administrator removes the passkeys they do not know.
- **Without script** the page for adding one still opens: the button is disabled and the page says that this browser
  cannot create a passkey. It is the only page of the account pages that runs a script; see
  [security measures](security.md#the-one-script).

A passkey belongs to the host in `ISSUER`. **If that host changes, every passkey stops working**
([why](passkeys.md#the-address-of-pforte-binds-every-passkey)).

## Signing in

A person signs in to the account pages the way they sign in to any application, at pforte's own login page. Two things
differ:

- **Two factors are always asked for:** password and code, or a passkey. A remembered device does not count here.
  Somebody who is signed in at pforte with a password only is asked to sign in again.
- **The session lasts one hour.** After that the person passes through the sign-in again, which they do not notice while
  they are still signed in at pforte.

*Sign out* ends the session of the account pages and, after the usual question, the sign-in at pforte, so the next
person at a shared computer cannot walk in. Somebody who answers the question with "No, only leave Account" is out of the
account pages, but the browser stays signed in at pforte.

The built-in client `pforte-account-ui`, which the pages sign in with, is created by pforte at every start, like
`pforte-admin-ui` of the administration. It is listed with the other clients as built in and cannot be changed, rotated
or deleted. Its start address is the pages themselves (`/account` of your pforte address): a password reset that began
on their sign-in page ends with the button *Continue to Account*.

## Linking to it

pforte links to the account pages in one place only: the mail about a new passkey leads to the list of passkeys. Link to
`https://id.example.com/account` from your application or your intranet. A person who follows the link and is signed in at pforte with a code lands on the overview without being asked
anything.

There is no setting that turns the pages off. They show a person nothing but their own account, and only after a
sign-in with a code.

## If you already have a client called `pforte-account-ui`

A pforte from before the account pages let you register an application under this ID. pforte does not overwrite it:
your client keeps its addresses and its secret, the account pages stay off (`/account` answers "not found"), and the
log says so at every start, as an error. To get the pages, register your application under another ID, delete
`pforte-account-ui` in the administration (or with `DELETE /admin/clients/pforte-account-ui`) and restart pforte.

## How a person is kept from seeing anybody else

- **Who somebody is comes from one place**, the session of the sign-in. No address of the account pages carries an id
  of a person, and no person is read from a form field or a header, so there is nothing that could be changed into
  somebody else's. A test walks the addresses and fails if one of them has a part that is filled in.
- **What a person picks is checked against them.** A form carries the id of a device to forget or of a passkey to
  remove. It is looked for among this person's own only, so somebody else's is "not remembered any more", exactly as one
  that does not exist, and nothing happens. A new passkey is stored for the person of the session; the question the
  device answered names that person and is refused in anybody else's session.
- **The session cookie is not enough on its own.** `pforte_account` is signed and holds who the person is, which
  sign-in it came from, how they signed in and when; it holds no token. On every request pforte also checks that the
  person is still active and that this very sign-in still exists. Signing out, locking the person, signing them out
  everywhere or a new password ends it, and with it every copy of the cookie, also one that was stolen. A copy from a
  sign-in that has ended stays dead when the person signs in again: that is another sign-in.
- **The token of the sign-in is thrown away.** It is looked at once, to learn which sign-in this is; the pages call
  no API. The admin API refuses a token that was issued to `pforte-account-ui`, also from an administrator.
- **Other websites** cannot post a form to the pages (the check described under
  [forms only from pforte's own pages](security.md#forms-only-from-pfortes-own-pages)), cannot read them (no answer
  carries a CORS header) and cannot put them in a frame. No script runs on them, with one exception: the page that
  adds a passkey runs pforte's [one script](security.md#the-one-script), which makes no requests.

The cookies are listed with the others under [security measures](security.md#cookies).
