# Configuration

pforte is configured with environment variables, nothing else. It reads them once at start and, if something is wrong, stops
and says what (a production start lists every problem at once, see [security](security.md#weak-secrets-stop-a-production-start)).

**Secrets from files.** Where a variable is marked with a file form, `NAME_FILE` may name a file holding the value instead
(for Docker and Kubernetes secrets). The file's content is used without surrounding white space. Setting both `NAME` and
`NAME_FILE` is an error, so it is never unclear which one counts.

## What a production start needs

Six settings, of which the first four are always required:

| Variable | Needed | What it is |
| --- | --- | --- |
| `DATABASE_URL` (or `DATABASE_URL_FILE`) | always | The Postgres database: `postgres://user:password@host:5432/pforte`. In production the password must not be empty or a well-known default. |
| `ISSUER` (or `ISSUER_FILE`) | always | The public address of pforte: `https://id.example.com`. It is the `iss` of every token and the base of every link pforte sends. https is required (http only for `localhost`), without query or fragment. |
| `COOKIE_KEYS` (or `COOKIE_KEYS_FILE`) | always | Keys that sign cookies, separated by commas, each at least 32 characters. The first signs, all verify, so a new key can be added in front of the old one. |
| `JWKS` (or `JWKS_FILE`) | always | A JSON Web Key Set with private signing keys: `{"keys":[…]}`. The first key signs tokens, all are published and verify. RSA from 2048 bits, or EC on P-256, P-384 or P-521. |
| `SMTP_URL` (or `SMTP_URL_FILE`) | production | The mail server: `smtps://user:password@mail.example.com:465` or `smtp://…`. |
| `MAIL_FROM` | with `SMTP_URL` | The sender of codes and links: `Example Inc. <no-reply@example.com>`. |

Generate `COOKIE_KEYS` and `JWKS` for a new installation with the image (or `pnpm dev:keys` in a checkout):

```bash
docker run --rm ghcr.io/progwise/pforte keys > pforte.env            # COOKIE_KEYS=… and JWKS=… as lines for --env-file
docker run --rm -v "$PWD/secrets:/secrets" --user "$(id -u)" ghcr.io/progwise/pforte keys --dir /secrets   # as files
```

Keep them: new keys sign everybody out and make every issued token unverifiable. To rotate, put the new key first and keep
the old one until its tokens and cookies have expired.

## All variables

### Database and address

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none, required | See above. |
| `ISSUER` | none, required | See above. |
| `PORT` | `3300` | The port pforte listens on, on all interfaces. In the image, publish it with `-p`. |
| `MIGRATE_ON_START` | `true` | `true`: pending database migrations are applied before the service starts (instances that start together take turns). `false`: start only, and run `pforte migrate` yourself, for example as a step of your deployment. Anything else is an error. |

### Secrets

| Variable | Default | What it does |
| --- | --- | --- |
| `COOKIE_KEYS` | none, required | See above. Also used to derive the keys that protect one-time codes and the rate-limit counters. |
| `JWKS` | none, required | See above. |

### Mail and SMS

| Variable | Default | What it does |
| --- | --- | --- |
| `SMTP_URL` | none | See above. Without it, development writes codes and links to the log; production refuses to start. |
| `MAIL_FROM` | none | See above. Required when `SMTP_URL` is set, and an error without it. |
| `ORGANISATION_NAME` | `pforte` | Named in e-mails and SMS, and on the start page of the administration. A `name` in the branding folder replaces it. |
| `SMS_PROVIDER` | none | `http` switches the second factor and password reset by SMS on. Without it all codes go by e-mail. See [sending codes by SMS](sms.md). |
| `SMS_URL` | none | Required with `SMS_PROVIDER`: the address of your SMS provider's API. https, as it carries your credentials. |
| `SMS_METHOD` | `POST` | `POST` or `PUT`. |
| `SMS_CONTENT_TYPE` | `json` | `json` or `form`: how `SMS_BODY` is sent. |
| `SMS_BODY` | none | Required with `SMS_PROVIDER`: the request body with the placeholders `{{to}}` and `{{text}}`, and optionally `{{from}}`. |
| `SMS_FROM` | none | The sender, for `{{from}}`. Required when `SMS_BODY` uses it. |
| `SMS_HEADERS` (or `SMS_HEADERS_FILE`) | none | A JSON object of headers, for example the authorization of your provider: `{"Authorization":"Basic …"}`. |
| `SMS_SUCCESS_PATTERN` | none | A regular expression the provider's answer must match for the message to count as sent. |

### Pages and languages

| Variable | Default | What it does |
| --- | --- | --- |
| `DEFAULT_LANGUAGE` | `en` | The language of pages and messages when nothing else decides (`de`, `en`, `fr`, `hu`, or a language you add). |
| `BRANDING_DIR` | none | A folder with your name, logo, colours, fonts and texts. Mount it into the container and point this at it. See [branding and languages](branding-and-languages.md). |
| `REMEMBER_DEVICE_DEFAULT` | `false` | `true` ticks "Remember this device" when the code page opens. |
| `TIME_ZONE` | `UTC` | The time zone in which the administration shows times, an IANA name such as `Europe/Berlin`. |

### Safety and data

| Variable | Default | What it does |
| --- | --- | --- |
| `TRUST_PROXY` | `0` | How many proxies stand between the internet and pforte (a reverse proxy, a load balancer, a tunnel). Rate limits count by client address, which behind a proxy is only known from `X-Forwarded-For`. `0`: pforte is reached directly and the header is ignored. Too low, and everybody counts as one address; too high, and an attacker can choose the address that counts. See [rate limits](rate-limiting.md). |
| `SELF_SERVICE_ACTIVATION` | `true` | Whether a person who has no password yet (created by an import or the API) can ask for their activation link on the page *Set or reset your password*. Set `false` if people should get a link only when you invite them. See [syncing users](syncing-users.md). |
| `OUTBOUND_ALLOW_PRIVATE_ADDRESSES` | `false` | pforte calls applications for back-channel logout. By default it refuses loopback and private network addresses, as protection against server-side request forgery. Set `true` when your applications run on your own network, for example `http://erp.internal:8080/logout`. |
| `AUDIT_LOGIN_RETENTION_DAYS` | `180` | Sign-in events in the audit log are deleted after this many days; `0` keeps them for ever. Events about changes made by administrators are always kept. See [the audit log](audit-log.md). |
| `BOOTSTRAP_ADMIN_EMAIL` | none | If pforte has no administrator, this address becomes one and is mailed a link to choose a password. Nothing happens once an administrator exists, so it can stay set. See [the administration](administration.md). |

### The runtime

| Variable | Default | What it does |
| --- | --- | --- |
| `NODE_ENV` | `production` in the image | `production` makes a weak configuration stop the start (see [security](security.md#weak-secrets-stop-a-production-start)) and refuses to run without a way to send mail. Anything else only warns, which is for development. |
| `PFORTE_VERSION` | set by the image | The version shown by `pforte --version`. Not for you to set. |

## An example

An environment file for `docker run --env-file` (no quotes, as Docker keeps them in the value) or for Docker Compose:

```bash
DATABASE_URL=postgres://pforte:Qm7v3-long-random-password@db:5432/pforte
ISSUER=https://id.example.com
COOKIE_KEYS=…        # from: pforte keys
JWKS=…               # from: pforte keys
SMTP_URL=smtps://no-reply%40example.com:smtp-password@mail.example.com:465
MAIL_FROM="Example Inc. <no-reply@example.com>"   # Compose strips the quotes; with --env-file write it without
ORGANISATION_NAME=Example Inc.
DEFAULT_LANGUAGE=de
TIME_ZONE=Europe/Berlin
TRUST_PROXY=1
BOOTSTRAP_ADMIN_EMAIL=you@example.com
```

## Not settings of pforte

`PFORTE_DB_PORT`, `PFORTE_SMTP_PORT` and `PFORTE_MAIL_UI_PORT` belong to `compose.dev.yaml` of the development setup, and `ENV_FILE` to
the database tooling of a checkout. A running pforte reads none of them.
