import type { Catalog } from './en.js'

export const de: Catalog = {
  'common.cancel': 'Abbrechen',
  'common.code': 'Code',
  'common.email': 'E-Mail',
  'common.sendNewCode': 'Neuen Code senden',

  'login.title': 'Anmelden',
  'login.titleTo': 'Anmelden bei {client}',
  'login.password': 'Passwort',
  'login.submit': 'Anmelden',
  'login.forgot': 'Passwort vergessen?',
  'login.wrong': 'Die E-Mail-Adresse oder das Passwort ist nicht richtig.',

  'code.title': 'Code eingeben',
  'code.sentEmail': 'Wir haben einen 6-stelligen Code per E-Mail an {to} gesendet. Er ist 10 Minuten gültig.',
  'code.sentSms': 'Wir haben einen 6-stelligen Code per SMS an {to} gesendet. Er ist 10 Minuten gültig.',
  'code.remember': 'Dieses Gerät 90 Tage merken, damit hier kein Code mehr abgefragt wird',
  'code.submit': 'Weiter',
  'code.useEmail': 'Code stattdessen per E-Mail senden',
  'code.phoneHint':
    'Sie erhalten die Codes per E-Mail, weil keine Mobilnummer hinterlegt ist. Bitten Sie Ihre Administration, Ihre Nummer einzutragen, wenn Sie die Codes lieber per SMS erhalten möchten.',
  'code.wrong': 'Der Code ist nicht richtig.',
  'code.exhausted': 'Zu viele falsche Versuche. Bitte fordern Sie einen neuen Code an.',
  'code.expired': 'Der Code ist abgelaufen. Bitte fordern Sie einen neuen an.',
  'code.none': 'Es gibt keinen gültigen Code. Bitte fordern Sie einen neuen an.',
  'code.newOnItsWay': 'Ein neuer Code ist unterwegs.',
  'code.badOrExpired': 'Der Code ist nicht richtig oder abgelaufen. Unten können Sie einen neuen anfordern.',
  'code.cooldown': 'Vor einem Moment wurde ein Code gesendet. Einen neuen können Sie in {seconds} Sekunden anfordern.',
  'code.tooMany': 'Es wurden zu viele Codes angefordert. Bitte versuchen Sie es in {minutes} Minuten erneut.',
  'code.tooManyTitle': 'Zu viele Codes',

  'limit.title': 'Zu viele Versuche',
  'limit.text': 'Von Ihrem Netzwerk oder für diese Adresse gab es zu viele Versuche. Bitte versuchen Sie es in {minutes} Minuten erneut.',

  'error.title': 'Etwas ist schiefgelaufen',
  'error.generic': 'Die Anfrage konnte nicht abgeschlossen werden.',
  'error.signInExpiredTitle': 'Anmeldung abgelaufen',
  'error.signInExpired': 'Diese Anmeldeanfrage ist abgelaufen. Bitte gehen Sie zurück zur Anwendung und beginnen Sie von vorn.',
  'error.notSupportedTitle': 'Nicht unterstützt',
  'error.notSupported': 'Diese Anfrage kann nicht abgeschlossen werden.',
  'error.cannotSendTitle': 'Code kann nicht gesendet werden',
  'error.cannotSend': 'Der Code konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.',

  'password.new': 'Neues Passwort',
  'password.confirm': 'Neues Passwort wiederholen',
  'password.hint': 'Mindestens 10 Zeichen. Ein paar zufällige Wörter ergeben ein gutes Passwort.',
  'password.mismatch': 'Die beiden Passwörter stimmen nicht überein.',
  'password.tooShort': 'Das Passwort muss mindestens {min} Zeichen lang sein.',
  'password.tooLong': 'Das Passwort darf höchstens {max} Zeichen lang sein.',
  'password.isEmail': 'Das Passwort darf nicht Ihre E-Mail-Adresse sein.',

  'activate.title': 'Passwort wählen',
  'activate.submit': 'Konto aktivieren',
  'activate.invalidTitle': 'Link ungültig',
  'activate.invalid':
    'Dieser Link ist nicht mehr gültig. Er wurde vielleicht schon verwendet oder ist abgelaufen. Bitten Sie Ihre Administration um einen neuen.',
  'activate.doneTitle': 'Ihr Konto ist aktiv',
  'activate.done': 'Ihr Passwort ist gesetzt. Sie können sich jetzt in der Anwendung anmelden, von der Sie gekommen sind.',

  'reset.title': 'Passwort vergessen?',
  'reset.intro': 'Geben Sie Ihre E-Mail-Adresse ein. Wir senden Ihnen einen Code, mit dem Sie ein neues Passwort wählen.',
  'reset.send': 'Code senden',
  'reset.noEmail': 'Bitte geben Sie Ihre E-Mail-Adresse ein.',
  'reset.sent':
    'Falls es zu dieser Adresse ein Konto gibt, haben wir einen Code dorthin gesendet. Er ist 10 Minuten gültig.',
  'reset.codeTitle': 'Neues Passwort wählen',
  'reset.codeSubmit': 'Passwort ändern',
  'reset.doneTitle': 'Passwort geändert',
  'reset.done': 'Ihr neues Passwort ist gesetzt und Sie wurden überall abgemeldet. Melden Sie sich in Ihrer Anwendung neu an.',

  'phone.title': 'Telefonnummer bestätigen',
  'phone.intro':
    'Ihr Konto ist aktiv. Wir haben einen 6-stelligen Code per SMS an {to} gesendet. Geben Sie ihn ein, um Ihre Anmeldecodes künftig per SMS zu erhalten.',
  'phone.confirm': 'Bestätigen',
  'phone.skip': 'Vorerst überspringen (Codes kommen per E-Mail)',
  'phone.wait': 'Bitte warten Sie {seconds} Sekunden, bevor Sie einen weiteren Code anfordern.',
  'phone.cannotSend': 'Der Code konnte nicht gesendet werden. Sie können diesen Schritt überspringen und später bestätigen.',
  'phone.doneTitle': 'Telefonnummer bestätigt',
  'phone.done':
    'Ihr Konto ist aktiv und Ihre Anmeldecodes kommen per SMS. Sie können sich jetzt in der Anwendung anmelden, von der Sie gekommen sind.',

  'mail.loginCode.subject': 'Ihr Anmeldecode für {organisation}',
  'mail.loginCode.text':
    'Guten Tag {firstName},\n\nIhr Anmeldecode lautet {code}. Er ist {minutes} Minuten gültig.\n\nWenn Sie sich nicht anmelden wollten, geben Sie den Code an niemanden weiter und informieren Sie Ihre Administration.\n',
  'mail.activation.subject': 'Aktivieren Sie Ihr Konto bei {organisation}',
  'mail.activation.text':
    'Guten Tag {firstName},\n\nfür Sie wurde ein Konto bei {organisation} angelegt. Über diesen Link wählen Sie Ihr Passwort:\n\n{url}\n\nDer Link ist {hours} Stunden gültig. Wenn Sie diese Nachricht nicht erwartet haben, können Sie sie ignorieren.\n',
  'mail.resetCode.subject': 'Neues Passwort für {organisation}',
  'mail.resetCode.text':
    'Guten Tag {firstName},\n\nIhr Code für ein neues Passwort lautet {code}. Er ist {minutes} Minuten gültig. Geben Sie ihn hier ein:\n\n{url}\n\nWenn Sie kein neues Passwort angefordert haben, ignorieren Sie diese Nachricht; Ihr Passwort bleibt unverändert.\n',

  'sms.login': '{code} ist Ihr Anmeldecode für {organisation}. Gültig {minutes} Minuten. Nicht weitergeben.',
  'sms.reset': '{code} ist Ihr Code für ein neues Passwort bei {organisation}. Gültig {minutes} Minuten. Nicht weitergeben.',
  'sms.phone': '{code} ist Ihr Code, um diese Telefonnummer bei {organisation} zu bestätigen. Gültig {minutes} Minuten.',
}
