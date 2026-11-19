# Branding and languages

A pforte installation can carry its organisation's name, logo, colours, fonts and footer links, and
speaks four languages out of the box. Both are set with one folder, `BRANDING_DIR`:

```
branding/
  brand.json        name, logos, colours, corner radius, fonts, footer links
  logo.svg          the logo
  logo-small.svg    a second, small logo, if the logo is a wide wordmark
  fonts/            font files, if you use your own fonts
  locales/          texts: replace some, or add a language (see "Languages and texts" below)
```

In a container the folder is a mounted volume. Without it pforte looks neutral, with its own signet as
the logo, and is in English and German.
This is deliberately small: the pages keep their layout, one card per step. Branding changes how they look,
not what they do.

## Branding: `brand.json`

Every entry is optional. This one shows them all:

```json
{
  "name": "Example Inc.",
  "logo": "logo.svg",
  "logoSmall": "logo-small.svg",
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
  "dark": {
    "colors": { "link": "#9db8ff" },
    "logoTile": false
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
| `logo` | `.svg`, `.png`, `.jpg` or `.webp`, up to 512 KB. Shown on the card of the sign-in, code, activation and password pages, at most 12 rem wide and 4 rem high: a wordmark is right there. It is also the logo of the bar of the administration and of the [account pages](account.md), at most 2.5 rem high, and the icon of the browser tab, unless there is a `logoSmall`. Without a logo that icon is pforte's signet, in the colours of your main button; with neither a logo nor a `name`, the signet is shown above the pages as well. |
| `logoSmall` | A second logo for the narrow places, with the rules of `logo`; it needs a `logo`. It is for a mark that works small: a signet, or a signet with a short label beside it. It does not have to be square. It is shown where the bar is one line (on a screen up to 1,200 pixels wide), at most 2.5 rem high and a third of the bar wide, and as the icon of the browser tab. The wide bar and the cards keep the `logo`. Without it the `logo` is used everywhere: a wide wordmark is then a thin strip in the one-line bar and in the tab, a square mark is not. |
| `radius` | Corner radius of the card, like `16px` or `1rem`, up to 32px. Fields and buttons are two thirds of it. |
| `colors` | Hex colours. `primary` and `primaryText` are the main button, `link` the links and secondary buttons, `muted` hints and footer links. What you leave out stays neutral. |
| `dark` | The dark pages ([light and dark](#light-and-dark)). Without it they are calculated from `colors`. `dark.colors` replaces single colours of them, with the names and rules of `colors`. `dark.logoTile: false` shows the logo on a dark page as it is, without the light tile. `"dark": false` keeps the installation light for everybody. |
| `fonts.body` | Text, fields and hints. |
| `fonts.heading` | Headings, labels and buttons. Without it they use the body font. |
| `fonts.*.files` | One to six `.woff2` or `.woff` files, up to 600 KB each, with `weight` (100 to 900, default 400) and `style` (`normal` or `italic`). |
| `links` | Up to six links under the card, e.g. imprint and privacy policy. `label` is one text, or a text per language with `en` as the fallback. `url` must be `https://` or `mailto:`. |

Paths are relative to the branding folder and must stay inside it.

### Light and dark

Every page comes light and dark, in one stylesheet. Which of the two a person sees is decided in this order:

