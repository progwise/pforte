import formbody from '@fastify/formbody'
import { hash } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { checkCode, CodeLimitError, issueCode, markEmailVerified } from '@progwise/pforte-db/codes'
import { closePasskeyOffer, confirmPhone, continuePasskeyOffer, findPasskeyOffer, getClient, requestActivationLink } from '@progwise/pforte-db/admin'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { completeActivation, completePasswordReset, findPendingActivation } from '@progwise/pforte-db/credentials'
import { findUserByEmail } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import type { LoginAudit } from '../auth/login-audit.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { checkPassword } from '../auth/password-policy.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import { newDeviceCookie } from '../interaction/device-cookie.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import type { Ui } from '../ui/index.js'
import type { ClientLogouts } from '../oidc/client-logouts.js'
import type { Passkeys } from '../passkeys/index.js'
import type { Background } from '../security/background.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import type { PageSet } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'

export interface AccountDependencies {
  db: Database
  sendPasswordResetCode: SendPasswordResetCode
  /** The secrets that sign one-time codes (see `deriveCodeSecrets`). */
  codeSecrets: string[]
  /** Sends the code that confirms a phone number, activation links and the notice that a password was changed. */
  notifier: Pick<Notifier, 'smsAvailable' | 'sendPhoneCode' | 'sendActivationLink' | 'sendPasswordChanged'>
  /** Whether a person without a password may ask for their activation link on the reset page (`SELF_SERVICE_ACTIVATION`). */
  selfServiceActivation: boolean
  /** Sign the cookie that carries the phone confirmation step. */
  cookieKeys: string[]
  /** Whether the service is reached over https, which makes cookies `Secure`. */
  secure: boolean
  /** The public address of pforte: forms are only accepted from pages served there. */
  issuer: string
  /** The pages and their languages. */
  ui: Ui
  /** Says when somebody has tried too often. */
  limiter: RateLimiter
  /** Tells the audit log what happened. */
  audit: LoginAudit
  /** Runs what must not delay an answer. */
  background: Background
  /** Tells the applications of a user whose sessions a password reset ended. */
  clientLogouts: ClientLogouts
  /** Offering a passkey to somebody who has just activated their account. */
  passkeys: Passkeys
}

const PHONE_COOKIE = 'pforte_phone_step'
const PHONE_STEP_SECONDS = 30 * 60
interface PhoneStep {
  userId: string
  expiresAt: number
  /** The application the person was invited to, for the button on the last page. */
  clientId?: string
}

const PASSKEY_COOKIE = 'pforte_activation_passkey'
const PASSKEY_STEP_SECONDS = 15 * 60
/** Where the offer of a passkey at the end of an activation belongs. */
const ACTIVATION_OFFER = 'activation'
/**
 * What is noted about somebody who has just activated their account and is asked whether they want a passkey.
 * Only an activation opens such an offer, once, when the password is chosen. It is kept at pforte, with the
 * person: it lets a passkey be made for them for a quarter of an hour (after the phone step, where there is one),
 * and ends when they answer and when their sessions are ended. The browser holds a token. No later step opens
 * another: confirming the phone number only carries this one on.
 */
