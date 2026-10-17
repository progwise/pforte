# Branding and languages

A pforte installation can carry its organisation's name, logo, colours, fonts and footer links, and
speaks four languages out of the box. Both are set with one folder, `BRANDING_DIR`:

```
branding/
  brand.json        name, logo, colours, corner radius, fonts, footer links
  logo.svg          the logo
  fonts/            font files, if you use your own fonts
  locales/          texts: replace some, or add a language (see "Languages and texts" below)
```

In a container the folder is a mounted volume. Without it pforte looks neutral and is in English and German.
This is deliberately small: the pages keep their layout, one card per step. Branding changes how they look,
not what they do.

## Branding: `brand.json`

Every entry is optional. This one shows them all:

```json
{
  "name": "Example Inc.",
  "logo": "logo.svg",
  "radius": "16px",
  "colors": {
    "background": "#f6f3ec",
    "surface": "#ffffff",
    "text": "#1d2b4a",
    "muted": "#4d5870",
    "border": "#e0dacb",
    "primary": "#f2c94c",
    "primaryText": "#1d2b4a",
    "link": "#2a4a8b",
    "danger": "#82071e",
    "dangerBackground": "#ffebe9"
  },
  "fonts": {
    "body": {
      "family": "Example Sans",
      "files": [
        { "file": "fonts/ExampleSans-Regular.woff2", "weight": 400 },
        { "file": "fonts/ExampleSans-Bold.woff2", "weight": 700 }
      ]
    },
    "heading": {
      "family": "Example Display",
      "files": [{ "file": "fonts/ExampleDisplay-SemiBold.woff2", "weight": 600 }]
    }
  },
  "links": [
    { "label": { "en": "Imprint", "de": "Impressum" }, "url": "https://example.com/imprint" },
    { "label": "Privacy", "url": "https://example.com/privacy" }
  ]
}
```

| Entry | Meaning |
| --- | --- |
| `name` | Shown above the pages as text, or as the description of the logo. Also named in e-mails and SMS (instead of `ORGANISATION_NAME`). |
| `logo` | `.svg`, `.png`, `.jpg` or `.webp`, up to 512 KB. Shown at most 12 rem wide and 4 rem high. |
| `radius` | Corner radius of the card, like `16px` or `1rem`, up to 32px. Fields and buttons are two thirds of it. |
| `colors` | Hex colours. `primary` and `primaryText` are the main button, `link` the links and secondary buttons, `muted` hints and footer links. What you leave out stays neutral. |
| `fonts.body` | Text, fields and hints. |
| `fonts.heading` | Headings, labels and buttons. Without it they use the body font. |
| `fonts.*.files` | One to six `.woff2` or `.woff` files, up to 600 KB each, with `weight` (100 to 900, default 400) and `style` (`normal` or `italic`). |
| `links` | Up to six links under the card, e.g. imprint and privacy policy. `label` is one text, or a text per language with `en` as the fallback. `url` must be `https://` or `mailto:`. |

Paths are relative to the branding folder and must stay inside it.

### Fonts and the logo are served by pforte itself

pforte does not load anything from other sites: fonts and logo come from the same address as the login page. That
keeps visitors' data with you (a font loaded from a font service sends their address to that service) and lets
pforte forbid everything else with its Content-Security-Policy. So **put the font files in the folder** instead of
linking to a font service. Most families can be downloaded as `.woff2` from their source; check their licence
allows self-hosting, as the common open ones (SIL Open Font License) do.

The files get a path with a hash of their content (`/brand/ab12cd34ef/logo.svg`), so a changed file has a new
address and browsers keep the old one for a year.

### Mistakes stop the start

pforte reads the folder when it starts and refuses to start, naming what to change, if for example:

- an entry is misspelled or unknown (`"colour"`), a colour is not a hex colour, or a file is missing or too big,
- a file is outside the folder, or does not look like its extension (a text file called `logo.png`),
- a link is not `https://` or `mailto:`.

It also **warns** at startup when colours are hard to read: text, the main button, links, hints or error messages
with less than the 4.5:1 contrast WCAG asks for. Fix those; people with weaker eyesight or a phone in sunlight
cannot use the page otherwise.

### What the code field looks like

The code is entered in one large field with wide letter spacing, not in six separate boxes. That keeps the pages free of
JavaScript and lets phones fill in the code from an SMS, which separate boxes often prevent.

# Languages and texts

pforte's pages, e-mails and SMS come in **English, German, French and Hungarian**. More languages are added
with a file, and every text can be replaced for one installation.

> The French and Hungarian texts were written without a native speaker. Have someone who speaks the language
> read them before you rely on them, and replace what should sound different (see below).

## Which language is used

For the pages a person sees, in this order:

1. **`ui_locales`** of the authorization request, if the application sends it. This is the standard OpenID
   Connect parameter: a space-separated list, most preferred first, e.g. `ui_locales=fr hu`. An application
   that has its own language setting should pass it, so the sign-in pages match the app.
2. **The user's own language** (`language` of the user: `de`, `fr`, …), once pforte knows who is signing in,
   that is from the code page on.
3. **The browser's language** (`Accept-Language`).
4. **The default language** (`DEFAULT_LANGUAGE`, `en` if not set).

A region does not matter: `fr-CH` is French. A language pforte has no texts for is skipped.

Two things work differently on purpose:

- **E-mails and SMS** always use the user's own language, because the application is not involved.
- The **"forgot password" pages** never use the user's language, only the one in the link or the browser.
  Otherwise the language of the answer would tell a stranger that an address has an account. The link in the
  reset e-mail carries the user's language (`&lang=de`), so the person finds the page in their language anyway.

The user's language is set through the admin API (`language` of a user) or the CSV import (column `language`).

## Changing texts and adding languages

Set `BRANDING_DIR` to a folder (in a container: a mounted volume) with a `locales` folder inside:

```
branding/
  locales/
    de.json      replaces some German texts
    nl.json      adds Dutch
```

A file is named after the language, `de.json` or `pt-BR.json`, and holds the texts to replace, by key:

```json
{
  "login.submit": "Los geht's",
  "code.sentSms": "Wir haben Ihnen einen Code per SMS an {to} geschickt."
}
```

- The **keys** and the English wording are in [`apps/server/src/i18n/en.ts`](../apps/server/src/i18n/en.ts).
- `{name}` marks a value that pforte fills in. A text must keep exactly the values the English one has: losing
  `{code}` from a message would send people an empty message, so pforte refuses to start. The same happens
  for an unknown key or a text that is not a string. The message names the file and the key.
- Texts are escaped when they are shown, so they cannot contain HTML. A line break in an e-mail is `\n`.
- A text you leave out stays as built in. For a **new language** every text you leave out appears in English,
  and pforte writes a warning at startup saying how many are missing.
- A new language works for the pages, e-mails and SMS at once, and for every user whose `language` is that code.

Keep SMS texts short. Texts with letters outside the basic GSM alphabet (Hungarian á, í, ó, ú, ő, ű, for
example) are sent as Unicode, where one message holds 70 characters instead of 160, so such an SMS is billed
as several.

## Settings

| Variable | Meaning |
| --- | --- |
| `DEFAULT_LANGUAGE` | Language when nothing else decides. Default `en`. |
| `BRANDING_DIR` | Folder with `brand.json`, its files and `locales/<language>.json`. |
| `REMEMBER_DEVICE_DEFAULT` | `true` ticks "Remember this device" when the code page opens. Default `false`: on a shared computer nobody is remembered by accident. |
| `ORGANISATION_NAME` | Named in e-mails and SMS, if `brand.json` has no `name`. |
