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
| `login.code_failed` | A code was not accepted. | `purpose`, `reason` (`wrong`, `exhausted`, `expired`, `none`; `sessions_ended` at sign-in when the person's sessions were ended after the password was accepted, so that the sign-in has to start again; and for a password reset also `unknown_user`, `not_allowed`, `malformed`). |
| `login.passkey_failed` | A sign-in with a [passkey](passkeys.md) was refused. | `reason`: `malformed` (no answer of a device), `expired` (the question was not asked in this sign-in, was answered before or has run out), `unknown_passkey` (pforte does not know it, as after it was removed), `not_allowed` (its person is locked or deactivated), `wrong_person` (the device named another person than the passkey belongs to), `verification_failed` (wrong origin or host, the device did not check the person, the signature or its counter did not hold, or the passkey was removed or used by another sign-in while this one was being checked). The target is the person the passkey belongs to, where pforte knows the passkey. |
| `login.succeeded` | A sign-in was completed. | `method` (`code`, `passkey` or `remembered_device`), `channel`, and `acr`: `urn:pforte:acr:mfa` after a code or with a passkey, `urn:pforte:acr:pwd` on a remembered device. `deviceRemembered: true` when the person ticked "Remember this device" with the code and the browser was not remembered yet. |
| `login.blocked` | A rate limit held somebody back. | `scope`: `password`, `code`, `code_resend`, `passkey`, `reset`, `reset_code`, `activation` or `phone_code`. Written **once per 15 minutes** for the same address or IP, not for every refused request, so an attack cannot fill the log. |
| `user.activate.complete` | A person chose their first password with the activation link. | `email`, and `deviceRemembered: true` when they ticked "Remember this device" on that page. |
| `user.activation.request` | A person who has no password yet asked for their activation link at `/reset`. The link itself is never recorded. | `self: true`, `expiresAt`. |
| `user.password_reset.request` | Somebody asked for a password reset at `/reset`, for an address that has an account. | `self: true`. A reset an administrator starts is recorded as `user.password_reset.request` by that client. |

For sign-in events the actor is the user (`actorType: user`), and the target is that user. `ip` and `userAgent` are
those of the person trying. Check that `TRUST_PROXY` is set right (see [rate limits](rate-limiting.md)), or `ip` is
your proxy's address.

### What is not stored

- **A password is never stored**, nor is a code or a token.
- A remembered device is recorded on the event that remembered it (`deviceRemembered`), so the event tells how: after a code
  (`login.succeeded`) or by an activation (`user.activate.complete`). The token of the device is not recorded.
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

## What a person does to their own account

On [the account pages](account.md) a person can sign out everywhere, forget remembered devices, remove a passkey and ask
for the code of a new password. These are the events an administrator's action writes, `user.sessions.end`,
`user.device.revoke`, `user.devices.revoke`, `user.passkey.remove` and `user.password_reset.request`, with two
differences: the actor is the person themselves (`actorType: user`, `actorId` equal to the target), and the details carry
`self: true`.

A person can also confirm their phone number, which only they can do: `user.phone.confirm`, with `self: true`, on the
account pages and at the step right after an activation. A wrong code is a `login.code_failed` with
`purpose: activation` in both places; the code sent from the account pages is a `login.code_sent` with that purpose and
`channel: sms`.

An application can show that step in its own pages ([SMS](sms.md#confirming-a-number-in-your-own-application)). Then the
actor is its client: `user.phone.confirm.request` when it had the code sent (with `expiresAt`, never the code), and
`user.phone.confirm` without `self` when the code the person typed was right. A wrong code is not recorded there.

### Passkeys

| Action | When | Details |
| --- | --- | --- |
| `user.passkey.add` | A person added a passkey: on the account pages, in the offer after a sign-in with a code, or at the end of their activation. Only a person can: nobody creates a passkey for somebody else. | `passkeyId`, `label` (the browser it was created with, such as "Safari, iPhone"), `synced`, `self: true` |
| `user.passkey.remove` | A passkey was removed, by the person or by an administrator. | `passkeyId`, `label`, and `self: true` when the person did it |

Neither event holds the key or the id a device knows the passkey by.

## Telling applications

Six actions end every session of a person: `user.lock`, `user.deactivate`, `user.delete`, `user.sessions.end`,
`user.password_reset.request` when an administrator starts the reset, and `user.password_reset.complete`. Their events
carry `sessionsEnded` and `clientsToNotify`: how many applications with a back-channel logout address the person was
signed in to, and are therefore sent a logout token (see [signing out](integrating-a-client.md#signing-out)). The number
is written with the action, before the calls go out, and the log is append-only, so it says how many were to be told, not
how many were.

| Action | When | Details |
| --- | --- | --- |
| `user.sessions.notify_failed` | pforte gave up telling an application. | `clientId`, `attempts` (how many calls were made), `email`, and `reason`: `http_500` (the status the application answered with), `timeout` (no answer within 2.5 seconds), `unreachable`, `private_address` (pforte refuses to call it, see `OUTBOUND_ALLOW_PRIVATE_ADDRESSES`), `signed_in_again` (after a failed call the person signed in to the application anew, and a logout for all their sessions would have ended that too) or `address_removed` (after a failed call the client lost its logout address). |

The actor of this event is pforte itself (`actorType: system`), the target is the person. The application is still signed
in until it next renews its tokens; if that is too long, end its session of the person there.

This event records a failure that pforte saw. **Its absence does not confirm that an application was told:** the calls are
made after the action, from memory, so a restart of pforte in those seconds loses both the call and the event.

## How long events are kept

Sign-in events pile up, since every attempt writes one, and say little after a while. They are **deleted after 180 days**
(`AUDIT_LOGIN_RETENTION_DAYS`; `0` keeps them for ever). Events about changes made by administrators and applications
(`user.*`, `client.*`, …) are always kept.
