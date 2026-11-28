# Rate limits

pforte limits how often people can try to sign in, ask for codes or reset a password, and how often a
program can fail to authenticate. The limits are counted in the database (table `rate_limits`), so they survive
a restart and hold with more than one instance. Counting is by **client address**, so pforte has to know it.

## Tell pforte about your proxies: `TRUST_PROXY`

Behind a reverse proxy, a load balancer or a Cloudflare tunnel, the address a connection comes from is the
proxy's. The real one is in the `X-Forwarded-For` header. `TRUST_PROXY` is **the number of proxies between the
internet and pforte**:

| Setup | `TRUST_PROXY` |
| --- | --- |
| pforte is reached directly | `0` (default). The header is ignored. |
| One reverse proxy, load balancer or tunnel | `1` |
| A CDN in front of your own reverse proxy | `2` |

Getting it wrong has a price either way, so check it:

- **Too low:** everybody counts as the proxy's address and is held back together after a few mistakes. pforte logs
  a warning once when it sees `X-Forwarded-For` while `TRUST_PROXY` is `0`.
- **Too high:** a client can add entries to `X-Forwarded-For` and choose the address that is counted, which defeats
  the limits.

An IPv6 address counts as its /64, since one connection normally holds a whole /64.

## The limits

Each limit has a window; once a counter reaches its maximum, that rule says "wait" until the window ends. The page
answers `429 Too Many Requests` with a `Retry-After` header and a message in the page's language. At the step that
asks for a phone number to be confirmed at a sign-in, the message is on the step itself: the sign-in is complete,
and *Not now* still leads to the application.

| What | Limit | Counts |
| --- | --- | --- |
| Wrong passwords | 5 per address **and** IP, 20 per address, 30 per IP, each per 15 minutes | Wrong passwords. A right one forgives the mistakes of that address from that IP. |
| Wrong codes | 30 per IP per 15 minutes | Wrong, expired-by-attempts and malformed codes at sign-in, password reset and phone confirmation. On top of this, a code allows 5 attempts. |
| Refused passkeys | 30 per IP per 15 minutes | Sign-ins with a passkey that pforte refused, for whatever reason. A held-back address is not checked at all, also not with the right passkey. |
| Asking for another code | 10 per IP per hour | "Send a new code" and "send it by e-mail instead", and every code to confirm a phone number on the account pages or at a sign-in, or to change it on the account pages. The first code of a sign-in is not counted: it needs the password. A user also gets at most one code a minute and five an hour. |
| Pictures a person uploads | 10 per person per hour | Every upload on the [account pages](account.md#a-picture) that is a file of the right size, whether it becomes a picture or not: reading it is the work. Counted by person, not by address. |
| Password reset requests | 5 per address and 30 per IP per hour | Every request, for an address that exists or not. |
| Wrong activation links | 20 per IP per 15 minutes | Links that do not work. |
| Failed authentication of applications and administrators | 30 per IP per 15 minutes | Wrong client secrets at `/token`, and missing or wrong tokens at `/admin`. |

Things to know:

- **No account is revealed.** The counters for an address are kept whether or not the address belongs to someone, and
  the answers are the same. They use a keyed hash of the address, never the address.
- **While an address is held back, the password is not checked at all**, so even the right one is refused. That is
  what makes guessing pointless. A person who is held back can try again after the wait, or from another network.
- **Applications and administrators are only counted when they fail.** A valid client is never throttled, which keeps
  the CSV import fast (it makes over a thousand calls a second). At the admin API a valid token always works, even
  from an address that others failed from. At `/token`, where secrets can be guessed, an address that failed too
  often waits before its next attempt is even looked at.
- The password reset limit per IP is generous (30), because many people can sit behind one address; the limit per
  address protects a mailbox.
