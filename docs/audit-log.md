# The audit log

pforte writes an audit event for every change an administrator or an application makes, and for every attempt
to sign in. Administrators read it through the admin API (`GET /admin/audit-events`, `admin` scope), newest first,
filtered by actor, action, target and time. `action=login.*` matches a prefix.

An event has: who did it (`actorType`, `actorId`), what (`action`), to whom (`targetType`, `targetId`), `details`, the
client's address (`ip`) and `userAgent`, and the time. The log is append-only and has no links to users, so an event
outlives the user it is about.

## Sign-in events

| Action | When | Details |
| --- | --- | --- |
| `login.password_failed` | A password was not accepted. | `reason`: `wrong_password`, `unknown_user` or `not_allowed` (the account is locked, deactivated or has no password yet). For an address that no user has: `emailHash` instead of a target. |
| `login.code_sent` | A code went out. | `purpose` (`login`, `password_reset`, `activation`), `channel` (`email` or `sms`), `fellBackToEmail` when an SMS could not be sent. |
| `login.code_failed` | A code was not accepted. | `purpose`, `reason` (`wrong`, `exhausted`, `expired`, `none`, and for a password reset also `unknown_user`, `not_allowed`, `malformed`). |
| `login.succeeded` | A sign-in was completed. | `method` (`code` or `remembered_device`), `channel`, and `acr`: `urn:pforte:acr:mfa` after a code, `urn:pforte:acr:pwd` on a remembered device. |
| `login.blocked` | A rate limit held somebody back. | `scope`: `password`, `code`, `code_resend`, `reset`, `reset_code`, `activation` or `phone_code`. Written **once per 15 minutes** for the same address or IP, not for every refused request, so an attack cannot fill the log. |
| `user.activation.request` | A person who has no password yet asked for their activation link at `/reset`. The link itself is never recorded. | `self: true`, `expiresAt`. |
| `user.password_reset.request` | Somebody asked for a password reset at `/reset`, for an address that has an account. | `self: true`. A reset an administrator starts is recorded as `user.password_reset.request` by that client. |

For sign-in events the actor is the user (`actorType: user`), and the target is that user. `ip` and `userAgent` are
those of the person trying. Check that `TRUST_PROXY` is set right (see [rate limits](rate-limiting.md)), or `ip` is
your proxy's address.

### What is not stored

- **A password is never stored**, nor is a code or a token.
- **An address that no user has is not stored**, only `emailHash`: a short keyed hash. The same address gives the same
  hash, so repeated tries show up, but the address cannot be read back. People type passwords into the e-mail field,
  and those must not end up in a log.
- A sign-in that cannot be written to the log still goes through. The failure is reported in pforte's own log.

### Looking at a brute force attempt

```sh
curl -H "authorization: Bearer $TOKEN" \
  'https://id.example.com/admin/audit-events?action=login.*&limit=100'
```

An attack shows as many `login.password_failed` events from one `ip` (or for one target from many), followed by a
`login.blocked`. To let the person in again at once, call `POST /admin/users/{id}/unlock`: for a user who is not locked
it changes nothing but forgets the failed attempts held against their address.

## How long events are kept

Sign-in events pile up, since every attempt writes one, and say little after a while. They are **deleted after 180 days**
(`AUDIT_LOGIN_RETENTION_DAYS`; `0` keeps them for ever). Events about changes made by administrators and applications
(`user.*`, `client.*`, …) are always kept.
