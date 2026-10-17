# Sending codes by SMS

pforte sends the second factor and password reset codes by e-mail. If you configure an SMS provider, users
who have **confirmed their phone number** get the codes by SMS instead, and can still ask for the e-mail
(`Send the code by e-mail instead`). Without SMS settings everything goes by e-mail.

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
than `"100"`, which is why the pattern is needed. This recipe follows seven.io's documentation; it has not been
tried against a live account.

## Any other provider

Look in its API documentation for the URL, the way it authenticates, the fields for number, text and sender,
and whether errors show as HTTP status or only in the body. Then fill in the settings above. If a provider needs
something a static request cannot do, for example fetching a token before each call, open an issue.

## Phone numbers

Numbers are stored in international format (`+4915112345678`). A number only receives codes after the user has
confirmed it with a code, which happens right after choosing the first password. When an administrator changes
a user's number, the confirmation is dropped, and codes go by e-mail until the new number is confirmed.
