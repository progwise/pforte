# Syncing users from a system of record

pforte does not own the list of people: an ERP, a membership system or an HR tool does. This page shows how to keep pforte in step
with it, with a short script you can start from. There are two ways, and they combine well.

| | When to use it |
| --- | --- |
| **The command line import** (`pforte import users.csv`) | The source can export a CSV file. Run it from a timer, for example every hour. It checks the whole file first, can do a dry run, locks or deletes the people who are gone, and writes the rejected rows to a file you can fix. See [importing users](import.md). |
| **The admin API** | Your own job or service calls pforte: for each change as it happens, or for the whole list on a timer. This page. |

## Make a client for the job

The job is a **machine**: a client that calls the admin API without a person. In the administration open *Clients → New client →
Machine* ([the administration](administration.md)), give it a name, and tick **`directory`**. That scope is enough for
everything here: it allows users, their claims and their lifecycle, but not clients, claim types or the audit log (those need `admin`).
pforte shows the **client secret once**: store it where the job can read it, as you would a password.

## Get an access token

A machine gets its token with the OAuth `client_credentials` grant, from the token endpoint of pforte:

```sh
curl -s https://id.example.com/token -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials -d scope=directory
```

```json
{ "access_token": "CQvi7gt4hSw3H5IgG-9z…", "expires_in": 600, "scope": "directory", "token_type": "Bearer" }
```

The token is valid for **10 minutes**: keep it for the run, and ask for a new one when you get a `401`. Send it as
`Authorization: Bearer <token>` to `https://id.example.com/admin/...`. Many calls with an invalid token from one address are slowed
down (`429`).

## Create or update a person

`PUT /admin/users/by-email/{email}` creates the person, or updates them when the address is known. It is **idempotent**: a job can
call it for everybody on every run, and it says `unchanged` when nothing differs.

```sh
curl -s -X PUT "https://id.example.com/admin/users/by-email/anna.schmidt@example.com" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "firstName": "Anna", "lastName": "Schmidt", "language": "de",
        "claims": { "partner_no": ["12345", "67890"], "customer_no": ["20001"] } }'
```

The answer is `201` for a new person and `200` for a known one:

```json
{
  "dryRun": false,
  "outcome": "created",
  "user": { "id": "01a15ed3-9b15-793a-94eb-c1cd8d6c747a", "email": "anna.schmidt@example.com", "status": "created", "…": "…" },
  "claims": { "customer_no": ["20001"], "partner_no": ["12345", "67890"] }
}
```

What to know:

- **`outcome`** is `created`, `updated` or `unchanged`.
- **Claims.** `claims` sets the values of **exactly the claim types you name**, and replaces what the person had for them. A type you do
  not name is left alone, and `"customer_no": []` removes the person's value. Without `claims` they are not touched. Values are
  always lists in the API, also for a claim type that holds only one; a value must match the pattern of its claim type, and the type
  must exist (create it first, in the administration).
- **What it does not touch.** The e-mail address is the key. The call never sets a password, never changes the status and never
  grants administrator rights.
- **One transaction.** If a claim is invalid, nothing is created or changed, so you never get a person with half their claims.
- **`phone`** is optional, in the form `+4915112345678`; `null` removes it. `language` is a code of two or three letters such as `de`; it chooses the language of the pages and mails for the person (`de`, `en`, `fr` and `hu` are built in).
- **Dry run.** Add `?dryRun=true`: the same checks and the same difference run, then everything is taken back. You get what *would*
  happen, and nothing is written or recorded:

```json
{
  "dryRun": true,
  "outcome": "updated",
  "changes": {
    "profile": { "lastName": { "from": "Person", "to": "Persona" } },
    "claims": { "partner_no": { "from": ["12345", "67890"], "to": ["12345"] }, "customer_no": { "from": ["20001"], "to": [] } }
  }
}
```

### A new person must be activated

A person you create has the status `created`: they cannot sign in yet. `POST /admin/users/{id}/activate` sends them an e-mail with a
link, where they choose their password (`{"activation": {"linkSent": true, "expiresAt": "…"}}`; the link is valid for a week, and a new
call replaces it). Do it for new people; in the administration the same is the button *Send activation link* on the person's page.
For a deactivated person who already has a password, the same call makes them active again, without a link.

Name the application the person is invited to, so the mail says what the account is for and the page after choosing the password
leads on to it:

```sh
curl -X POST "$PFORTE/admin/users/$ID/activate" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"clientId": "my-app"}'
```

`clientId` is optional. It must be a registered client (otherwise the answer is a 400), and the button on the page appears if that
client has a *start address* (see [integrating an application](integrating-a-client.md)). The same button ends a password reset
that began on the sign-in page of that application. Without a `clientId` nothing changes: the page only says to sign in from the
application you came from.

## People who are no longer in the source

Locking is the safe answer: it ends their sessions and they cannot sign in, and `POST /admin/users/{id}/unlock` brings them back.
`deactivate` is for somebody who has left for good, and `DELETE /admin/users/{id}` removes the person (the audit log keeps who they
were). To find who is gone, list the people and compare. `GET /admin/users` is paged: pass `nextCursor` as `cursor`, 200 at most per
page, and filter with `search`, `status` and `claim=partner_no:12345`.

Two rules keep a bad run from doing harm: **never lock administrators** (the API refuses to take the last active administrator away
anyway), and **refuse to lock more than a small share of everybody**. A list that was cut off, or an empty one, would otherwise lock
the whole organisation. The command line import does both, and has a limit of 20% by default.

