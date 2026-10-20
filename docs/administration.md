# The administration UI

Back-office staff run pforte from a web page at **`/manage`** of your pforte address (for example
`https://id.example.com/manage`): finding people, locking them, resetting passwords, importing a list. It is made of plain
server-rendered pages, with no JavaScript, in the same look as the sign-in pages (see
[branding](branding-and-languages.md)), and it works on a tablet.

## Who can use it

An **administrator**: a user whose account has the admin right (`isAdmin`). Nobody else is let in: other people can sign in to
pforte, but the administration tells them that it is not open to them.

### The first administrator

Somebody has to be the first. Set **`BOOTSTRAP_ADMIN_EMAIL`** to an address and start pforte: if there is no administrator yet,
that address becomes one and is mailed a link to choose a password (the same activation link as any new user gets). Once an
administrator exists nothing happens, so the setting can stay. If the mail cannot be sent, nothing is changed, an error is
logged and the next start tries again.

If the address already belongs to a user, that user is made an administrator, and gets the link only if they still have to
choose a password. In development the seed already has `admin@example.com` (password `dev-password`).

Afterwards administrators are made like any other change: set the admin right of a user, in the administration or through the
API (`isAdmin`).

## Signing in

The administration signs in the way every application does: it sends you to pforte's sign-in page and takes you back. You
enter your password and **always the code of the second factor**, also on a computer where you chose "remember this device", and
also when you are signed in to pforte for another application without a code. (The administration notices a weaker sign-in
and asks for a new one.) That is the one place where a code cannot be skipped.

- The session lasts **up to an hour**, then you are taken through the sign-in again. Without a password: if your sign-in
  of pforte is still current it is a few redirects.
- **Sign out** ends the session in the administration **and** your sign-in of pforte, so the next person on a shared
  computer cannot walk in. pforte shows a short question to confirm it.

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
with the other clients as built in and cannot be changed, rotated or deleted.

## Users

**Users** (`/manage/users`) is where most of the work is.

- **Find people** by name or e-mail, by status, and by the value of a claim (for example everybody with a certain partner
  number). The search is a form that is also a link, so a search can be bookmarked or sent to a colleague. Long lists are
  paged ("Next users").
- **A person's page** shows their status, when they last signed in, when they were created, and whether e-mail and phone are
  confirmed. Below that are the **profile** (names, e-mail, mobile phone, language, and whether they are an administrator)
  and their **claims**: one value per line for every claim type that exists, with its format and description. A form that
  cannot be saved comes back with what you typed and says what is wrong, field by field.
- **New user** creates a person in the status "Not activated". Sending them the activation link comes next to it.

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
