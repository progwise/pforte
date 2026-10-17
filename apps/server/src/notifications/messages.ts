/** The texts of the messages. German and English; a user's language decides, English is the fallback. */
type Language = 'en' | 'de'

interface MessageValues {
  organisation: string
  firstName: string
  minutes?: number
  code?: string
  url?: string
}

const texts: Record<Language, { loginCode: (v: MessageValues) => { subject: string; text: string }; activation: (v: MessageValues) => { subject: string; text: string } }> = {
  en: {
    loginCode: ({ organisation, firstName, code, minutes }) => ({
      subject: `Your sign-in code for ${organisation}`,
      text: `Hello ${firstName},\n\nyour sign-in code is ${code}. It is valid for ${minutes} minutes.\n\nIf you did not try to sign in, do not share this code with anyone and tell your administration.\n`,
    }),
    activation: ({ organisation, firstName, url, minutes }) => ({
      subject: `Activate your account at ${organisation}`,
      text: `Hello ${firstName},\n\nan account was created for you at ${organisation}. Open this link to choose your password:\n\n${url}\n\nThe link is valid for ${minutes} hours. If you did not expect this message, you can ignore it.\n`,
    }),
  },
  de: {
    loginCode: ({ organisation, firstName, code, minutes }) => ({
      subject: `Ihr Anmeldecode für ${organisation}`,
      text: `Guten Tag ${firstName},\n\nIhr Anmeldecode lautet ${code}. Er ist ${minutes} Minuten gültig.\n\nWenn Sie sich nicht anmelden wollten, geben Sie den Code an niemanden weiter und informieren Sie Ihre Administration.\n`,
    }),
    activation: ({ organisation, firstName, url, minutes }) => ({
      subject: `Aktivieren Sie Ihr Konto bei ${organisation}`,
      text: `Guten Tag ${firstName},\n\nfür Sie wurde ein Konto bei ${organisation} angelegt. Über diesen Link wählen Sie Ihr Passwort:\n\n${url}\n\nDer Link ist ${minutes} Stunden gültig. Wenn Sie diese Nachricht nicht erwartet haben, können Sie sie ignorieren.\n`,
    }),
  },
}

export const languageFor = (language: string): Language => (language.toLowerCase().startsWith('de') ? 'de' : 'en')

export const loginCodeMessage = (language: string, values: MessageValues) => texts[languageFor(language)].loginCode(values)
export const activationMessage = (language: string, values: MessageValues) => texts[languageFor(language)].activation(values)
