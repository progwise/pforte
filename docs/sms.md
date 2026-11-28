# Sending codes by SMS

pforte sends the second factor and password reset codes by e-mail. If you configure an SMS provider, users
who have **confirmed their phone number** get the codes by SMS instead, and can still ask for the e-mail
(`Send the code by e-mail instead`). Without SMS settings everything goes by e-mail. Links and notices are never an
SMS: the activation link and the notice that a password was changed always go by e-mail.

pforte has no built-in provider. It sends one HTTP request per message, built from settings, so any provider
with an HTTP API works, and changing the provider is a configuration change. You choose the provider; check
its data protection terms for your users' phone numbers.

## Settings

| Variable | |
| --- | --- |
| `SMS_PROVIDER` | `http`. Switches SMS on. |
| `SMS_URL` | Where to send the request. `https` (plain `http` only for localhost), because the headers carry your credentials. |
| `SMS_METHOD` | `POST` (default) or `PUT`. |
| `SMS_HEADERS` | A JSON object with the headers, usually the credentials. May also be read from `SMS_HEADERS_FILE`. |
| `SMS_CONTENT_TYPE` | `json` (default) or `form`. |
| `SMS_BODY` | The body, with `{{to}}`, `{{text}}` and, if you set `SMS_FROM`, `{{from}}`. Values are escaped for the content type, so a text can never break the JSON or the form. |
| `SMS_FROM` | The sender, for providers that need one. |
| `SMS_SUCCESS_PATTERN` | Optional regular expression. Only for providers that answer `200` even when they refuse a message and say so in the body. |

A `2xx` answer counts as sent. Network errors, `429` and `5xx` are tried once more; any other answer fails at
once. When an SMS cannot be sent at sign-in, pforte sends the same code by e-mail, so an outage at the provider
does not lock anybody out. The provider's answer is never shown to users or written to the log, as it can
contain the number and the code.

