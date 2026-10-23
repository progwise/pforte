/**
 * The English texts, which every other language is checked against: a key missing in `de`, `fr` or `hu`
 * is a compile error. `{name}` marks a value that is filled in. Texts that are shown on pages are
 * escaped when they are inserted, so they must not contain HTML.
 */
export const en = {
  'common.cancel': 'Cancel',
  'common.code': 'Code',
  'common.email': 'E-mail',
  'common.sendNewCode': 'Send a new code',

  'login.title': 'Sign in',
  'login.titleTo': 'Sign in to {client}',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.forgot': 'Forgot your password?',
  'login.wrong': 'The e-mail or password is not correct.',

  'code.title': 'Enter your code',
  'code.sentEmail': 'We sent a 6-digit code by e-mail to {to}. It is valid for 10 minutes.',
  'code.sentSms': 'We sent a 6-digit code by SMS to {to}. It is valid for 10 minutes.',
  'code.remember': 'Remember this device for 90 days, so I am not asked for a code here again',
  'code.submit': 'Continue',
  'code.useEmail': 'Send the code by e-mail instead',
  'code.phoneHint':
    'You get codes by e-mail because no mobile number is on file. Ask your administration to add yours if you would rather receive them by SMS.',
  'code.wrong': 'The code is not correct.',
  'code.exhausted': 'Too many wrong attempts. Please ask for a new code.',
  'code.expired': 'The code has expired. Please ask for a new one.',
  'code.none': 'There is no valid code. Please ask for a new one.',
  'code.newOnItsWay': 'A new code is on its way.',
  'code.badOrExpired': 'The code is not correct or has expired. You can ask for a new one below.',
  'code.cooldown': 'A code was sent a moment ago. You can ask for a new one in {seconds} seconds.',
  'code.tooMany': 'Too many codes were requested. Please try again in {minutes} minutes.',
  'code.tooManyTitle': 'Too many codes',

  'limit.title': 'Too many attempts',
  'limit.text': 'There were too many attempts from your network or for this address. Please try again in {minutes} minutes.',

  'logout.title': 'Sign out?',
  'logout.text': 'Do you want to sign out of {host}?',
  'logout.yes': 'Yes, sign me out',
  'logout.no': 'No, stay signed in',
  'logout.doneTitle': 'You are signed out',
  'logout.done': 'Your sign-out was successful.',

  'error.title': 'Something went wrong',
  'error.generic': 'The request could not be completed.',
  'error.refusedTitle': 'Request refused',
  'error.refused': 'This request did not come from this site. Please go back to the page you were on and try again.',
  'error.signInExpiredTitle': 'Sign-in expired',
  'error.signInExpired': 'This sign-in request has expired. Please go back to the application and start again.',
  'error.notSupportedTitle': 'Not supported',
  'error.notSupported': 'This request cannot be completed.',
  'error.cannotSendTitle': 'Cannot send the code',
  'error.cannotSend': 'The code could not be sent. Please try again later.',

  'password.new': 'New password',
  'password.confirm': 'New password again',
  'password.hint': 'At least 10 characters. A few random words make a good password.',
  'password.mismatch': 'The two passwords are not the same.',
  'password.tooShort': 'The password must have at least {min} characters.',
  'password.tooLong': 'The password must have at most {max} characters.',
  'password.isEmail': 'The password must not be your e-mail address.',

  'activate.title': 'Choose your password',
  'activate.submit': 'Activate my account',
  'activate.invalidTitle': 'Link not valid',
  'activate.invalid':
    'This link is not valid any more. It may have been used already or have expired. Ask your administration for a new one.',
  'activate.doneTitle': 'Your account is active',
  'activate.done': 'Your password is set. You can now sign in from the application you came from.',

  'reset.title': 'Set or reset your password',
  'reset.intro': 'Enter your e-mail address. We send you a code or a link to choose a password.',
  'reset.send': 'Send',
  'reset.noEmail': 'Please enter your e-mail address.',
  'reset.sent': 'If there is an account for this address, we have sent a message to it: a code to enter below, or a link to choose your password. A code is valid for 10 minutes.',
  'reset.codeTitle': 'Choose a new password',
  'reset.codeSubmit': 'Change my password',
  'reset.doneTitle': 'Password changed',
  'reset.done': 'Your new password is set and you were signed out everywhere. Sign in again from your application.',

  'phone.title': 'Confirm your phone number',
  'phone.intro':
    'Your account is active. We sent a 6-digit code by SMS to {to}. Enter it to receive your sign-in codes by SMS from now on.',
  'phone.confirm': 'Confirm',
  'phone.skip': 'Skip for now (codes come by e-mail)',
  'phone.wait': 'Please wait {seconds} seconds before asking for another code.',
  'phone.cannotSend': 'The code could not be sent. You can skip this step and confirm later.',
  'phone.doneTitle': 'Phone number confirmed',
  'phone.done':
    'Your account is active and your sign-in codes will come by SMS. You can now sign in from the application you came from.',

  'mail.loginCode.subject': 'Your sign-in code for {organisation}',
  'mail.loginCode.text':
    'Hello {firstName},\n\nyour sign-in code is {code}. It is valid for {minutes} minutes.\n\nIf you did not try to sign in, do not share this code with anyone and tell your administration.\n',
  'mail.activation.subject': 'Activate your account at {organisation}',
  'mail.activation.text':
    'Hello {firstName},\n\nan account was created for you at {organisation}. Open this link to choose your password:\n\n{url}\n\nThe link is valid for {hours} hours. If you did not expect this message, you can ignore it.\n',
  'mail.activationFor.subject': 'Activate your account for {application}',
  'mail.activationFor.text':
    'Hello {firstName},\n\nan account was created for you at {organisation} to sign in to {application}. Open this link to choose your password:\n\n{url}\n\nThe link is valid for {hours} hours. If you did not expect this message, you can ignore it.\n',
  'continue.button': 'Continue to {name}',
  'mail.resetCode.subject': 'Choose a new password for {organisation}',
  'mail.resetCode.text':
    'Hello {firstName},\n\nyour code to choose a new password is {code}. It is valid for {minutes} minutes. Enter it here:\n\n{url}\n\nIf you did not ask for a new password, ignore this message; your password stays as it is.\n',

  'sms.login': '{code} is your sign-in code for {organisation}. Valid for {minutes} minutes. Do not share it.',
  'sms.reset':
    '{code} is your code to choose a new password for {organisation}. Valid for {minutes} minutes. Do not share it.',
  'sms.phone': '{code} is your code to confirm this phone number for {organisation}. Valid for {minutes} minutes.',
} as const

export type MessageKey = keyof typeof en
export type Catalog = Record<MessageKey, string>
