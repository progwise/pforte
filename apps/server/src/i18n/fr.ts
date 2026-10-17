import type { Catalog } from './en.js'

export const fr: Catalog = {
  'common.cancel': 'Annuler',
  'common.code': 'Code',
  'common.email': 'E-mail',
  'common.sendNewCode': 'Envoyer un nouveau code',

  'login.title': 'Connexion',
  'login.titleTo': 'Connexion à {client}',
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter',
  'login.forgot': 'Mot de passe oublié ?',
  'login.wrong': "L'adresse e-mail ou le mot de passe n'est pas correct.",

  'code.title': 'Saisir le code',
  'code.sentEmail': 'Nous avons envoyé un code à 6 chiffres par e-mail à {to}. Il est valable 10 minutes.',
  'code.sentSms': 'Nous avons envoyé un code à 6 chiffres par SMS à {to}. Il est valable 10 minutes.',
  'code.remember': 'Mémoriser cet appareil pendant 90 jours pour ne plus avoir à saisir de code ici',
  'code.submit': 'Continuer',
  'code.useEmail': 'Envoyer plutôt le code par e-mail',
  'code.phoneHint':
    "Vous recevez les codes par e-mail, car aucun numéro de portable n'est enregistré. Demandez à votre administration d'ajouter le vôtre si vous préférez les recevoir par SMS.",
  'code.wrong': "Le code n'est pas correct.",
  'code.exhausted': 'Trop de tentatives incorrectes. Veuillez demander un nouveau code.',
  'code.expired': 'Le code a expiré. Veuillez en demander un nouveau.',
  'code.none': "Il n'y a pas de code valable. Veuillez en demander un nouveau.",
  'code.newOnItsWay': 'Un nouveau code est en route.',
  'code.badOrExpired': "Le code n'est pas correct ou a expiré. Vous pouvez en demander un nouveau ci-dessous.",
  'code.cooldown': "Un code vient d'être envoyé. Vous pourrez en demander un nouveau dans {seconds} secondes.",
  'code.tooMany': 'Trop de codes ont été demandés. Veuillez réessayer dans {minutes} minutes.',
  'code.tooManyTitle': 'Trop de codes',

  'error.title': "Une erreur s'est produite",
  'error.generic': "La demande n'a pas pu être traitée.",
  'error.signInExpiredTitle': 'Connexion expirée',
  'error.signInExpired': "Cette demande de connexion a expiré. Veuillez retourner à l'application et recommencer.",
  'error.notSupportedTitle': 'Non pris en charge',
  'error.notSupported': "Cette demande ne peut pas être traitée.",
  'error.cannotSendTitle': "Impossible d'envoyer le code",
  'error.cannotSend': "Le code n'a pas pu être envoyé. Veuillez réessayer plus tard.",

  'password.new': 'Nouveau mot de passe',
  'password.confirm': 'Répéter le nouveau mot de passe',
  'password.hint': 'Au moins 10 caractères. Quelques mots choisis au hasard font un bon mot de passe.',
  'password.mismatch': 'Les deux mots de passe ne sont pas identiques.',
  'password.tooShort': 'Le mot de passe doit comporter au moins {min} caractères.',
  'password.tooLong': 'Le mot de passe ne doit pas dépasser {max} caractères.',
  'password.isEmail': "Le mot de passe ne doit pas être votre adresse e-mail.",

  'activate.title': 'Choisir votre mot de passe',
  'activate.submit': 'Activer mon compte',
  'activate.invalidTitle': 'Lien non valable',
  'activate.invalid':
    "Ce lien n'est plus valable. Il a peut-être déjà été utilisé ou a expiré. Demandez-en un nouveau à votre administration.",
  'activate.doneTitle': 'Votre compte est actif',
  'activate.done': "Votre mot de passe est défini. Vous pouvez maintenant vous connecter depuis l'application d'où vous venez.",

  'reset.title': 'Mot de passe oublié ?',
  'reset.intro': 'Saisissez votre adresse e-mail. Nous vous envoyons un code pour choisir un nouveau mot de passe.',
  'reset.send': 'Envoyer le code',
  'reset.noEmail': 'Veuillez saisir votre adresse e-mail.',
  'reset.sent':
    'Si un compte existe pour cette adresse, nous lui avons envoyé un code. Il est valable 10 minutes.',
  'reset.codeTitle': 'Choisir un nouveau mot de passe',
  'reset.codeSubmit': 'Changer mon mot de passe',
  'reset.doneTitle': 'Mot de passe modifié',
  'reset.done':
    "Votre nouveau mot de passe est défini et vous avez été déconnecté partout. Reconnectez-vous depuis votre application.",

  'phone.title': 'Confirmer votre numéro de téléphone',
  'phone.intro':
    'Votre compte est actif. Nous avons envoyé un code à 6 chiffres par SMS à {to}. Saisissez-le pour recevoir désormais vos codes de connexion par SMS.',
  'phone.confirm': 'Confirmer',
  'phone.skip': 'Passer pour le moment (les codes arrivent par e-mail)',
  'phone.wait': 'Veuillez patienter {seconds} secondes avant de demander un autre code.',
  'phone.cannotSend': "Le code n'a pas pu être envoyé. Vous pouvez passer cette étape et confirmer plus tard.",
  'phone.doneTitle': 'Numéro de téléphone confirmé',
  'phone.done':
    "Votre compte est actif et vos codes de connexion arriveront par SMS. Vous pouvez maintenant vous connecter depuis l'application d'où vous venez.",

  'mail.loginCode.subject': 'Votre code de connexion pour {organisation}',
  'mail.loginCode.text':
    "Bonjour {firstName},\n\nvotre code de connexion est {code}. Il est valable {minutes} minutes.\n\nSi vous n'avez pas essayé de vous connecter, ne communiquez ce code à personne et informez votre administration.\n",
  'mail.activation.subject': 'Activez votre compte chez {organisation}',
  'mail.activation.text':
    "Bonjour {firstName},\n\nun compte a été créé pour vous chez {organisation}. Ouvrez ce lien pour choisir votre mot de passe :\n\n{url}\n\nLe lien est valable {hours} heures. Si vous n'attendiez pas ce message, vous pouvez l'ignorer.\n",
  'mail.resetCode.subject': 'Nouveau mot de passe pour {organisation}',
  'mail.resetCode.text':
    "Bonjour {firstName},\n\nvotre code pour choisir un nouveau mot de passe est {code}. Il est valable {minutes} minutes. Saisissez-le ici :\n\n{url}\n\nSi vous n'avez pas demandé de nouveau mot de passe, ignorez ce message ; votre mot de passe reste inchangé.\n",

  'sms.login': '{code} est votre code de connexion pour {organisation}. Valable {minutes} minutes. Ne le communiquez à personne.',
  'sms.reset':
    '{code} est votre code pour choisir un nouveau mot de passe chez {organisation}. Valable {minutes} minutes. Ne le communiquez à personne.',
  'sms.phone': '{code} est votre code pour confirmer ce numéro de téléphone chez {organisation}. Valable {minutes} minutes.',
}
