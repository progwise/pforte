# The account pages

Every person who has an account can open `https://id.example.com/account` (your pforte address followed by `/account`)
and see who pforte knows them as. The pages are for the people who sign in, not for those who run pforte: that is
[the administration](administration.md).

This is the first part. For now there is one page, the overview; pages for where a person is signed in, their remembered
devices, their recent sign-ins and a change of password are being built on it.

## What a person sees

The overview shows the name, the e-mail address, the mobile phone number (all but its first and last digits hidden) and
the language. Nothing on it can be changed. Your back office or the system you [sync users](syncing-users.md) from owns
these details and would overwrite whatever a person typed here, so the page says that changes go through the
organisation. The links of your [branding](branding-and-languages.md), such as imprint and privacy policy, are below the
page as on every other one.

The pages come in English, German, French and Hungarian and are shown in the language stored for the person. Their texts
start with `account.` and can be replaced like every other
([changing texts](branding-and-languages.md#changing-texts-and-adding-languages)).

## Signing in

A person signs in to the account pages the way they sign in to any application, at pforte's own login page. Two things
differ:

- **A code is always asked for.** A remembered device does not count here. Somebody who is signed in at pforte with a
  password only is asked to sign in again, with a code.
- **The session lasts one hour.** After that the person passes through the sign-in again, which they do not notice while
  they are still signed in at pforte.

*Sign out* ends the session of the account pages and, after the usual question, the sign-in at pforte, so the next
person at a shared computer cannot walk in.

The built-in client `pforte-account-ui`, which the pages sign in with, is created by pforte at every start, like
`pforte-admin-ui` of the administration. It is listed with the other clients as built in and cannot be changed, rotated
or deleted.

## Linking to it

Nothing in pforte links to the account pages. Link to `https://id.example.com/account` from your application or your
intranet. A person who follows the link and is signed in at pforte with a code lands on the overview without being asked
anything.

There is no setting that turns the pages off. They show a person nothing but their own account, and only after a
sign-in with a code.

## How a person is kept from seeing anybody else

- **Who somebody is comes from one place**, the session of the sign-in. No address of the account pages carries an id
  of a person, and nothing is read from a form field or a header, so there is nothing that could be changed into
  somebody else's. A test walks the addresses and fails if one of them has a part that is filled in.
- **The session cookie is not enough on its own.** `pforte_account` is signed and holds who the person is, how they
  signed in and when; it holds no token. On every request pforte also checks that the person is still active and still
  signed in to the account pages. Locking a person, signing them out everywhere or a new password ends that, and with it
  every copy of the cookie, also one that was stolen.
- **The token of the sign-in is thrown away.** The pages call no API. The admin API refuses a token that was issued
  to `pforte-account-ui`, also from an administrator.
- **Other websites** cannot post a form to the pages (the check described under
  [forms only from pforte's own pages](security.md#forms-only-from-pfortes-own-pages)), cannot read them (no answer
  carries a CORS header) and cannot put them in a frame. No script runs on them.

The cookies are listed with the others under [security measures](security.md#cookies).