1. **The application they come from**, if it says so with `color_scheme=dark` or `color_scheme=light`
   ([integrating a client](integrating-a-client.md#light-or-dark)). pforte remembers it in that browser until an
   application says something else.
2. **The device**, where no application ever said anything: dark where it is set to dark.

There is no switch on the pages, and no script.

**You do not have to choose dark colours.** They are calculated from your `colors` when pforte starts:

- The page, the card, text, hints, lines and error messages are pforte's own dark ones. They carry no colour of a brand.
- `link` is kept if it reads on the dark card, else lightened in its own hue until it does (4.5:1).
- `primary` is kept if the button stands out from the dark card, else lightened in its own hue until it does (3:1).
  `primaryText` stays if it reads on that button, else it becomes black or white.

To choose a colour yourself, name it in `dark.colors`; what you leave out stays calculated, for the colours you chose: a link is made to read on your own dark `surface` and `background`, and the button to stand out from your `surface`. Should the surface you chose be so light that no lighter colour reads on it, they are darkened in their own hue instead. A colour you name is taken as it is. pforte warns at startup
about dark colours that are hard to read, as it does for the light ones, and says that it means the dark page.

**The logo on a dark page.** A logo is usually drawn for a light page, and pforte cannot tell from a file whether it
reads on a dark one. So on a dark page your logo sits on a small tile in your light `surface` colour, where it reads
as it always did. If your logo reads on both, a mark on its own ground for example, say `"logoTile": false` and it is
shown as it is. There is one logo file for light and dark. An SVG may carry its own `prefers-color-scheme` rule;
browsers differ in whether that follows the page or the device inside an image, so check it where an application says
dark on a device that is light. pforte's own signet needs nothing: it is drawn on a tile in the colours of your main
button.

**To stay light for everybody**, as before 0.3.2, say `"dark": false`. The pages then ignore the device and what an
application says.

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

- an entry is misspelled or unknown (`"colour"`), a colour is not a hex colour (in `colors` or in `dark.colors`), or a file is missing or too big,
- a file is outside the folder, or does not look like its extension (a text file called `logo.png`),
- a link is not `https://` or `mailto:`.

It also **warns** at startup when colours are hard to read: text, the main button, links, hints or error messages
with less than the 4.5:1 contrast WCAG asks for. Fix those; people with weaker eyesight or a phone in sunlight
cannot use the page otherwise.

### What the code field looks like

The code is entered in one large field with wide letter spacing, not in six separate boxes. That keeps the pages free of
JavaScript and lets phones fill in the code from an SMS, which separate boxes often prevent.

## Languages and texts

pforte's pages, e-mails and SMS come in **English, German, French and Hungarian**. More languages are added
with a file, and every text can be replaced for one installation.

> The French and Hungarian texts were written without a native speaker. Have someone who speaks the language
> read them before you rely on them, and replace what should sound different (see below).

## Which language is used

For the pages a person sees, in this order:

1. **`ui_locales`** of the authorization request, if the application sends it. This is the standard OpenID
   Connect parameter: a space-separated list, most preferred first, e.g. `ui_locales=fr hu`. An application
   that has its own language setting should pass it, so the sign-in pages match the app. The end-session
   request takes it too, for the pages of a sign-out.
2. **The user's own language** (`language` of the user: `de`, `fr`, …), once pforte knows who is signing in,
   that is from the code page on. At a sign-out it is the person who is signed in, or the one the
   `id_token_hint` names.
3. **The browser's language** (`Accept-Language`).
4. **The default language** (`DEFAULT_LANGUAGE`, `en` if not set).

A region does not matter: `fr-CH` is French. A language pforte has no texts for is skipped.

The pages of a sign-out are one language from the question ("Sign out completely?") to the page that says how it
ended, also where that page is the "signed out" page of the [account pages](account.md) or of the
[administration](administration.md). The request that reaches that last page says nothing about the sign-out, and the
person may be signed out by then, so the language of the question travels in a cookie
([`pforte_logout_language`](security.md#cookies)).

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
  for an unknown key or a text that is not a string. The message names the file and the key. The one exception
  is a time, see [Texts that state a time](#texts-that-state-a-time).
- Texts are escaped when they are shown, so they cannot contain HTML. A line break in an e-mail is `\n`.
- A text you leave out stays as built in. For a **new language** every text you leave out appears in English,
  and pforte writes a warning at startup saying how many are missing.
- A new language works for the pages, e-mails and SMS at once, and for every user whose `language` is that code.

### Texts that state a time

Some texts say how long something is valid or how long to wait. pforte hands them that time in words, with the
singular and the plural: "1 minute", "10 minutes", "7 days".

| Value | Says | In these texts |
| --- | --- | --- |
| `{validity}` | How long a link or a code is valid: minutes below an hour, hours below two days, whole days from there on. Hours and days are rounded down, so the text never promises more than there is. | `mail.activation.text`, `mail.activationFor.text`, `code.sentEmail`, `code.sentSms`, `reset.sent` |
| `{wait}` | How long to wait before trying again, in minutes, rounded up. | `limit.text`, `code.tooMany`, `account.password.wait` |

The words come from texts of their own, which you can replace like any other and which a new language should have:
`duration.for.minute.one` ("{count} minute"), `duration.for.minute.other` ("{count} minutes") and the same for `hour`
and `day`, for the sentence "valid for …"; `duration.in.minute.one` and `duration.in.minute.other` for the sentence
"again in …". The two sentences have their own texts because some languages use another form in each: Hungarian
says "7 napig" in the first and "5 perc" in the second. `.one` is used for exactly one, `.other` for every other number.

The words are taken from the language the sentence around them comes from. A new language that has the words but
not yet the sentence shows that sentence in English, with the English words; one that has the sentence but not the
words shows its own sentence with the time in English.

A text of yours that states a time is free in two ways:

- It **may leave the value out** and write the time itself ("valid for a week").
- It **may use the number** these texts had up to 0.3.1: `{hours}` in the two activation mails, `{minutes}` in the
  three texts with `{wait}`. A text written for an earlier version therefore reads as it did.

Keep SMS texts short. Texts with letters outside the basic GSM alphabet (Hungarian á, í, ó, ú, ő, ű, for
example) are sent as Unicode, where one message holds 70 characters instead of 160, so such an SMS is billed
as several.

## Settings

| Variable | Meaning |
| --- | --- |
| `DEFAULT_LANGUAGE` | Language when nothing else decides. Default `en`. |
| `BRANDING_DIR` | Folder with `brand.json`, its files and `locales/<language>.json`. |
| `REMEMBER_DEVICE_DEFAULT` | `true` ticks "Remember this device" when the code page or the activation page opens. Default `false`: on a shared computer nobody is remembered by accident. |
| `ORGANISATION_NAME` | Named in e-mails and SMS, if `brand.json` has no `name`. |
