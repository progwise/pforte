import formbody from '@fastify/formbody'
import type { Database } from '@progwise/pforte-db'
import {
  closePasskeyOffer,
  confirmPhone,
  continuePasskeyOffer,
  findPasskeyByCredentialId,
  findPasskeyOffer,
  LifecycleError,
  openPasskeyChallenge,
  openPasskeyOffer,
  recordPasskeyUse,
  takePasskeyChallenge,
} from '@progwise/pforte-db/admin'
import { changeCodeChannel, checkCode, CodeLimitError, currentCode, issueCode, markEmailVerified, withdrawCode } from '@progwise/pforte-db/codes'
import { findRememberedDevice, rememberDevice } from '@progwise/pforte-db/devices'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { recordLogin, sessionEpochOf, whileUserHeld } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_PASSWORD, ACR_SECOND_FACTOR, passkeyAssurance, secondFactorAssurance } from '../auth/assurance.js'
import { canConfirmPhone, channelFor, maskEmail, maskPhone } from '../auth/channels.js'
import { deriveCodeSecrets } from '../auth/code-secrets.js'
import type { Authenticate, AuthResult } from '../auth/authenticate.js'
import type { LoginAudit, Origin, PasskeyFailure } from '../auth/login-audit.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { type Channel, type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import { applyIssuerHeaders } from '../oidc/issuer-headers.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import { isHandleOf, namedBy, type Passkeys } from '../passkeys/index.js'
import type { Ui } from '../ui/index.js'
import type { PageSet } from '../ui/pages.js'
import { limitText, tooManyRequests } from '../ui/too-many.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import { adoptNewDevice, deviceCookie, deviceTokens } from './device-cookie.js'
import { createPhoneReminder } from './phone-reminder.js'
import { readCookie, setCookieHeader, sign, unsign } from './signed-cookie.js'

export interface InteractionDependencies {
  provider: Pick<ProviderHolder, 'current' | 'issuer'>
  authenticate: Authenticate
  db: Database
  notifier: Notifier
  /** The cookie keys of the service: they sign the step cookie and, derived, the one-time codes. */
  cookieKeys: string[]
  /** The pages and their languages. */
  ui: Ui
  /** Says when somebody has tried too often. */
  limiter: RateLimiter
  /** Tells the audit log what happened to attempts to sign in. */
  audit: LoginAudit
  /** Signing in with a passkey, and offering one after a sign-in with a code. */
  passkeys: Passkeys
}

const STEP_COOKIE = 'pforte_second_factor'
const STEP_LIFETIME_SECONDS = 15 * 60

/** How long the question of a login page waits for a passkey: as long as the sign-in itself may take. */
const SIGN_IN_QUESTION_SECONDS = 60 * 60

const OFFER_COOKIE = 'pforte_passkey_step'
const OFFER_LIFETIME_SECONDS = 15 * 60
/**
 * What is noted about a sign-in that is complete and waits for what the person is asked before they go back to
 * the application: to confirm a phone number that is not confirmed, and whether they want a passkey. It says what
 * the sign-in was worth, so that it can be finished after the answers, whatever they are. It is kept at pforte,
 * with the person, and ends with their sessions; the browser holds a token.
 */
interface Offer {
  acr: string
  amr: string[]
  language: string
  /** The question about the phone number is still open. It comes first. */
  phone?: boolean
  /** Whether a passkey is offered. Only `false` says no: a sign-in that waited before there was a phone step did not note it. */
  passkey?: boolean
}

interface Step {
  uid: string
  userId: string
  expiresAt: number
  /**
   * How often the person's sessions had been ended when their password was accepted. If they were ended since
   * (a password reset, "sign out everywhere", a lock), this step is over: the password it rests on may be the
   * one that was just replaced, and the person signs in again from the start.
   */
  epoch: number
  /** The language of the pages, fixed when the password was accepted. */
  language: string
}

