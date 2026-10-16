import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Authenticate } from '../auth/authenticate.js'
import { applyIssuerHeaders } from '../oidc/issuer-headers.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { contentSecurityPolicy, errorPage, loginPage } from './templates.js'

export interface InteractionDependencies {
  provider: Pick<ProviderHolder, 'current' | 'issuer'>
  authenticate: Authenticate
}

const GENERIC_LOGIN_ERROR = 'The e-mail or password is not correct.'

/** The login pages the provider redirects to ("interactions"). */
export const interactionRoutes =
  ({ provider, authenticate }: InteractionDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)

    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Security-Policy', contentSecurityPolicy)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'no-referrer')
    })

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

    const expired = (reply: FastifyReply) =>
      reply
        .code(400)
        .type('text/html')
        .send(errorPage('Sign-in expired', 'This sign-in request has expired. Please go back to the application and start again.'))

    app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)
      if (details.prompt.name !== 'login') {
        return reply.code(400).type('text/html').send(errorPage('Not supported', 'This request cannot be completed.'))
      }

      const client = await provider.current().Client.find(String(details.params.client_id))
      return reply
        .type('text/html')
        .send(loginPage({ uid: details.uid, clientName: client?.clientName }))
    })

    app.post<{ Params: { uid: string }; Body: { email?: unknown; password?: unknown } }>(
      '/interaction/:uid/login',
      async (request, reply) => {
        const details = await interactionFor(request, reply, request.params.uid)
        if (!details) return expired(reply)

        const { email, password } = request.body ?? {}
        const result =
          typeof email === 'string' && typeof password === 'string' ? await authenticate(email, password) : undefined

        if (!result) {
          const client = await provider.current().Client.find(String(details.params.client_id))
          return reply
            .code(401)
            .type('text/html')
            .send(
              loginPage({
                uid: details.uid,
                clientName: client?.clientName,
                email: typeof email === 'string' ? email : '',
                error: GENERIC_LOGIN_ERROR,
              }),
            )
        }

        reply.hijack()
        await provider
          .current()
          .interactionFinished(
            request.raw,
            reply.raw,
            { login: { accountId: result.userId } },
            { mergeWithLastSubmission: false },
          )
      },
    )

    app.post<{ Params: { uid: string } }>('/interaction/:uid/abort', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)

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