interface PasskeyStep {
  clientId?: string
  /** What the last page says: the account is active, or also that the phone number is confirmed. */
  done: 'account' | 'phone'
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const normalizeEmail = (value: unknown) => text(value).trim().toLowerCase()

/** Pages that are not part of a sign-in: choosing the first password, and choosing a new one after forgetting it. */
export const accountRoutes =
  ({ db, sendPasswordResetCode, codeSecrets, notifier, selfServiceActivation, cookieKeys, secure, issuer, ui, limiter, audit, background, clientLogouts, passkeys }: AccountDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)
    ui.pages.addHeaders(app)
    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const view = ui.pages.for(languageOf(request, (request.query as Record<string, unknown> | undefined)?.lang))
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).type('text/html').send(body)
    const origin = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })

    /**
     * The language of a page: one given explicitly (a `lang` in the link or form), else the user's own where
     * the page is about a user who is already known, else the browser's, else the default. Pages that must
     * not reveal whether an address has an account never pass a user language.
     */
    const languageOf = (request: FastifyRequest, explicit?: unknown, userLanguage?: string) =>
      ui.i18n.pick(text(explicit) || undefined, userLanguage, parseAcceptLanguage(request.headers['accept-language']))

    /** The password and its repetition, checked against the policy. Returns what is wrong, if anything. */
    const passwordProblem = (view: PageSet, body: Record<string, unknown> | undefined, email: string) => {
      const password = text(body?.password)
      if (password !== text(body?.confirm)) return view.t('password.mismatch')
      const problem = checkPassword(password, email)
      return problem && view.t(problem.key, problem.values)
    }

    const invalidLink = (reply: FastifyReply, view: PageSet) =>
      html(reply, 400, view.notice(view.t('activate.invalidTitle'), view.t('activate.invalid')))
    /**
     * The button that leads on to the application, if the client is known and has a start address. Only the address
     * registered for the client is ever linked, never one that came with the request.
     */
    const continueTo = async (view: PageSet, clientId?: string) => {
      const client = clientId ? await getClient(db, clientId) : undefined
      return client?.clientUri ? { href: client.clientUri, label: view.t('continue.button', { name: client.name }) } : undefined
    }
    const activeAccount = async (view: PageSet, clientId?: string) =>
      view.notice(view.t('activate.doneTitle'), view.t('activate.done'), await continueTo(view, clientId))
    const confirmedPhone = async (view: PageSet, clientId?: string) => view.notice(view.t('phone.doneTitle'), view.t('phone.done'), await continueTo(view, clientId))

    /** The activation page. Its script only finds out whether this device can make a passkey, for the offer that may follow. */
    const activationPage = (reply: FastifyReply, view: PageSet, status: number, options: { token: string; error?: string; remember?: boolean }) => {
      passkeys.script.allow(reply)
      return html(reply, status, view.activation({ ...options, passkeyProbe: { field: passkeys.script.capableField, script: passkeys.script.tag } }))
    }

    // --- The offer of a passkey, the last step of an activation on a device that can make one

    const passkeyCookie = (value: string, maxAgeSeconds: number) => setCookieHeader(PASSKEY_COOKIE, value, { path: '/activate', maxAgeSeconds, secure })
    const passkeyToken = (request: FastifyRequest) => readCookie(request.headers.cookie, PASSKEY_COOKIE) ?? ''
    /**
     * On to the offer that the activation opened, if there is one and it is still open: it now runs for a quarter
     * of an hour, and `done` is what the last page will say. Returns false where there is nothing to go on to.
     */
    const continueOffer = (token: string, done: PasskeyStep['done']) =>
      continuePasskeyOffer(db, { token, boundTo: ACTIVATION_OFFER }, { details: { done }, expiresAt: new Date(Date.now() + PASSKEY_STEP_SECONDS * 1000) })
    const toOffer = (reply: FastifyReply, cookies: string[]) => reply.header('Set-Cookie', cookies).redirect('/activate/passkey', 303)
    const isStep = (details: Record<string, unknown>): details is Record<string, unknown> & PasskeyStep =>
      (details.done === 'account' || details.done === 'phone') && (details.clientId === undefined || typeof details.clientId === 'string')
    /** The person who is being offered a passkey: the token of this browser stands for an offer that is still open, to somebody who can sign in. */
    const passkeyStep = async (request: FastifyRequest) => {
      const open = await findPasskeyOffer(db, { token: passkeyToken(request), boundTo: ACTIVATION_OFFER })
      if (!open || !isStep(open.details)) return undefined
      const user = await findActiveUserById(db, open.userId)
      return user ? { step: open.details, user } : undefined
    }
    type PasskeyWaiting = NonNullable<Awaited<ReturnType<typeof passkeyStep>>>
    const viewOf = (request: FastifyRequest, waiting?: PasskeyWaiting) => ui.pages.for(languageOf(request, undefined, waiting?.user.language))

    /** The page an activation ends with. `answer` is what the person said to the offer, where it was theirs to answer. */
    const lastPage = async (request: FastifyRequest, reply: FastifyReply, { step, user }: PasskeyWaiting, answer?: 'later' | 'done') => {
      reply.header('Set-Cookie', answer ? [passkeyCookie('', 0), passkeys.offers.answered(request.headers.cookie, user.id, answer)] : [passkeyCookie('', 0)])
      const view = viewOf(request, { step, user })
      return html(reply, 200, step.done === 'phone' ? await confirmedPhone(view, step.clientId) : await activeAccount(view, step.clientId))
    }
    /** Closes the offer and ends the activation. From now on its token opens nothing, whoever kept a copy. */
    const afterOffer = async (request: FastifyRequest, reply: FastifyReply, waiting: PasskeyWaiting, answer: 'later' | 'done') => {
      const closed = await closePasskeyOffer(db, { token: passkeyToken(request), boundTo: ACTIVATION_OFFER })
      return lastPage(request, reply, waiting, closed ? answer : undefined)
    }
    const offerPage = async (request: FastifyRequest, reply: FastifyReply, waiting: PasskeyWaiting, error?: string) => {
      const options = await passkeys.enrolment.ask(waiting.user, `activation:${waiting.user.id}`, PASSKEY_STEP_SECONDS)
      if (!options) return afterOffer(request, reply, waiting, 'done')
      passkeys.script.allow(reply)
      return html(
        reply,
        error ? 422 : 200,
        viewOf(request, waiting).passkeyOffer({ action: '/activate/passkey', skipAction: '/activate/passkey/skip', attributes: passkeys.script.createAttributes(options), script: passkeys.script.tag, error }),
      )
    }

    app.get('/activate/passkey', async (request, reply) => {
      const waiting = await passkeyStep(request)
      // Nobody is waiting: the link was opened without an activation before it, or too late.
      return waiting ? offerPage(request, reply, waiting) : html(reply, 200, await activeAccount(viewOf(request)))
    })

    app.post<{ Body: Record<string, unknown> }>('/activate/passkey', async (request, reply) => {
      const waiting = await passkeyStep(request)
      if (!waiting) return html(reply, 200, await activeAccount(viewOf(request)))
      // As after a sign-in: the offer is closed in the transaction that stores the passkey, with the person's row
      // locked, so that ending their sessions or another answer cannot come between the two.
      const outcome = await passkeys.enrolment.complete(request, waiting.user, `activation:${waiting.user.id}`, request.body?.credential, async (tx) => {
        const closed = await closePasskeyOffer(tx, { token: passkeyToken(request), boundTo: ACTIVATION_OFFER })
        return closed?.userId === waiting.user.id
      })
      if (outcome === 'revoked') return lastPage(request, reply, waiting)
      if (outcome === 'added' || outcome === 'duplicate' || outcome === 'too-many') return lastPage(request, reply, waiting, 'done')
      return offerPage(request, reply, waiting, viewOf(request, waiting).t('passkeyOffer.failed'))
    })

    app.post('/activate/passkey/skip', async (request, reply) => {
      const waiting = await passkeyStep(request)
      return waiting ? afterOffer(request, reply, waiting, 'later') : html(reply, 200, await activeAccount(viewOf(request)))
    })

    // --- First password, from the link in the activation e-mail

    app.get<{ Querystring: { token?: string; lang?: string } }>('/activate', async (request, reply) => {
      const token = text(request.query.token)
      const wait = await limiter.activationBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'activation' })
        return tooManyRequests(reply, ui.pages.for(languageOf(request, request.query.lang)), wait)
      }

      const user = token ? await findPendingActivation(db, token) : undefined
      const view = ui.pages.for(languageOf(request, request.query.lang, user?.language))
      if (!user) {
        await limiter.activationFailed(request.ip)
        return invalidLink(reply, view)
      }
      return activationPage(reply, view, 200, { token })
    })

    app.post<{ Body: Record<string, unknown> }>('/activate', async (request, reply) => {
      const token = text(request.body?.token)
      const wait = await limiter.activationBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'activation' })
        return tooManyRequests(reply, ui.pages.for(languageOf(request, request.body?.lang)), wait)
      }

      const pending = token ? await findPendingActivation(db, token) : undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang, pending?.language))
      if (!pending) {
        await limiter.activationFailed(request.ip)
        return invalidLink(reply, view)
      }

      // The link showed that the person reads the mailbox, which is what a sign-in code would show a moment later.
      // So the browser can be remembered here as it can be with a code: only with the box ticked.
      const remember = request.body?.remember === 'on'
      const problem = passwordProblem(view, request.body, pending.email)
      if (problem) return activationPage(reply, view, 422, { token, error: problem, remember })

      const clientId = pending.activationClientId ?? undefined
      // The script of the page says whether this device can make a passkey. If so, one is offered at the end. The
      // offer is opened with the activation itself, in its transaction: whatever ends this person's sessions from
      // now on finds it. It is good for as long as the phone step may take, which may come first.
      const capable = request.body?.passkeys === '1'
      const step: PasskeyStep = { ...(clientId ? { clientId } : {}), done: 'account' }
      const activated = await completeActivation(db, {
        token,
        passwordHash: await hash(text(request.body?.password)),
        remember,
        passkeyOffer: capable ? { boundTo: ACTIVATION_OFFER, details: { ...step }, expiresAt: new Date(Date.now() + PHONE_STEP_SECONDS * 1000) } : undefined,
        ...origin(request),
      })
      if (!activated) return invalidLink(reply, view)
      const { user, deviceToken, offerToken } = activated
      // Set now, whatever follows: the person may confirm the phone number, skip that, or close the page.
      const cookies = [...(deviceToken ? [newDeviceCookie(deviceToken, secure)] : []), ...(offerToken ? [passkeyCookie(offerToken, PHONE_STEP_SECONDS)] : [])]

      // With SMS available, the number the back office entered is confirmed now, so that codes can go to it.
      if (notifier.smsAvailable && user.phone && !user.phoneVerifiedAt) {
        try {
          await sendPhoneCode({ ...user, phone: user.phone })
          // The offer, if there is one, waits behind the phone step.
          reply.header('Set-Cookie', [...cookies, phoneCookie(user.id, clientId)])
          return html(reply, 200, view.phoneConfirm({ sentTo: maskPhone(user.phone) }))
        } catch (error) {
          if (!(error instanceof NotifierUnavailableError)) throw error
          request.log.error(error, 'the code to confirm the phone number could not be sent')
        }
      }
      // No phone step: straight on to the offer, if it is still open. The link showed that the person reads the
      // mailbox, and they have just chosen their password: they are who the account is for, as much as after a
      // sign-in with a code.
      if (offerToken && (await continueOffer(offerToken, 'account'))) return toOffer(reply, cookies)
      if (cookies.length > 0) reply.header('Set-Cookie', cookies)
      return html(reply, 200, await activeAccount(view, clientId))
    })

    const phoneCookie = (userId: string, clientId?: string) =>
      setCookieHeader(PHONE_COOKIE, sign(cookieKeys, { userId, expiresAt: Date.now() + PHONE_STEP_SECONDS * 1000, ...(clientId ? { clientId } : {}) } satisfies PhoneStep), {
        path: '/activate',
        maxAgeSeconds: PHONE_STEP_SECONDS,
        secure,
      })

    /** The code is bound to the number it goes to: it confirms that number and no other (see `confirmPhone`). */
    const sendPhoneCode = async (user: { id: string; email: string; firstName: string; lastName: string; language: string; phone: string }) => {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: user.phone }, { secrets: codeSecrets })
      await notifier.sendPhoneCode(user, { code, expiresAt })
    }

    /** The user in the middle of confirming their phone, from the cookie set when the password was chosen. */
    const phoneStep = async (request: FastifyRequest) => {
      const step = unsign<PhoneStep>(cookieKeys, readCookie(request.headers.cookie, PHONE_COOKIE))
      if (!step || step.expiresAt < Date.now()) return undefined
      const user = await findActiveUserById(db, step.userId)
      return user?.phone && !user.phoneVerifiedAt ? { ...user, phone: user.phone, clientId: step.clientId } : undefined
    }

    const endOfPhoneStep = setCookieHeader(PHONE_COOKIE, '', { path: '/activate', maxAgeSeconds: 0, secure })
    const finishedPhoneStep = (reply: FastifyReply, page: string) => {
      reply.header('Set-Cookie', endOfPhoneStep)
      return html(reply, 200, page)
    }

    app.post<{ Body: Record<string, unknown> }>('/activate/phone', async (request, reply) => {
      const user = await phoneStep(request)
      const view = ui.pages.for(languageOf(request, undefined, user?.language))
      if (!user) return html(reply, 200, await activeAccount(view))

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'phone_code' })
        return tooManyRequests(reply, view, wait)
      }

      const code = text(request.body?.code).replaceAll(' ', '')
      const result = /^\d{6}$/.test(code)
        ? await confirmPhone(db, { actor: { type: 'user', id: user.id }, ...origin(request), self: true }, { userId: user.id, code }, { secrets: codeSecrets })
        : undefined
      if (!result?.ok) {
        await limiter.codeFailed(request.ip)
        await audit.codeFailed(origin(request), { userId: user.id, purpose: 'activation', reason: result?.reason ?? 'malformed' })
        return html(reply, 401, view.phoneConfirm({ sentTo: maskPhone(user.phone), error: view.t('code.badOrExpired') }))
      }
      // On to the offer the activation opened, if this device was offered one. The phone step itself opens none.
      if (await continueOffer(passkeyToken(request), 'phone')) return toOffer(reply, [endOfPhoneStep])
      return finishedPhoneStep(reply, await confirmedPhone(view, user.clientId))
    })

    app.post('/activate/phone/resend', async (request, reply) => {
      const user = await phoneStep(request)
      const view = ui.pages.for(languageOf(request, undefined, user?.language))
      if (!user) return html(reply, 200, await activeAccount(view))

      const sendWait = await limiter.codeResend(request.ip)
      if (sendWait > 0) {
        await audit.blocked(origin(request), { scope: 'code_resend' })
        return tooManyRequests(reply, view, sendWait)
      }

      try {
        await sendPhoneCode(user)
      } catch (error) {
        if (error instanceof CodeLimitError) {
          return html(reply, 429, view.phoneConfirm({ sentTo: maskPhone(user.phone), error: view.t('phone.wait', { seconds: error.retryAfterSeconds }) }))
        }
        if (!(error instanceof NotifierUnavailableError)) throw error
        request.log.error(error, 'the code to confirm the phone number could not be sent')
        return html(reply, 503, view.phoneConfirm({ sentTo: maskPhone(user.phone), error: view.t('phone.cannotSend') }))
      }
      return html(reply, 200, view.phoneConfirm({ sentTo: maskPhone(user.phone), notice: view.t('code.newOnItsWay') }))
    })

    app.post('/activate/phone/skip', async (request, reply) => {
      const user = await phoneStep(request)
      if (user && (await continueOffer(passkeyToken(request), 'account'))) return toOffer(reply, [endOfPhoneStep])
      return finishedPhoneStep(reply, await activeAccount(ui.pages.for(languageOf(request, undefined, user?.language)), user?.clientId))
    })

    // --- Forgotten password

    app.get<{ Querystring: { email?: string; lang?: string; client_id?: string } }>('/reset', async (request, reply) =>
      html(
        reply,
        200,
        ui.pages.for(languageOf(request, request.query.lang)).forgotPassword({ email: normalizeEmail(request.query.email), clientId: text(request.query.client_id) || undefined }),
      ),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      const clientId = text(request.body?.client_id) || undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang))
      if (!email.includes('@')) return html(reply, 400, view.forgotPassword({ email, clientId, error: view.t('reset.noEmail') }))

      // Every address is counted, existing or not, so being over the limit says nothing about an account.
      const wait = await limiter.resetRequest(email, request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'reset', email })
        return tooManyRequests(reply, view, wait)
      }

      // The answer is the same whether or not the address belongs to someone, and it is sent before anyone looks
      // for the account, so neither the page nor the time it takes can be used to find out who has one.
      const where = origin(request)
      // Started only once the response is out: while it is being written the lookup and the mail would compete
      // with it for the server's attention, and for an existing account that would make the answer a little slower.
      reply.raw.once('finish', () =>
        background.run(async () => {
          const user = await findUserByEmail(db, email)
          // Somebody who has no password yet gets a new activation link instead of a code.
          if (user?.status === 'created' && selfServiceActivation) {
            try {
              // The application the person came from, if it is a registered one: the mail names it and the page ends with a button to it.
              const client = clientId ? await getClient(db, clientId) : undefined
              const result = await db.transaction((tx) =>
                requestActivationLink(tx, { actor: { type: 'user', id: user.id }, ...where }, user, { clientId: client?.clientId }),
              )
              if (!result) return
              const url = `${issuer}/activate?token=${encodeURIComponent(result.activation.token)}`
              await notifier.sendActivationLink(
                { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, language: user.language, phone: user.phone },
                { url, expiresAt: result.activation.expiresAt, applicationName: client?.name },
              )
            } catch (error) {
              if (error instanceof NotifierUnavailableError) request.log.error(error, 'the activation link could not be sent')
              else throw error
            }
            return
          }
          if (user?.status !== 'active' || !user.passwordHash) return
          try {
            const channel = await sendPasswordResetCode(user)
            await audit.resetRequested(where, { userId: user.id })
            await audit.codeSent(where, { userId: user.id, purpose: 'password_reset', channel })
          } catch (error) {
            if (error instanceof NotifierUnavailableError) request.log.error(error, 'the password reset code could not be sent')
            else if (!(error instanceof CodeLimitError)) throw error
          }
        }),
      )
      return html(reply, 200, view.resetCode({ email, clientId, notice: view.t('reset.sent') }))
    })

    app.get<{ Querystring: { email?: string; lang?: string; client_id?: string } }>('/reset/code', async (request, reply) =>
      html(
        reply,
        200,
        ui.pages.for(languageOf(request, request.query.lang)).resetCode({ email: normalizeEmail(request.query.email), clientId: text(request.query.client_id) || undefined }),
      ),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset/code', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      const clientId = text(request.body?.client_id) || undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang))
      // Before the code is looked at, so that a typo in the password does not use up an attempt.
      const problem = passwordProblem(view, request.body, email)
      if (problem) return html(reply, 422, view.resetCode({ email, clientId, error: problem }))

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'reset_code', email })
        return tooManyRequests(reply, view, wait)
      }

      const code = text(request.body?.code).replaceAll(' ', '')
      const user = await findUserByEmail(db, email)
      // One answer for every way this can fail, so it reveals nothing about the account; all of them count.
      const refused = async (reason: string) => {
        await limiter.codeFailed(request.ip)
        await audit.codeFailed(origin(request), { userId: user?.id, email, purpose: 'password_reset', reason })
        return html(reply, 401, view.resetCode({ email, clientId, error: view.t('code.badOrExpired') }))
      }
      if (!user) return refused('unknown_user')
      if (user.status !== 'active' || !user.passwordHash) return refused('not_allowed')
      if (!/^\d{6}$/.test(code)) return refused('malformed')

      const result = await checkCode(db, { userId: user.id, purpose: 'password_reset', code }, { secrets: codeSecrets })
      if (!result.ok) return refused(result.reason)

      const changed = await completePasswordReset(db, { userId: user.id, passwordHash: await hash(text(request.body?.password)), ...origin(request) })
      if (!changed) return refused('not_allowed')
      clientLogouts.send(user, changed.logouts)
      if (result.channel === 'email') await markEmailVerified(db, user.id)
      // The rightful person learns of a reset that somebody else did. Not tied to the response: the notice must
      // go out even if the browser has gone, and a mail server that is down must not turn a reset into an error.
      background.run(async () => {
        try {
          await notifier.sendPasswordChanged(user, { url: `${issuer}/reset?email=${encodeURIComponent(user.email)}&lang=${encodeURIComponent(user.language)}` })
        } catch (error) {
          if (error instanceof NotifierUnavailableError) request.log.error(error, 'the notice that the password was changed could not be sent')
          else throw error
        }
      })
      return html(reply, 200, view.notice(view.t('reset.doneTitle'), view.t('reset.done'), await continueTo(view, clientId)))
    })
  }