/** The login pages the provider redirects to ("interactions"). */
export const interactionRoutes =
  ({ provider, authenticate, db, notifier, cookieKeys, ui, limiter, audit, passkeys }: InteractionDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)

    const originOf = (request: FastifyRequest): Origin => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
    const secure = provider.issuer.startsWith('https:')
    const codeSecrets = deriveCodeSecrets(cookieKeys)
    const cookiePath = (uid: string) => `/interaction/${encodeURIComponent(uid)}`
    /** Where a sign-in that waits belongs: to this one interaction. The questions to the device about a passkey are bound to the same place. */
    const offerOf = (uid: string) => `offer:${uid}`
    const phoneReminder = createPhoneReminder({ cookieKeys, secure })
    /**
     * Whether to ask this person to confirm their phone number before they go on: it is stored and not confirmed,
     * codes can go by SMS here, and they have not said "not now" in this browser lately.
     */
    const phoneStepWanted = (request: FastifyRequest, user: { id: string; phone: string | null; phoneVerifiedAt: Date | null }) =>
      canConfirmPhone(user, notifier) && phoneReminder.due(request.headers.cookie, user)

    ui.pages.addHeaders(app)
    app.addHook(
      'onRequest',
      refuseForeignPosts(provider.issuer, (request, reply) => {
        const view = ui.pages.for(languageOf(request))
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    /** The interaction this request belongs to, or undefined if the cookie or uid does not match. */
    const interactionFor = async (request: FastifyRequest, reply: FastifyReply, uid: string) => {
      applyIssuerHeaders(request.raw, provider.issuer)
      try {
        const details = await provider.current().interactionDetails(request.raw, reply.raw)
        return details.uid === uid ? details : undefined
      } catch {
        return undefined
      }
    }

    /**
     * The language of the pages: what the application asked for (`ui_locales`), else the user's own,
     * else the browser's, else the default.
     */
    const languageOf = (request: FastifyRequest, params?: Record<string, unknown>, userLanguage?: string) =>
      ui.i18n.pick(
        typeof params?.ui_locales === 'string' ? params.ui_locales.split(' ') : undefined,
        userLanguage,
        parseAcceptLanguage(request.headers['accept-language']),
      )

    type Details = NonNullable<Awaited<ReturnType<typeof interactionFor>>>

    /**
     * The login page, with a new question for a device that holds a passkey. The question belongs to this
     * sign-in and is the only one it has: showing the page again replaces it.
     */
    const loginPage = async (request: FastifyRequest, reply: FastifyReply, details: Details, { email = '', error }: { email?: string; error?: string } = {}) => {
      const client = await provider.current().Client.find(String(details.params.client_id))
      const options = await passkeys.ceremonies.requestOptions()
      await openPasskeyChallenge(db, { challenge: options.challenge, boundTo: `sign-in:${details.uid}` }, new Date(Date.now() + SIGN_IN_QUESTION_SECONDS * 1000), { only: true })
      passkeys.script.allow(reply)
      return ui.pages.for(languageOf(request, details.params)).login({
        uid: details.uid,
        clientName: client?.clientName,
        clientId: client?.clientId,
        email,
        error,
        passkey: { attributes: passkeys.script.requestAttributes(options), script: passkeys.script.tag },
      })
    }

    const expired = (request: FastifyRequest, reply: FastifyReply) => {
      const view = ui.pages.for(languageOf(request))
      return reply.code(400).type('text/html').send(view.notice(view.t('error.signInExpiredTitle'), view.t('error.signInExpired')))
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)

      if (details.prompt.name === 'consent') {
        // There is no consent screen: every client is first-party. The library still asks for
        // consent when a client sends prompt=consent (which the OpenID spec prescribes together
        // with offline_access) or asks for more than the grant covers. Grant what is missing.
        const { Grant } = provider.current()
        const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] }
        const grant =
          (details.grantId && (await Grant.find(details.grantId))) ||
          new Grant({ accountId: details.session?.accountId, clientId: String(details.params.client_id) })
        if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
        if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)

        const grantId = await grant.save()
        reply.hijack()
        await provider
          .current()
          .interactionFinished(request.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true })
        return
      }

      if (details.prompt.name !== 'login') {
        request.log.warn({ prompt: details.prompt.name, reasons: details.prompt.reasons }, 'unsupported interaction prompt')
        const view = ui.pages.for(languageOf(request, details.params))
        return reply.code(400).type('text/html').send(view.notice(view.t('error.notSupportedTitle'), view.t('error.notSupported')))
      }

      const loginHint = details.params.login_hint
      // The application may suggest who is signing in (OpenID Connect `login_hint`).
      return reply.type('text/html').send(await loginPage(request, reply, details, { email: typeof loginHint === 'string' ? loginHint : '' }))
    })

    app.post<{ Params: { uid: string }; Body: { email?: unknown; password?: unknown } }>(
      '/interaction/:uid/login',
      async (request, reply) => {
        const details = await interactionFor(request, reply, request.params.uid)
        if (!details) return expired(request, reply)

        const { email, password } = request.body ?? {}
        const address = typeof email === 'string' ? email : ''
        const view = ui.pages.for(languageOf(request, details.params))

        // Before the password is looked at, so a blocked address learns nothing from a right or wrong guess.
        const wait = await limiter.passwordBlockedFor(address, request.ip)
        if (wait > 0) {
          await audit.blocked(originOf(request), { scope: 'password', email: address })
          return tooManyRequests(reply, view, wait)
        }

        const result: AuthResult =
          typeof email === 'string' && typeof password === 'string'
            ? await authenticate(email, password)
            : { ok: false, reason: 'wrong_password' }

        if (!result.ok) {
          await limiter.passwordFailed(address, request.ip)
          await audit.passwordFailed(originOf(request), { email: address, reason: result.reason, userId: result.userId })
          return reply
            .code(401)
            .type('text/html')
            .send(await loginPage(request, reply, details, { email: typeof email === 'string' ? email : '', error: view.t('login.wrong') }))
        }

        await limiter.passwordSucceeded(address, request.ip)
        return startSecondFactor(request, reply, details, result)
      },
    )

    const isRemembered = async (request: FastifyRequest, userId: string) =>
      Boolean(await findRememberedDevice(db, userId, deviceTokens(request.headers.cookie)))

    /** Ends the interaction with a successful login. */
    const finishLogin = async (
      request: FastifyRequest,
      reply: FastifyReply,
      accountId: string,
      assurance: { acr: string; amr: string[] },
      headers: string[] = [],
    ) => {
      if (headers.length > 0) reply.raw.setHeader('Set-Cookie', headers)
      reply.hijack()
      await provider
        .current()
        .interactionFinished(request.raw, reply.raw, { login: { accountId, ...assurance } }, { mergeWithLastSubmission: false })
    }

    /**
     * The step cookie, if it is valid, belongs to this interaction and the user can still sign in. `over` says
     * that their sessions were ended since the password was accepted: the step is then of no use any more.
     */
    const anyStepFor = async (request: FastifyRequest, uid: string) => {
      const step = unsign<Step>(cookieKeys, readCookie(request.headers.cookie, STEP_COOKIE))
      if (!step || step.uid !== uid || step.expiresAt < Date.now()) return undefined
      const user = await findActiveUserById(db, step.userId)
      return user ? { step, user, over: user.sessionEpoch !== step.epoch } : undefined
    }
    /** The step this request may go on with: as above, and not over. */
    const stepFor = async (request: FastifyRequest, uid: string) => {
      const current = await anyStepFor(request, uid)
      return current && !current.over ? current : undefined
    }
    /** Ends a step whose sign-in is over: recorded, the cookie removed, back to the start for the password as it is now. */
    const stepIsOver = async (request: FastifyRequest, reply: FastifyReply, uid: string, userId: string) => {
      await audit.codeFailed(originOf(request), { userId, purpose: 'login', reason: 'sessions_ended' })
      return reply.header('Set-Cookie', setCookieHeader(STEP_COOKIE, '', { path: cookiePath(uid), maxAgeSeconds: 0, secure })).redirect(cookiePath(uid), 303)
    }

    type StepUser = NonNullable<Awaited<ReturnType<typeof stepFor>>>['user']

    /** The code page, telling where the code that is valid now was sent. */
    const codePageFor = async (reply: FastifyReply, user: StepUser, uid: string, language: string, extra: { error?: string; notice?: string } = {}) => {
      const channel = (await currentCode(db, { userId: user.id, purpose: 'login' }))?.channel ?? 'email'
      // The script only finds out whether this device can make a passkey, for the offer after the code.
      passkeys.script.allow(reply)
      return ui.pages.for(language).code({
        passkeyProbe: { field: passkeys.script.capableField, script: passkeys.script.tag },
        uid,
        channel,
        sentTo: channel === 'sms' && user.phone ? maskPhone(user.phone) : maskEmail(user.email),
        canUseEmail: channel === 'sms',
        // Only worth saying when codes could go by SMS at all.
        phoneHint: !user.phone && notifier.smsAvailable,
        ...extra,
      })
    }

    /**
     * Sends a fresh code, by SMS if the user can receive one and `wanted` allows it. When the SMS cannot be
     * sent the same code goes by e-mail, so a provider outage does not lock people out. Returns the channel used.
     */
    const sendCode = async (user: StepUser, wanted: Channel): Promise<Channel> => {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: wanted, purpose: 'login' }, { secrets: codeSecrets })
      try {
        await notifier.sendLoginCode(user, { code, expiresAt, channel: wanted })
        return wanted
      } catch (error) {
        if (wanted !== 'sms' || !(error instanceof NotifierUnavailableError)) throw error
        app.log.warn(error, 'the sign-in code could not be sent by SMS; sent by e-mail instead')
        await changeCodeChannel(db, { userId: user.id, purpose: 'login', channel: 'email' })
        await notifier.sendLoginCode(user, { code, expiresAt, channel: 'email' })
        return 'email'
      }
    }

    const limitMessage = (view: PageSet, error: CodeLimitError) =>
      error.reason === 'cooldown'
        ? view.t('code.cooldown', { seconds: error.retryAfterSeconds })
        : view.t('code.tooMany', { minutes: Math.ceil(error.retryAfterSeconds / 60) })

    const cannotSend = (reply: FastifyReply, view: PageSet, error: NotifierUnavailableError) => {
      reply.log.error(error, 'the sign-in code could not be sent')
      return reply.code(503).type('text/html').send(view.notice(view.t('error.cannotSendTitle'), view.t('error.cannotSend')))
    }

    /** The password was right: send the code and ask for it. */
    const startSecondFactor = async (
      request: FastifyRequest,
      reply: FastifyReply,
      { uid, params }: { uid: string; params: Record<string, unknown> },
      { userId, sessionEpoch }: { userId: string; sessionEpoch: number },
    ) => {
      const acrValues = params.acr_values
      const user = await findActiveUserById(db, userId)
      if (!user) return expired(request, reply)
      // The sessions were ended in the moment since the password was checked: back to the start.
      if (user.sessionEpoch !== sessionEpoch) return reply.redirect(cookiePath(uid), 303)
      const language = languageOf(request, params, user.language)
      const view = ui.pages.for(language)

      // A remembered device skips the code, unless the application asks for the stronger
      // assurance: then the second factor is required whatever the browser remembers.
      const requested = typeof acrValues === 'string' ? acrValues.split(' ') : []
      // A device that an activation remembered left its token in a cookie of its own; it joins the others now.
      const adopted = adoptNewDevice(request.headers.cookie, secure)
      if (!requested.includes(ACR_SECOND_FACTOR) && (await isRemembered(request, user.id))) {
        await recordLogin(db, user.id)
        await audit.succeeded(originOf(request), { userId: user.id, method: 'remembered_device', acr: ACR_PASSWORD })
        return finishOrAskPhone(request, reply, uid, user, { acr: ACR_PASSWORD, amr: ['pwd'] }, language, adopted, sessionEpoch)
      }

      // The first code needs no limit per IP: it only goes out after the right password, and per user
      // a code can be sent once a minute. Only asking again is counted (see the resend route).
      try {
        const wanted = channelFor(user, notifier)
        const used = await sendCode(user, wanted)
        await audit.codeSent(originOf(request), { userId: user.id, purpose: 'login', channel: used, fellBack: used !== wanted })
      } catch (error) {
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, view, error)
        if (!(error instanceof CodeLimitError)) throw error
        // Not a fresh sign-in after all, but repeated requests: the code sent earlier still works.
        if (error.reason === 'too_many') {
          return reply.code(429).header('Retry-After', error.retryAfterSeconds).type('text/html').send(view.notice(view.t('code.tooManyTitle'), limitMessage(view, error)))
        }
        // A code went out a moment ago and still works.
      }

      const step: Step = { uid, userId, language, expiresAt: Date.now() + STEP_LIFETIME_SECONDS * 1000, epoch: sessionEpoch }
      reply.header('Set-Cookie', [setCookieHeader(STEP_COOKIE, sign(cookieKeys, step), { path: cookiePath(uid), maxAgeSeconds: STEP_LIFETIME_SECONDS, secure }), ...adopted])
      return reply.redirect(`${cookiePath(uid)}/code`, 303)
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      return reply.type('text/html').send(await codePageFor(reply, current.user, details.uid, current.step.language))
    })

    app.post<{ Params: { uid: string }; Body: { code?: unknown; remember?: unknown } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await anyStepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      const { user } = current
      // A code for a sign-in whose password was accepted before the person's sessions were ended.
      if (current.over) return stepIsOver(request, reply, details.uid, user.id)

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(originOf(request), { scope: 'code' })
        return tooManyRequests(reply, ui.pages.for(current.step.language), wait)
      }

      const code = typeof request.body?.code === 'string' ? request.body.code.replaceAll(' ', '') : ''
      // A person who enters the right code is who they say they are: the moment to offer a passkey, if this device
      // can make one and they were not asked here before.
      const offerWanted = passkeys.offers.wanted(request.headers.cookie, user.id, (request.body as { passkeys?: unknown } | undefined)?.passkeys)
      // It is also the moment to ask for a phone number that is not confirmed. That question comes first.
      const phoneWanted = phoneStepWanted(request, user)
      // The code is accepted and the offer opened in one transaction that holds the person's row, as ending their
      // sessions does. So there is no moment at which the code is used up and the offer not yet there to be ended:
      // an offer never rests on a code that was accepted before the sessions were ended.
      const accepted = await whileUserHeld(db, user.id, async (tx): Promise<{ over: true } | { over: false; result: Awaited<ReturnType<typeof checkCode>>; offerToken?: string }> => {
        // Asked again here, where it is certain: the sessions cannot be ended while this transaction holds the row.
        // If they were ended since the password was accepted, the code is not even looked at.
        if ((await sessionEpochOf(tx, user.id)) !== current.step.epoch) return { over: true }
        const result = /^\d{6}$/.test(code) ? await checkCode(tx, { userId: user.id, purpose: 'login', code }, { secrets: codeSecrets }) : ({ ok: false, reason: 'wrong' } as const)
        if (!result.ok || !(offerWanted || phoneWanted)) return { over: false, result }
        const offer: Offer = { ...secondFactorAssurance(result.channel), language: current.step.language, phone: phoneWanted, passkey: offerWanted }
        return { over: false, result, offerToken: await openPasskeyOffer(tx, { userId: user.id, boundTo: offerOf(details.uid), details: { ...offer } }, new Date(Date.now() + OFFER_LIFETIME_SECONDS * 1000)) }
      })

      // The sessions were ended between the look above and here: the same end.
      if (accepted.over) return stepIsOver(request, reply, details.uid, user.id)
      const { result, offerToken } = accepted
      if (!result.ok) {
        if (result.reason === 'wrong' || result.reason === 'exhausted') await limiter.codeFailed(request.ip)
        await audit.codeFailed(originOf(request), { userId: user.id, purpose: 'login', reason: result.reason })
        const error = ui.pages.for(current.step.language).t(`code.${result.reason}`)
        return reply.code(401).type('text/html').send(await codePageFor(reply, user, details.uid, current.step.language, { error }))
      }

      if (result.channel === 'email') await markEmailVerified(db, user.id)
      await recordLogin(db, user.id)

      const cookies = [setCookieHeader(STEP_COOKIE, '', { path: cookiePath(details.uid), maxAgeSeconds: 0, secure })]
      const tokens = deviceTokens(request.headers.cookie)
      // A browser that is already remembered for this person stays one device, however often they tick the box.
      const remember = request.body?.remember === 'on' && !(await findRememberedDevice(db, user.id, tokens))
      if (remember) {
        const { token } = await rememberDevice(db, { userId: user.id, userAgent: request.headers['user-agent'] })
        cookies.push(deviceCookie([...tokens, token], secure))
      }
      await audit.succeeded(originOf(request), {
        userId: user.id,
        method: 'code',
        channel: result.channel,
        acr: secondFactorAssurance(result.channel).acr,
        deviceRemembered: remember,
      })
      // With a question open, the sign-in waits for the answer to it.
      if (offerToken) {
        cookies.push(offerCookie(details.uid, offerToken))
        reply.header('Set-Cookie', cookies)
        return reply.redirect(phoneWanted ? phonePath(details.uid) : offerPath(details.uid), 303)
      }
      return finishLogin(request, reply, user.id, secondFactorAssurance(result.channel), cookies)
    })

    // --- Signing in with a passkey: one step, no password and no code

    app.post<{ Params: { uid: string }; Body: { credential?: unknown } }>('/interaction/:uid/passkey', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      if (details.prompt.name !== 'login') return reply.redirect(cookiePath(details.uid), 303)
      const view = ui.pages.for(languageOf(request, details.params))

      const wait = await limiter.passkeyBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(originOf(request), { scope: 'passkey' })
        return tooManyRequests(reply, view, wait)
      }
      // Says the same whatever was wrong, as a wrong password does.
      const refuse = async (reason: PasskeyFailure, userId?: string) => {
        await limiter.passkeyFailed(request.ip)
        await audit.passkeyFailed(originOf(request), { userId, reason })
        return reply.code(401).type('text/html').send(await loginPage(request, reply, details, { error: view.t('login.passkeyFailed') }))
      }

      let answer: unknown
      try {
        answer = JSON.parse(typeof request.body?.credential === 'string' ? request.body.credential : '')
      } catch {
        return refuse('malformed')
      }
      const { challenge, credentialId, userHandle } = namedBy(answer)
      if (!challenge || !credentialId) return refuse('malformed')

      // The question of this sign-in is used up by the first answer that names it, before the answer is looked
      // at. An answer that was given before, or to the question of another sign-in, finds nothing.
      if (!(await takePasskeyChallenge(db, { challenge, boundTo: `sign-in:${details.uid}` }))) return refuse('expired')

      const passkey = await findPasskeyByCredentialId(db, credentialId)
      if (!passkey) return refuse('unknown_passkey')
      // A person who is locked or deactivated signs in with nothing, also not with a passkey.
      const user = await findActiveUserById(db, passkey.userId)
      if (!user) return refuse('not_allowed', passkey.userId)
      if (userHandle && !isHandleOf(userHandle, user.id)) return refuse('wrong_person', user.id)
      const used = await passkeys.ceremonies.verifySignIn(answer, challenge, passkey)
      if (!used) return refuse('verification_failed', user.id)
      // Noted only if the passkey is still as it was checked: not removed meanwhile, its counter not moved on by
      // another sign-in that was checked against the same one. Otherwise nobody is signed in.
      if (!(await recordPasskeyUse(db, passkey, used))) return refuse('verification_failed', user.id)
      await recordLogin(db, user.id)
      await audit.succeeded(originOf(request), { userId: user.id, method: 'passkey', acr: passkeyAssurance.acr })
      // This browser has a passkey of this person: nothing to offer them here.
      return finishOrAskPhone(request, reply, details.uid, user, passkeyAssurance, languageOf(request, details.params, user.language), [passkeys.offers.answered(request.headers.cookie, user.id, 'done')])
    })

    // --- A sign-in that is complete and waits: for the phone number to be confirmed, then for the answer to the offer of a passkey

    const offerPath = (uid: string) => `${cookiePath(uid)}/passkey-offer`
    const phonePath = (uid: string) => `${cookiePath(uid)}/phone`
    const offerCookie = (uid: string, token: string) => setCookieHeader(OFFER_COOKIE, token, { path: cookiePath(uid), maxAgeSeconds: OFFER_LIFETIME_SECONDS, secure })
    const clearOffer = (uid: string) => setCookieHeader(OFFER_COOKIE, '', { path: cookiePath(uid), maxAgeSeconds: 0, secure })
    const tokenOf = (request: FastifyRequest) => readCookie(request.headers.cookie, OFFER_COOKIE) ?? ''
    const isOffer = (details: Record<string, unknown>): details is Record<string, unknown> & Offer =>
      typeof details.acr === 'string' && Array.isArray(details.amr) && details.amr.every((method) => typeof method === 'string') && typeof details.language === 'string'

    /**
     * The sign-in that waits: the token of this browser stands for one that is still open, was completed in this
     * interaction, and is of somebody who can still sign in. It is not open any more once it was finished, once
     * it ran out, and once the person's sessions were ended.
     */
    const waitingFor = async (request: FastifyRequest, uid: string) => {
      const open = await findPasskeyOffer(db, { token: tokenOf(request), boundTo: offerOf(uid) })
      if (!open || !isOffer(open.details)) return undefined
      const user = await findActiveUserById(db, open.userId)
      return user ? { uid, offer: open.details, user } : undefined
    }
    type Waiting = NonNullable<Awaited<ReturnType<typeof waitingFor>>>

    /** The sign-in that waits for the answer to the offer of a passkey: one that offers a passkey and has no question about the phone open. */
    const offerFor = async (request: FastifyRequest, uid: string) => {
      const waiting = await waitingFor(request, uid)
      return waiting && !waiting.offer.phone && waiting.offer.passkey !== false ? waiting : undefined
    }
    /** The sign-in that waits for the phone number to be confirmed, or for "not now". */
    const phoneFor = async (request: FastifyRequest, uid: string) => {
      const waiting = await waitingFor(request, uid)
      return waiting?.offer.phone ? waiting : undefined
    }

    /**
     * Ends a sign-in that is complete, or lets it wait while the person is asked to confirm their phone number.
     * For a sign-in that offers no passkey: with a remembered device, or with a passkey. With `epoch`, the
     * sign-in rests on a password: it waits only if the person's sessions were not ended since that was accepted,
     * asked where it is certain, as for a code.
     */
    const finishOrAskPhone = async (
      request: FastifyRequest,
      reply: FastifyReply,
      uid: string,
      user: StepUser,
      assurance: { acr: string; amr: string[] },
      language: string,
      cookies: string[],
      epoch?: number,
    ) => {
      if (!phoneStepWanted(request, user)) return finishLogin(request, reply, user.id, assurance, cookies)
      const offer: Offer = { ...assurance, language, phone: true, passkey: false }
      const token = await whileUserHeld(db, user.id, async (tx) =>
        epoch !== undefined && (await sessionEpochOf(tx, user.id)) !== epoch
          ? undefined
          : openPasskeyOffer(tx, { userId: user.id, boundTo: offerOf(uid), details: { ...offer } }, new Date(Date.now() + OFFER_LIFETIME_SECONDS * 1000)),
      )
      if (cookies.length > 0 || token) reply.header('Set-Cookie', [...cookies, ...(token ? [offerCookie(uid, token)] : [])])
      // The sessions were ended in the moment since the password was checked: back to the start.
      return reply.redirect(token ? phonePath(uid) : cookiePath(uid), 303)
    }

    const backToLogin = (reply: FastifyReply, uid: string) => reply.header('Set-Cookie', clearOffer(uid)).redirect(cookiePath(uid), 303)

    /** Ends the sign-in that waited, as the code had ended it without the offer. For the request that closed the offer, and no other. */
    const finishClosed = (request: FastifyRequest, reply: FastifyReply, { uid, user, offer }: Waiting, answer: 'later' | 'done') =>
      finishLogin(request, reply, user.id, { acr: offer.acr, amr: offer.amr }, [clearOffer(uid), passkeys.offers.answered(request.headers.cookie, user.id, answer)])

    /** Closes the offer and ends the sign-in. Only the request that closed it goes on: an offer finishes one sign-in, once. */
    const finishOffered = async (request: FastifyRequest, reply: FastifyReply, waiting: Waiting, answer: 'later' | 'done') => {
      const closed = await closePasskeyOffer(db, { token: tokenOf(request), boundTo: offerOf(waiting.uid) })
      return closed?.userId === waiting.user.id ? finishClosed(request, reply, waiting, answer) : backToLogin(reply, waiting.uid)
    }

    const offerPage = async (request: FastifyRequest, reply: FastifyReply, waiting: Waiting, error?: string) => {
      const options = await passkeys.enrolment.ask(waiting.user, offerOf(waiting.uid), OFFER_LIFETIME_SECONDS)
      // Somebody with as many passkeys as an account may have is not offered another: on they go.
      if (!options) return finishOffered(request, reply, waiting, 'done')
      passkeys.script.allow(reply)
      const view = ui.pages.for(waiting.offer.language)
      return reply
        .code(error ? 422 : 200)
        .type('text/html')
        .send(view.passkeyOffer({ action: offerPath(waiting.uid), skipAction: `${offerPath(waiting.uid)}/skip`, attributes: passkeys.script.createAttributes(options), script: passkeys.script.tag, error }))
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid/passkey-offer', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const waiting = await offerFor(request, details.uid)
      if (!waiting) return reply.redirect(cookiePath(details.uid), 303)
      return offerPage(request, reply, waiting)
    })

    app.post<{ Params: { uid: string }; Body: { credential?: unknown } }>('/interaction/:uid/passkey-offer', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const waiting = await offerFor(request, details.uid)
      if (!waiting) return reply.redirect(cookiePath(details.uid), 303)

      // The offer is closed in the transaction that stores the passkey, with the person's row locked. Ending their
      // sessions locks the same row: it has either ended the offer by then, and nothing is stored, or it comes after.
      const outcome = await passkeys.enrolment.complete(request, waiting.user, offerOf(details.uid), request.body?.credential, async (tx) => {
        const closed = await closePasskeyOffer(tx, { token: tokenOf(request), boundTo: offerOf(details.uid) })
        return closed?.userId === waiting.user.id
      })
      // The offer was over before the passkey could be stored: answered by another request, or ended with the sessions.
      if (outcome === 'revoked') return backToLogin(reply, details.uid)
      // Made, or there already: the offer is closed, and this browser has nothing more to be offered.
      if (outcome === 'added' || outcome === 'duplicate' || outcome === 'too-many') return finishClosed(request, reply, waiting, 'done')
      // Not made, and the offer is as it was. The person is signed in all the same: they try again, or go on with "not now".
      return offerPage(request, reply, waiting, ui.pages.for(waiting.offer.language).t('passkeyOffer.failed'))
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/passkey-offer/skip', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const waiting = await offerFor(request, details.uid)
      if (!waiting) return reply.redirect(cookiePath(details.uid), 303)
      return finishOffered(request, reply, waiting, 'later')
    })

    // --- Confirming the phone number, between a complete sign-in and the way back to the application
    //
    // For a person whose number the back office entered or changed and who has not confirmed it: their codes come
    // by e-mail until they do, and most never open the account pages. Nothing is sent unless they ask for it, as
    // a message costs money, and "not now" is an answer: the sign-in goes on either way.

    /**
     * The phone question is answered: on to the offer of a passkey if this sign-in has one, else back to the
     * application. Only the request that closes the waiting sign-in ends it, as with the offer.
     */
    const afterPhone = async (request: FastifyRequest, reply: FastifyReply, { uid, user, offer }: Waiting, cookies: string[] = []) => {
      const waiting = { token: tokenOf(request), boundTo: offerOf(uid) }
      if (offer.passkey) {
        const continued = await continuePasskeyOffer(db, waiting, { details: { phone: false }, expiresAt: new Date(Date.now() + OFFER_LIFETIME_SECONDS * 1000) })
        if (!continued) return backToLogin(reply, uid)
        return reply.header('Set-Cookie', [offerCookie(uid, waiting.token), ...cookies]).redirect(offerPath(uid), 303)
      }
      const closed = await closePasskeyOffer(db, waiting)
      if (closed?.userId !== user.id) return backToLogin(reply, uid)
      return finishLogin(request, reply, user.id, { acr: offer.acr, amr: offer.amr }, [clearOffer(uid), ...cookies])
    }

    /**
     * The page says what is true: a field for the code only while there is one that can still be entered.
     * Otherwise it offers to send one, also after the back office changed the number, which ends the code that
     * was out (`updateUser`). With the field it names no number: a code that was issued for the old number in
     * the moment of the change is still out, and went there.
     */
    const phonePage = async (reply: FastifyReply, { uid, user, offer }: Waiting & { user: { phone: string } }, { status = 200, error, notice }: { status?: number; error?: string; notice?: string } = {}) => {
      const codeSent = (await currentCode(db, { userId: user.id, purpose: 'activation' }))?.usable === true
      return reply
        .code(status)
        .type('text/html')
        .send(ui.pages.for(offer.language).phoneStep({ action: phonePath(uid), sentTo: maskPhone(user.phone), codeSent, error, notice }))
    }

    /**
     * A limit per IP says "not now" to a code. The step stays, with how long to wait: a notice alone would be a
     * dead end for somebody whose sign-in is complete, and "not now" must still take them to their application.
     * Many people can sit behind one address, so the first click of one of them can meet the limit.
     */
    const phoneLimited = async (request: FastifyRequest, reply: FastifyReply, waiting: Parameters<typeof phonePage>[1], waitSeconds: number) => {
      await audit.blocked(originOf(request), { scope: 'phone_code' })
      reply.header('Retry-After', waitSeconds)
      return phonePage(reply, waiting, { status: 429, error: limitText(ui.pages.for(waiting.offer.language), waitSeconds) })
    }

    /**
     * What every request of the phone step begins with: the sign-in that waits for it, and a number that can
     * still be confirmed. Without the first the person starts again; without the second there is nothing to ask,
     * and the sign-in goes on. Returns the reply in both cases.
     */
    const phoneStepOf = async (request: FastifyRequest<{ Params: { uid: string } }>, reply: FastifyReply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return { stop: expired(request, reply) }
      const waiting = await phoneFor(request, details.uid)
      if (!waiting) return { stop: reply.redirect(cookiePath(details.uid), 303) }
      const { user } = waiting
      // Confirmed in another window, or the number was taken away meanwhile.
      if (!canConfirmPhone(user, notifier)) return { stop: afterPhone(request, reply, waiting) }
      return { waiting: { ...waiting, user } }
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid/phone', async (request, reply) => {
      const { waiting, stop } = await phoneStepOf(request, reply)
      return waiting ? phonePage(reply, waiting) : stop
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/phone/send', async (request, reply) => {
      const { waiting, stop } = await phoneStepOf(request, reply)
      if (!waiting) return stop
      const { user } = waiting
      const view = ui.pages.for(waiting.offer.language)

      const sendWait = await limiter.codeResend(request.ip)
      if (sendWait > 0) return phoneLimited(request, reply, waiting, sendWait)
      try {
        // Bound to the number it goes to, the one this request read: it confirms that number and no other.
        const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: user.phone }, { secrets: codeSecrets })
        await notifier.sendPhoneCode(user, { code, expiresAt })
        await audit.codeSent(originOf(request), { userId: user.id, purpose: 'activation', channel: 'sms' })
      } catch (error) {
        if (error instanceof CodeLimitError) {
          reply.header('Retry-After', error.retryAfterSeconds)
          return phonePage(reply, waiting, { status: 429, error: limitMessage(view, error) })
        }
        if (!(error instanceof NotifierUnavailableError)) throw error
        request.log.error(error, 'the code to confirm the phone number could not be sent')
        // Nobody is waiting for that code: the page offers to send one again instead of asking for it.
        await withdrawCode(db, { userId: user.id, purpose: 'activation' })
        return phonePage(reply, waiting, { status: 503, error: view.t('account.phone.unavailable') })
      }
      return phonePage(reply, waiting, { notice: view.t('code.newOnItsWay') })
    })

    app.post<{ Params: { uid: string }; Body: { code?: unknown } }>('/interaction/:uid/phone/confirm', async (request, reply) => {
      const { waiting, stop } = await phoneStepOf(request, reply)
      if (!waiting) return stop
      const { user } = waiting
      const view = ui.pages.for(waiting.offer.language)

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) return phoneLimited(request, reply, waiting, wait)
      const code = typeof request.body?.code === 'string' ? request.body.code : ''
      // The check of the code and the confirmation are one step, for the person as they are at that moment.
      const result = await confirmPhone(db, { actor: { type: 'user', id: user.id }, ...originOf(request), self: true }, { userId: user.id, code }, { secrets: codeSecrets }).catch((error: unknown) => {
        // Nothing to confirm any more: confirmed in another window, or the person was locked meanwhile.
        if (error instanceof LifecycleError) return 'nothing' as const
        throw error
      })
      if (result !== 'nothing' && !result?.ok) {
        await limiter.codeFailed(request.ip)
        await audit.codeFailed(originOf(request), { userId: user.id, purpose: 'activation', reason: result?.reason ?? 'none' })
        return phonePage(reply, waiting, { status: 401, error: view.t('code.badOrExpired') })
      }
      return afterPhone(request, reply, waiting)
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/phone/skip', async (request, reply) => {
      const { waiting, stop } = await phoneStepOf(request, reply)
      if (!waiting) return stop
      // Not asked again in this browser for a while, about this number.
      return afterPhone(request, reply, waiting, [phoneReminder.later(request.headers.cookie, waiting.user)])
    })

    app.post<{ Params: { uid: string }; Body: { channel?: unknown } }>('/interaction/:uid/code/resend', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)

      const sendWait = await limiter.codeResend(request.ip)
      if (sendWait > 0) {
        await audit.blocked(originOf(request), { scope: 'code_resend' })
        return tooManyRequests(reply, ui.pages.for(current.step.language), sendWait)
      }

      // "Send it by e-mail instead" asks for the e-mail even where an SMS would be the usual way.
      const wanted = request.body?.channel === 'email' ? 'email' : channelFor(current.user, notifier)
      try {
        const used = await sendCode(current.user, wanted)
        await audit.codeSent(originOf(request), { userId: current.user.id, purpose: 'login', channel: used, fellBack: used !== wanted })
      } catch (error) {
        const view = ui.pages.for(current.step.language)
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, view, error)
        if (!(error instanceof CodeLimitError)) throw error
        return reply
          .code(429)
          .header('Retry-After', error.retryAfterSeconds)
          .type('text/html')
          .send(await codePageFor(reply, current.user, details.uid, current.step.language, { error: limitMessage(view, error) }))
      }
      return reply
        .type('text/html')
        .send(await codePageFor(reply, current.user, details.uid, current.step.language, { notice: ui.pages.for(current.step.language).t('code.newOnItsWay') }))
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/abort', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)

      reply.hijack()
      await provider
        .current()
        .interactionFinished(
          request.raw,
          reply.raw,
          { error: 'access_denied', error_description: 'The user cancelled the sign-in.' },
          { mergeWithLastSubmission: false },
        )
    })
  }
