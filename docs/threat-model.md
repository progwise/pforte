# Threat model

What pforte defends against, what it only partly defends against, and what is left to you as the operator. It is
written to be honest: a list that claimed everything would be useless for deciding whether pforte fits.

See also: [security measures](security.md), [rate limits](rate-limiting.md), [the audit log](audit-log.md).

## What is protected

- **Accounts**: passwords and the second factor (codes by e-mail or SMS, remembered devices).
- **Identity data**: the profile and claims of your users, which end up in tokens for applications.
- **The admin API**: whoever holds a client with the `admin` scope controls every account.
- **The signing keys and cookie keys**: they let tokens and cookies be forged.
- **The audit log**: the record of what happened.

## What is trusted

| Who or what | Trusted to |
| --- | --- |
| **You, the operator** and the host pforte runs on | Keep the secrets, the database and the server safe. Anyone with access to these can do anything. |
| **The reverse proxy or tunnel** in front of pforte | Terminate https and report the real client address (`TRUST_PROXY`). |
| **The database** | Be reachable by pforte only. |
| **Your mail and SMS providers** | Deliver codes to the right person. They can read every code they carry. |
| **Registered applications** (clients) | Keep their own secrets and use the redirect addresses they were registered with. |
| **Administrator clients** | Use the `admin` and `directory` scopes responsibly. `admin` is full control. |

## Attackers considered

An anonymous attacker on the internet; someone who has a user's password (a leak elsewhere); a malicious website a user
visits; a registered application that misbehaves; someone who can read pforte's logs or a backup; someone who has stolen an
administrator client's secret. **Not considered:** an attacker who controls the host or the database while pforte runs, or the
operator themselves.

## Threats and what pforte does

**Defended** means a measure stops it as far as it can be stopped. **Partly** means it is made harder or detected. **Not
defended** means pforte cannot do anything about it; the last column says what you can do.

