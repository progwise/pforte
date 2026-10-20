import type { Catalog } from './en.js'

export const hu: Catalog = {
  'common.cancel': 'Mégse',
  'common.code': 'Kód',
  'common.email': 'E-mail',
  'common.sendNewCode': 'Új kód küldése',

  'login.title': 'Bejelentkezés',
  'login.titleTo': 'Bejelentkezés ide: {client}',
  'login.password': 'Jelszó',
  'login.submit': 'Bejelentkezés',
  'login.forgot': 'Elfelejtette a jelszavát?',
  'login.wrong': 'Az e-mail-cím vagy a jelszó nem helyes.',

  'code.title': 'Adja meg a kódot',
  'code.sentEmail': '6 számjegyű kódot küldtünk e-mailben erre a címre: {to}. A kód 10 percig érvényes.',
  'code.sentSms': '6 számjegyű kódot küldtünk SMS-ben erre a számra: {to}. A kód 10 percig érvényes.',
  'code.remember': 'Az eszköz megjegyzése 90 napig, hogy itt ne kelljen újra kódot megadnom',
  'code.submit': 'Tovább',
  'code.useEmail': 'Inkább e-mailben kérem a kódot',
  'code.phoneHint':
    'A kódokat e-mailben kapja, mert nincs megadva mobilszám. Kérje az adminisztrációt, hogy rögzítse a számát, ha inkább SMS-ben szeretné kapni a kódokat.',
  'code.wrong': 'A kód nem helyes.',
  'code.exhausted': 'Túl sok hibás próbálkozás. Kérjen új kódot.',
  'code.expired': 'A kód lejárt. Kérjen újat.',
  'code.none': 'Nincs érvényes kód. Kérjen újat.',
  'code.newOnItsWay': 'Az új kód úton van.',
  'code.badOrExpired': 'A kód nem helyes, vagy lejárt. Lent kérhet újat.',
  'code.cooldown': 'Nemrég küldtünk egy kódot. Új kódot {seconds} másodperc múlva kérhet.',
  'code.tooMany': 'Túl sok kódot kért. Kérjük, próbálja újra {minutes} perc múlva.',
  'code.tooManyTitle': 'Túl sok kód',

  'limit.title': 'Túl sok próbálkozás',
  'limit.text': 'A hálózatáról vagy erre a címre túl sok próbálkozás érkezett. Kérjük, próbálja újra {minutes} perc múlva.',

  'error.title': 'Valami hiba történt',
  'error.generic': 'A kérést nem sikerült teljesíteni.',
  'error.refusedTitle': 'A kérés elutasítva',
  'error.refused': 'Ez a kérés nem erről az oldalról érkezett. Kérjük, térjen vissza az előző oldalra, és próbálja újra.',
  'error.signInExpiredTitle': 'A bejelentkezés lejárt',
  'error.signInExpired': 'Ez a bejelentkezési kérés lejárt. Térjen vissza az alkalmazáshoz, és kezdje elölről.',
  'error.notSupportedTitle': 'Nem támogatott',
  'error.notSupported': 'Ez a kérés nem teljesíthető.',
  'error.cannotSendTitle': 'A kód nem küldhető el',
  'error.cannotSend': 'A kódot nem sikerült elküldeni. Kérjük, próbálja újra később.',

  'password.new': 'Új jelszó',
  'password.confirm': 'Új jelszó még egyszer',
  'password.hint': 'Legalább 10 karakter. Néhány véletlenszerű szó jó jelszót ad.',
  'password.mismatch': 'A két jelszó nem egyezik.',
  'password.tooShort': 'A jelszónak legalább {min} karakterből kell állnia.',
  'password.tooLong': 'A jelszó legfeljebb {max} karakter lehet.',
  'password.isEmail': 'A jelszó nem lehet az e-mail-címe.',

  'activate.title': 'Válasszon jelszót',
  'activate.submit': 'Fiókom aktiválása',
  'activate.invalidTitle': 'Érvénytelen hivatkozás',
  'activate.invalid':
    'Ez a hivatkozás már nem érvényes. Lehet, hogy már felhasználták, vagy lejárt. Kérjen újat az adminisztrációtól.',
  'activate.doneTitle': 'A fiókja aktív',
  'activate.done': 'A jelszava beállítva. Most már bejelentkezhet abból az alkalmazásból, ahonnan érkezett.',

  'reset.title': 'Elfelejtette a jelszavát?',
  'reset.intro': 'Adja meg az e-mail-címét. Küldünk egy kódot, amellyel új jelszót választhat.',
  'reset.send': 'Kód küldése',
  'reset.noEmail': 'Kérjük, adja meg az e-mail-címét.',
  'reset.sent': 'Ha ehhez a címhez tartozik fiók, elküldtük neki a kódot. A kód 10 percig érvényes.',
  'reset.codeTitle': 'Új jelszó választása',
  'reset.codeSubmit': 'Jelszó módosítása',
  'reset.doneTitle': 'A jelszó megváltozott',
  'reset.done': 'Az új jelszava be van állítva, és mindenhol kijelentkeztettük. Jelentkezzen be újra az alkalmazásban.',

  'phone.title': 'Telefonszám megerősítése',
  'phone.intro':
    'A fiókja aktív. 6 számjegyű kódot küldtünk SMS-ben erre a számra: {to}. Adja meg, hogy a bejelentkezési kódokat ezentúl SMS-ben kapja.',
  'phone.confirm': 'Megerősítés',
  'phone.skip': 'Most kihagyom (a kódok e-mailben érkeznek)',
  'phone.wait': 'Kérjük, várjon {seconds} másodpercet, mielőtt újabb kódot kér.',
  'phone.cannotSend': 'A kódot nem sikerült elküldeni. Kihagyhatja ezt a lépést, és később megerősítheti.',
  'phone.doneTitle': 'A telefonszám megerősítve',
  'phone.done':
    'A fiókja aktív, és a bejelentkezési kódok SMS-ben érkeznek. Most már bejelentkezhet abból az alkalmazásból, ahonnan érkezett.',

  'mail.loginCode.subject': 'Bejelentkezési kódja: {organisation}',
  'mail.loginCode.text':
    'Tisztelt {firstName}!\n\nA bejelentkezési kódja: {code}. A kód {minutes} percig érvényes.\n\nHa nem Ön próbált bejelentkezni, ne adja át senkinek a kódot, és értesítse az adminisztrációt.\n',
  'mail.activation.subject': 'Aktiválja a fiókját: {organisation}',
  'mail.activation.text':
    'Tisztelt {firstName}!\n\nFiókot hoztak létre Önnek itt: {organisation}. Ezen a hivatkozáson választhat jelszót:\n\n{url}\n\nA hivatkozás {hours} óráig érvényes. Ha nem számított erre az üzenetre, figyelmen kívül hagyhatja.\n',
  'mail.resetCode.subject': 'Új jelszó: {organisation}',
  'mail.resetCode.text':
    'Tisztelt {firstName}!\n\nAz új jelszó választásához szükséges kódja: {code}. A kód {minutes} percig érvényes. Itt adhatja meg:\n\n{url}\n\nHa nem kért új jelszót, hagyja figyelmen kívül ezt az üzenetet; a jelszava változatlan marad.\n',

  'sms.login': 'A(z) {organisation} bejelentkezési kódja: {code}. {minutes} percig érvényes. Ne adja át senkinek.',
  'sms.reset': 'A(z) {organisation} új jelszavához szükséges kód: {code}. {minutes} percig érvényes. Ne adja át senkinek.',
  'sms.phone': 'A(z) {organisation} telefonszám-megerősítő kódja: {code}. {minutes} percig érvényes.',
}