## A script to start from

It makes everybody in `people` up to date, one call each, renews its token, waits and retries on `429` and `5xx`, reports the rows that
pforte rejected, and with `--lock-missing` locks the people who are not in the list, within the safety limit. It needs Node 22 and no
packages. The values are those of the [development setup](quick-start.md).

```js
// Keeps pforte in step with the people of a system of record. Needs Node 22; no packages.
const pforte = process.env.PFORTE_URL ?? 'http://localhost:3300'
const clientId = process.env.PFORTE_CLIENT_ID ?? 'demo-import'
const clientSecret = process.env.PFORTE_CLIENT_SECRET ?? 'dev-secret'
const MAX_LOCKED_PERCENT = 20

// The people as your system of record knows them. Replace this with a query.
const people = [
  { email: 'ada.example@example.com', firstName: 'Ada', lastName: 'Example', language: 'en', claims: { partner_no: ['10001'] } },
  { email: 'bob.example@example.com', firstName: 'Bob', lastName: 'Example', language: 'de', claims: { partner_no: ['10002', '10003'], customer_no: ['20001'] } },
  { email: 'cy.example@example.com', firstName: 'Cy', lastName: 'Example', claims: { partner_no: ['not-a-number'] } },
]

let accessToken
const renewToken = async () => {
  const response = await fetch(`${pforte}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'directory' }),
  })
  if (!response.ok) throw new Error(`No access token: HTTP ${response.status}`)
  accessToken = (await response.json()).access_token // valid for 10 minutes
}

/** Calls the admin API. Renews the token once when it has expired, and waits and retries on 429 and 5xx. */
const call = async (method, path, body) => {
  for (let attempt = 0; ; attempt++) {
    if (!accessToken) await renewToken()
    const response = await fetch(`${pforte}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    })
    if (response.status === 401 && attempt === 0) { accessToken = undefined; continue }
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, Number(response.headers.get('retry-after') ?? 2 ** attempt) * 1000))
      continue
    }
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
  }
}

// 1. Create or update everybody. The call is idempotent: it says "unchanged" when nothing differs.
const counts = { created: 0, updated: 0, unchanged: 0, rejected: 0 }
for (const { email, ...person } of people) {
  const { status, body } = await call('PUT', `/users/by-email/${encodeURIComponent(email)}`, person)
  if (status === 200 || status === 201) counts[body.outcome]++
  else if (status === 400) { counts.rejected++; console.log(`Rejected ${email}:`, body.errors?.map((error) => `${error.path}: ${error.message}`).join('; ') ?? body.detail) }
  else throw new Error(`${email}: HTTP ${status} ${body.detail}`)
}
console.log(counts)

// 2. Lock the people who are no longer in the source, unless that would be too many (a cut-off list is the usual reason).
const known = new Set(people.map((person) => person.email.toLowerCase()))
const gone = []
for (let cursor; ; ) {
  const { body } = await call('GET', `/users?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
  gone.push(...body.items.filter((user) => !user.isAdmin && ['created', 'active'].includes(user.status) && !known.has(user.email.toLowerCase())))
  if (!(cursor = body.nextCursor)) break
}
console.log(`${gone.length} people are not in the source`)
if (gone.length > 0 && process.argv.includes('--lock-missing')) {
  if (gone.length / (gone.length + known.size) > MAX_LOCKED_PERCENT / 100) throw new Error('Too many to lock: is the list complete?')
  for (const user of gone) await call('POST', `/users/${user.id}/lock`)
  console.log(`Locked ${gone.length}`)
}
```

Run against the development setup, the first run prints:

```text
Rejected cy.example@example.com: /claims/partner_no: "not-a-number" does not match the pattern ^[0-9]{5}$ of "partner_no".
{ created: 2, updated: 0, unchanged: 0, rejected: 1 }
```

and a second run says `unchanged: 2`: the script can run as often as you like.

## Errors

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) documents (`application/problem+json`), with a readable `detail`, and for
invalid input an `errors` list that names each field:

```json
{
  "type": "about:blank", "title": "Invalid request", "status": 400, "detail": "The claims are not valid.",
  "errors": [
    { "path": "/claims/partner_no", "message": "\"abc\" does not match the pattern ^[0-9]{5}$ of \"partner_no\"." },
    { "path": "/claims/nonsense", "message": "There is no claim type \"nonsense\". Create it first." }
  ]
}
```

| Status | Meaning |
| --- | --- |
| `400` | The input is not valid: read `errors`. Retrying the same input will not help. |
| `401` | No token, or the token has expired: ask for a new one. |
| `403` | The client lacks the scope. The `detail` names it, for example `This call needs the admin scope.` |
| `404` | There is no such person, claim type or client. |
| `409` | The action is not possible in the current state, for example locking somebody who is already locked. The `detail` names what is possible. |
| `429`, `5xx` | Slow down or try again later: wait (for `429`, as long as `Retry-After` says) and repeat. The calls above are safe to repeat. |

## Good to know

- **Every call is recorded** in the [audit log](audit-log.md) with the client as the one who did it, and what changed. A dry run is not.
- **Several calls at once are fine.** Two calls for the same new person at once end with one person: the second finds them. The
  command line import makes 8 at a time by default.
- **The whole interface** is described in the [admin API reference](openapi.json), which lists every call, its parameters, its answers
  and the scope it needs. The same description, as a file for tools, is `GET /admin/openapi.json` of your pforte.
