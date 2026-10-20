/**
 * The texts of the administration UI. They exist in English and German; other languages show the English
 * ones, so unlike the texts of the sign-in pages they are not checked for every language.
 */
export const adminEn = {
  'manage.title': 'Administration',
  'manage.nav.label': 'Sections',
  'manage.nav.home': 'Start',
  'manage.signedInAs': 'Signed in as {name}',
  'manage.signOut': 'Sign out',
  'manage.signIn': 'Sign in',

  'manage.home.title': 'Administration',
  'manage.home.intro': 'You are signed in to the administration of {organisation}. Choose a section above.',

  'manage.notAdmin.title': 'Not an administrator',
  'manage.notAdmin.text': '{name} can sign in, but is not an administrator, so the administration is not open to this account.',
  'manage.signedOut.title': 'You are signed out',
  'manage.signedOut.text': 'The administration is closed. Sign in again when you need it.',
  'manage.loginFailed.title': 'Signing in did not work',
  'manage.loginFailed.text': 'The sign-in could not be completed. Please try again.',
  'manage.secondFactor.title': 'A code is needed',
  'manage.secondFactor.text': 'The administration needs the code of the second factor every time. Please sign in again and enter the code.',
  'manage.error.title': 'Something went wrong',
  'manage.error.text': 'The request could not be completed. Please try again.',
} as const

export type AdminKey = keyof typeof adminEn
export type AdminCatalog = Record<AdminKey, string>
