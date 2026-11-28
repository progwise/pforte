# The administration UI

Back-office staff run pforte from a web page at **`/manage`** of your pforte address (for example
`https://id.example.com/manage`): finding people, locking them, resetting passwords, importing a list. It is made of plain
server-rendered pages, with no JavaScript, in the same look as the sign-in pages (see
[branding](branding-and-languages.md)), and it works on a tablet.

## Who can use it

An **administrator**: a user whose account has the admin right (`isAdmin`). Nobody else is let in: other people can sign in to
pforte, but the administration tells them that it is not open to them. That page has the button **Sign in with a different
account**, for an administrator whose browser is signed in to pforte as somebody else: it asks for password and code again,
and when another person signs in, the first is signed out of pforte.

### The first administrator

Somebody has to be the first. Set **`BOOTSTRAP_ADMIN_EMAIL`** to an address and start pforte: if there is no administrator yet,
that address becomes one and is mailed a link to choose a password (the same activation link as any new user gets). The mail
says that the account is for the administration, and the page after choosing the password has the button *Continue to
Administration*. Once an administrator exists nothing happens, so the setting can stay. If the mail cannot be sent, nothing is changed, an error is
logged and the next start tries again.

If the address already belongs to a user, that user is made an administrator, and gets the link only if they still have to
choose a password. In development the seed already has `admin@example.com` (password `dev-password`).

