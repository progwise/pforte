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
| `BRANDING_DIR` | Folder with `locales/<language>.json`. |
| `REMEMBER_DEVICE_DEFAULT` | `true` ticks "Remember this device" when the code page opens. Default `false`: on a shared computer nobody is remembered by accident. |
| `ORGANISATION_NAME` | Named in e-mails and SMS. |