On a Docker Swarm the body needs care: a swarm reads `{{...}}` in the environment of a service as a template of its own
and refuses `{{to}}`. The [example for Docker Swarm](../examples/swarm/README.md#codes-by-sms) takes care of it.

## Twilio

```sh
SMS_PROVIDER=http
SMS_URL=https://api.twilio.com/2010-04-01/Accounts/ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/Messages.json
SMS_CONTENT_TYPE=form
SMS_BODY='To={{to}}&From={{from}}&Body={{text}}'
SMS_FROM=+4915100000000        # a Twilio number, or an alphanumeric sender ID where the country allows it
SMS_HEADERS='{"Authorization":"Basic <base64 of ACxxxx:auth-token>"}'
```

Make the header value with `printf 'ACxxxx:your-auth-token' | base64`. An API key works too: use the API key
SID and secret in place of the account SID and auth token (the account SID stays in the URL). Twilio answers
`201` when it accepted the message and `4xx` with a JSON error when it did not, so no `SMS_SUCCESS_PATTERN` is
needed. To send through a Messaging Service instead of a number, replace `From={{from}}` with
`MessagingServiceSid=MGxxxxxxxx` and leave out `SMS_FROM`.

## seven.io

```sh
SMS_PROVIDER=http
SMS_URL=https://gateway.seven.io/api/sms
SMS_CONTENT_TYPE=form
SMS_BODY='to={{to}}&from={{from}}&text={{text}}'
SMS_FROM=Example               # up to 11 letters, or a number
SMS_HEADERS='{"X-Api-Key":"your-api-key","Accept":"application/json"}'
SMS_SUCCESS_PATTERN='^\s*\{\s*"success"\s*:\s*"100"'
```

seven.io reports a refused message (wrong key, no credit) in the body of a `200` answer, with `"success"` other
than `"100"`, which is why the pattern is needed. This recipe has been tried against a live account: the message
was accepted and delivered.

## Any other provider

Look in its API documentation for the URL, the way it authenticates, the fields for number, text and sender,
and whether errors show as HTTP status or only in the body. Then fill in the settings above. If a provider needs
something a static request cannot do, for example fetching a token before each call, open an issue.

## Phone numbers

Numbers are stored in international format (`+4915112345678`). A number only receives codes after the user has
confirmed it with a code, which happens right after choosing the first password. When an administrator changes
a user's number, the confirmation is dropped, and codes go by e-mail until the new number is confirmed. A code
confirms the number it was sent to and no other: a change of the number ends the code that is on its way to the old
one, and the pages then offer to send a code to the new number.

A person who has a number that is not confirmed (they skipped the step, got the number later, or it was changed)
is **asked at their next sign-in**. After the password and the code, with a remembered device or with a passkey, and
before they are back in the application, one page says that the number is not confirmed and that their codes come by
e-mail until it is, with the buttons *Confirm with a code by SMS* and *Not now*. Nothing is sent before the person
presses the button: a message costs money. With the code from the SMS the number is confirmed and the sign-in goes on;
with *Not now* it goes on as well, and that browser is not asked again for 30 days, unless the number changes: a
new number is a new question. Skipping the step at the end of an activation counts as the same answer. The sign-in
is complete before the page is shown, so the person gets to their application whatever they answer, also when
[a limit](rate-limiting.md) holds back the codes of their network address: the page then says how long to wait and
keeps *Not now*. The page never comes without a sign-in page: not when an application finds the person signed in
already.

The same can be done at any time on [the account pages](account.md): the overview there says so next to the number
and has the button *Confirm with a code by SMS*. An administrator sees on a person's page whether the phone is
confirmed, and cannot confirm it for them: only the person holds the phone.

### Whose number it is

Until a person says otherwise, the number is the organisation's: the administration, the admin API, an import or a sync
sets it, and each change drops the confirmation.

A person can **change their number themselves** on [the account pages](account.md), with a code sent to the new
number. From then on the number is theirs:

- **A sync or an import leaves it alone.** `PUT /admin/users/by-email/{email}`, which both use, ignores `phone` for that
  person, whatever it names: the number they had, another one, or `null`. Everything else in the call is applied as
  before, and the answer says `unchanged` when nothing else differs. Otherwise a source that still has the old number
  would put it back at its next run, and the person would be asked to confirm a number they no longer have.
- **The API says so.** A user has `phoneSetByUserAt`, the time of the person's last change, or `null`. A job that wants
  to keep its source up to date reads the person's number from pforte when that field is set.
- **An administrator can still correct it**, in the administration or with `PATCH /admin/users/{id}`. The corrected
  number is not confirmed, as after every change by the back office, and it stays the person's: the source still does not
  overwrite it.
- **There is no way back to the source** for that person. If you need one, open an issue and say what for.

The change is in the [audit log](audit-log.md) as `user.phone.change`, with the number the person had and the new one.

### Confirming a number in your own application

Your application can also show the step itself, for example in its profile page. pforte still sends the code and
checks it; your application only shows a field for it. It needs a machine client with the `directory` or `admin` scope
([syncing users](syncing-users.md#make-a-client-for-the-job)), and calls the admin API from its server, never from the
browser:

```sh
# 1. The person presses "confirm" in your application: pforte sends a 6-digit code by SMS to the stored number.
curl -X POST "$PFORTE/admin/users/$ID/send-phone-code" -H "authorization: Bearer $TOKEN"
# {"sentTo":"+49•••••••••78","expiresAt":"2026-01-01T10:10:00.000Z"}

# 2. The person types the code into your application: pforte checks it and confirms the number.
curl -X POST "$PFORTE/admin/users/$ID/confirm-phone" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"code":"123456"}'
# the user, with "phoneVerifiedAt" set
```

`$ID` is the person's ID at pforte, which is the `sub` of their ID token. From the next sign-in on, their codes go by SMS.

| Answer | Meaning |
| --- | --- |
| `200` | The code was sent, or the number is confirmed. |
| `409` | Nothing to confirm: the person has no number, it is confirmed already, the person is not active, or this pforte sends no SMS. The `detail` says which. |
| `422` | (`confirm-phone`) The code is wrong, has expired or was tried too often. A code has five attempts and is valid for ten minutes; send a new one. |
| `429` | (`send-phone-code`) A person gets one code a minute and five an hour. `Retry-After` says how long to wait. |
| `503` | (`send-phone-code`) The SMS could not be sent. No code is waiting; try again later. |

Whether a person has something to confirm is in what your application already gets: `phone_number_verified` in the ID
token and at the userinfo endpoint (scope `phone`), and `phoneVerifiedAt` of the user in the admin API.

**Call it only for the person who is signed in to your application, and only when they asked for it.** The code shows
that whoever typed it holds the phone; that this is the person the account belongs to is what your application vouches
for. Each code is an SMS that somebody pays for, so send one when the person presses the button, not when a page opens.
Both calls are recorded in the audit log with your client as the actor.