Afterwards administrators are made like any other change: set the admin right of a user, in the administration or through the
API (`isAdmin`). When the administration sends the activation link to somebody who has the admin right, the mail and the
page after choosing the password lead on to the administration, as they do for the first administrator. The same holds
when the administration resets the password of somebody who has the admin right: the page after choosing the new one has
the button *Continue to Administration*. Through the API that is the `clientId` of the
[activation](syncing-users.md#a-new-person-must-be-activated) and of the password reset: `pforte-admin-ui`.

## Signing in

The administration signs in the way every application does: it sends you to pforte's sign-in page and takes you back. You
enter your password and **always the code of the second factor**, also on a computer where you chose "remember this device", and
also when you are signed in to pforte for another application without a code. (The administration notices a weaker sign-in
and asks for a new one.) That is the one place where a code cannot be skipped.

- The session lasts **up to an hour**, then you are taken through the sign-in again. Without a password: if your sign-in
  of pforte is still current it is a few redirects.
- **Sign out** ends the session in the administration **and** your sign-in of pforte, so the next person on a shared
  computer cannot walk in. pforte asks before it ends its sign-in: with "No, only leave Administration" you are out of the
  administration, but the browser stays signed in at pforte.

## What the pages do

Everything a page does is an ordinary call of the [admin API](../CONTRIBUTING.md#trying-the-admin-api), made for you, in the same
process, with your own token. So the rules, the checks and the audit log are those of the API, and what you change is
recorded **under your name**, with your address and browser.

Two rules protect you from locking yourself out, for the API as much as for the pages:

- **The last active administrator stays.** Nobody can lock, deactivate, delete or take the admin right from the last
  administrator who can sign in.
- **Nobody does these to themselves.** You cannot lock, deactivate, delete or demote your own account. Ask another
  administrator.

The built-in client `pforte-admin-ui`, which the administration signs in with, is created by pforte at every start. It is listed
with the other clients as built in and cannot be changed, rotated or deleted. Its start address is the administration itself
(`/manage` of your pforte address), so a password reset that began with *Forgot your password?* on the sign-in page of the
administration ends with the button *Continue to Administration*. A second one, `pforte-account-ui`, belongs to
[the account pages](account.md), where every person sees their own account.

## Users

**Users** (`/manage/users`) is where most of the work is.

- **Find people** by name or e-mail, by status, and by the value of a claim (for example everybody with a certain partner
  number). The search is a form that is also a link, so a search can be bookmarked or sent to a colleague. Long lists are
  paged ("Next users").
- **A person's page** shows their status, when they last signed in, when they were created, and whether e-mail and phone are
  confirmed. If the person chose their phone number themselves on the account pages, it says since when: a sync or an import
  leaves that number alone, and you can still change it in the profile ([whose number it is](sms.md#whose-number-it-is)). If the person gave themselves a [picture](account.md#a-picture), it is shown with the button *Remove picture*, for the picture that should not be there; nobody but the person can set one, and they can upload another afterwards. Below that are the **profile** (names, e-mail, mobile phone, language, and whether they are an administrator)
  and their **claims**: one value per line for every claim type that exists, with its format and description. A form that
  cannot be saved comes back with what you typed and says what is wrong, field by field.
- **New user** creates a person in the status "Not activated". Sending them the activation link comes next to it.
- **Actions** on a person's page depend on their status: lock and unlock, send the activation link (or activate again),
  deactivate, reset the password, sign out everywhere, and delete. Each opens a page that names the person and says what
  will happen before anything changes; deleting asks you to type the person's e-mail address. Locking, deactivating,
  deleting, resetting the password and signing out everywhere end the person's sessions at pforte and tell the applications
  that have a back-channel logout address to end theirs ([signing out](integrating-a-client.md#signing-out)). The last administrator cannot
  be locked, deactivated, deleted or demoted, and nobody can do these to themselves; the page says so.
- **Where the person is going.** The page that sends the activation link, and the one that resets a password, ask for
  the **application** the person uses: the applications that have a start address
  ([registering one](integrating-a-client.md#register-your-application)). The mail with the activation link then names
  it, and the last page the person sees has a button that leads on to it. With exactly one such application it is
  chosen already; with several you choose, or leave it at "No application". Without a choice the last page leads on
  only where there is exactly one application, and otherwise says that the person can sign in now. For somebody who
  has the admin right the page does not ask: their way leads to the administration.
- **Signed in** shows the browsers where the person is signed in (with their applications, and whether a code was entered
  or a passkey used)
  and the applications that stay signed in without a browser because they hold a refresh token, such as an app on a phone.
  **Passkeys** lists the person's passkeys with the browser each was created with, whether it is synced to their other
  devices and when it was last used. One can be removed: it cannot sign in any more, and sessions that are open stay
  open. A person adds [passkeys](passkeys.md) themselves; nobody can create one for
  somebody else. **Remembered devices** lists where no code is asked for (the person ticked the box with a code, or when
  they activated their account); one or all can be
  revoked, and the next sign-in there asks for a code again. **Recent sign-ins** shows the last ten sign-in events: successes,
  wrong passwords and codes, codes sent, and sign-ins held back after too many attempts, with the address they came from.

## Clients

**Clients** (`/manage/clients`) are the applications that sign people in with pforte and the machines that call the admin API.

- **New client** first asks what the client does. An **application** (a website, a mobile app, a backend) is *public* when
  it cannot keep a secret and *confidential* when it can. It has redirect URIs, optional addresses to return to after signing
  out, an optional back-channel logout address, the scopes it may ask for and whether it may stay signed in with refresh
  tokens. A **machine** has no person and no redirect URIs, only the rights `admin` (everything in the API) and/or
  `directory` (users and their claims).
- **The secret** of a confidential client is shown once, right after creating the client or replacing the secret. pforte keeps
  only a fingerprint and cannot show it again; if it is lost, replace it. The old secret stops working at once.
- **Claims**: an application receives only the claim types you tick on its page.
- **Delete** asks you to type the client ID. It also ends every sign-in and token issued to the client.
- The client ID and the type cannot be changed after creating; the entries that can be changed come back with what you typed and
  say what is wrong, as on the user pages.

## Claim types

**Claim types** (`/manage/claim-types`) list the kinds of facts about a person that can exist, such as a customer number. A claim
type has a key (the claim name in tokens), a description, an optional format (a regular expression every value must match) and
says whether a person can hold several values. New ones appear on the users' pages at once. Changing the format or going
from several values to one is refused while existing values would break the rule. Deleting is refused while people hold values,
unless you tick the box to delete those values too.

## Audit log

**Audit log** (`/manage/audit`) shows who did what, when and to whom, newest first, 50 at a time: every change made in the
administration or through the API, and the sign-in events. A row shows the person or client who did it, the action, whom it was
about, the address it came from and, under "Details", everything pforte recorded, including the browser.

Filter by the **person it was about** (their e-mail address), by **who did it** (a person's e-mail address or a client's ID), by
**action** (an exact one such as `user.lock`, or a start such as `user.*`; the field suggests the known ones), and by a **date
range**. Days are counted in your `TIME_ZONE`. Like the search on the users page, a filtered view is a link you can bookmark or
send. A person who was deleted shows with the e-mail address kept in the event. The page of a person links to all events about
them.

## Import

**Import** (`/manage/import`) creates and updates people and their claims from a CSV file, the same as `pforte import` on the
command line, which is the better tool for very large files or for a job that runs by itself. The page takes files up to 5 MB.

1. **Choose the file and the options.** The file has a header row with `email`, `first_name` and `last_name`, optionally `phone`
   and `language`, and one column for every claim type you want to set, named like the claim type. A person whose e-mail
   address is already known is updated, anybody else is created. Say how the file is encoded (Excel in Germany writes
   Windows-1252 unless you choose "CSV UTF-8"), what separates several values in one cell, whether to skip columns that are not
   claim types, and what happens to people who are **not in the file**: nothing, lock them, or delete them. Delete needs you to
   type a word, and a safety limit (20% by default) stops the import when a cut-off file would affect many people.
   Administrators are never touched.
2. **Check.** Nothing is written yet. The page shows how many people would be created, updated and left unchanged, what
   would change, who would be locked or deleted, and the rows that cannot be imported, each with its line and the reason.
   The rejected rows can be downloaded as a CSV in the layout of your file plus the columns `line` and `reason`, to fix and import
   again.
3. **Import now.** The file you checked is imported, exactly with the options you checked. Rejected rows are skipped.

An example file for the seeded database is [examples/users.csv](../examples/users.csv).

The checked file is kept in the server's memory (never on disk) for 30 minutes, one per administrator, and is let go of as
soon as it is imported. The import is made through the admin API with your own token, so it is recorded in the audit log under
your name, person by person.

Times are shown in the time zone you set with `TIME_ZONE` (default UTC), in the language of the administrator.

## For those who call the admin API

The API accepts two kinds of token, and `GET /admin/whoami` says which you are:

- A **machine's** token (`client_credentials`) with the scope `admin` or `directory`, as before.
- A **person's** token, only if it was issued to `pforte-admin-ui` and the person is an active administrator at this very
  moment. It is checked on every request, so locking someone or removing the admin right ends their access at once. A token
  of any other application is not accepted, even for an administrator.

## Languages

The administration speaks **English and German**. Other languages show the English texts. The language is the one set for
the administrator (`language` of the user), else the browser's.