| Threat | | What pforte does, and what remains |
| --- | --- | --- |
| **Guessing passwords** | Defended | Passwords are checked with argon2id. At most 5 wrong passwords per address and IP in 15 minutes, 20 per address, 30 per IP; a held-back address is not even checked. A new password needs 10 characters. There is no check against lists of leaked passwords. |
| **Credential stuffing** (leaked passwords from other sites) | Partly | The limits above slow it down, and a right password alone does not sign in: the code is needed. An attacker who has the right password does learn it is right, and can cause codes to be sent to the user, at most one a minute and five an hour. |
| **A user who is phished** (a fake page relays password and code live) | Not defended | A one-time code can be relayed. A remembered device never lowers the check for a client that asks for `urn:pforte:acr:mfa`. Phishing-resistant sign-in (passkeys) is not in pforte yet. Train users to check the address. |
| **SIM swap, SMS interception** | Not defended | SMS is the weakest channel. A number only receives codes after the user confirmed it. If your users matter enough, do not enable SMS, so codes go by e-mail only. |
| **A compromised mailbox** | Not defended | E-mail codes and the password reset go to the mailbox, so whoever has it can take over the account. A confirmed phone number moves the reset code to SMS. |
| **Finding out who has an account** (enumeration) | Defended | The sign-in answer is the same for unknown and wrong; the same hashing work is done for both. The reset page answers identically and before it looks the account up, so the time says nothing either. Rate limits count every address, existing or not. Not hidden: a right password followed by the code step shows the account exists to the person who knows the password. |
| **Brute-forcing a code** | Defended | Six digits, 10 minutes, 5 attempts per code (the sixth is refused even when right), 30 wrong codes per IP in 15 minutes, one new code a minute and five an hour per user. Codes are stored only as a keyed hash and compared in constant time. |
| **Stealing a session or a remembered-device cookie** | Partly | Cookies are `HttpOnly` and `Secure`; pforte's own are `SameSite=Strict`; no script runs on pforte's pages. A cookie that was stolen still works: a session until it ends, a remembered device until it expires (90 days) or is revoked. An administrator can end sessions and revoke devices (`end-sessions`, `lock`). |
| **Cross-site request forgery** | Defended | Forms are only accepted from pforte's own pages (`Sec-Fetch-Site`, `Origin`), cookies are `SameSite`, and the provider endpoints follow the standard. |
| **Clickjacking** | Defended | No page can be framed (`frame-ancestors 'none'`, `X-Frame-Options`). |
| **Cross-site scripting** | Defended | The pages contain no script, every value is escaped, the policy allows no script. Branding values are checked strictly before they reach the stylesheet, and the logo is served so that it cannot run. |
| **Open redirects, redirect URI tricks** | Defended | Applications register exact redirect addresses (https, or http on localhost; no wildcards, no fragments). Nothing else is accepted. |
| **Stolen authorization codes** | Defended | PKCE with S256 is required for every public client and by default for confidential ones. |
| **Stolen refresh tokens** | Partly | Refresh tokens rotate on every use and a reused one revokes the whole grant, so a stolen one is found when the owner uses theirs. Until then it works. Signing out revokes them. |
| **Host header or link poisoning** | Defended | Links in e-mails (activation, reset) are built from the configured `ISSUER`, never from the request. |
| **Requests to internal addresses** (SSRF) | Defended | The back-channel logout call refuses loopback and private addresses unless you allow them (`OUTBOUND_ALLOW_PRIVATE_ADDRESSES`). The SMS address is set by you and must be https. |
| **SQL injection** | Defended | All queries are parameterized. |
| **A stolen administrator client secret** | Partly | Secrets are stored hashed and can be rotated; failed authentications are limited and every change is in the audit log. But a client with the `admin` scope can do everything. Give import jobs only the `directory` scope, keep secrets in a secret store, rotate them. |
| **Reading the database or a backup** | Partly | Passwords, client secrets, codes, activation tokens and device tokens are stored hashed. **Not protected:** the sessions and tokens that pforte has issued are stored as the provider library keeps them, so someone who can read the table can use unexpired tokens. Also keep `COOKIE_KEYS` and `JWKS` out of backups of the database. Protect the database as you protect the keys. |
| **Stolen signing or cookie keys** | Not defended | With the signing key tokens can be forged, with the cookie keys cookies. Keys can be rotated (the first signs, all verify); do so if one leaks. |
| **Secrets in logs** | Defended | The request log hides tokens, e-mail addresses and hints in addresses. Passwords, codes and tokens are never logged. The development notifier writes codes to the log, but pforte refuses to start in production without real mail. Sign-in events keep an unknown address only as a hash. |
| **Flooding the service** (denial of service) | Not defended | Limits protect the sign-in, but cannot stop a flood of plain requests. Put a CDN or a rate-limiting proxy in front. Every password check costs hashing time, which the limits bound per IP, not in total. |
| **A malicious update of a dependency** | Partly | Versions are pinned, the lock file is installed as is, new releases wait 14 days before an update is proposed, and CI fails on known vulnerabilities in what ships. A new malicious release that is not yet known is not caught. |
| **A malicious or careless administrator** | Not defended | Every change and sign-in is in the audit log, which cannot be changed through the API. Nothing prevents an administrator from acting. |
| **Weak default settings left in production** | Defended | pforte refuses to start in production with an http issuer, default database passwords, guessable keys, weak signing keys, no mail, or the development clients and users. |

## What you have to do

- Serve pforte over **https** and set **`TRUST_PROXY`** to the number of proxies in front of it. Without it every limit counts
  your proxy as one client.
- Keep **`COOKIE_KEYS`, `JWKS`, `DATABASE_URL`, the SMTP and SMS credentials** in a secret store (`NAME_FILE`), out of the image
  and out of version control.
- **Delete the development seed** (clients `demo-*`, users at `example.com`) or change their secrets. pforte will not start
  in production while they exist.
- Give each administrator client **the smallest scope** that does the job, and **rotate** the secrets from time to time.
- Make the database reachable **only** from pforte, back it up encrypted, and treat a backup like the keys.
- Put a **CDN or rate-limiting proxy** in front if you expect to be attacked.
- **Read the audit log**: many `login.password_failed` from one address, or `login.blocked`, is the sign of an attack.
- Decide on **SMS** knowingly (see above) and keep your mail provider's account protected: it carries the codes.
- Keep pforte **up to date**. Subscribe to its releases; security fixes are announced there.

## Known gaps

Not in pforte today, and worth knowing about: passkeys or other phishing-resistant sign-in, encryption of issued tokens in
the database, a notice by e-mail when someone signs in on a new device, limits that adapt to risk, and per-client rate limits.
If one of these matters for you, open an issue.
