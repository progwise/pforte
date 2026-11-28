import multipart from '@fastify/multipart'
import { removePicture, type RequestContext, setPicture } from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { MAX_UPLOAD_BYTES, PictureError, preparePicture } from '../pictures/prepare.js'
import { allowPictures, pictureElement } from '../pictures/show.js'
import { escapeHtml } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'
import { ACCOUNT_PATH } from './constants.js'
import type { AccountContext } from './routes.js'
import type { AccountUser } from './session.js'

export const PICTURE = `${ACCOUNT_PATH}/picture`

const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024
const FIELD = 'picture'

/**
 * A person gives themselves a picture, replaces it or removes it. Applications they sign in to get its address
 * as the claim `picture` and show it next to their name.
 *
 * It is theirs alone to set: no source the users are synced from has it, and nobody else can put one in. An
 * administrator can remove it (`DELETE /admin/users/{id}/picture`), for the picture that should not be there.
 *
 * What is uploaded is not what is stored. `preparePicture` reads it and writes a small square JPEG anew, and only
 * that is kept and served: see there for what that leaves behind. A file that is no picture, or too large, changes
 * nothing.
 *
 * Both changes need a recent sign-in, as every change on these pages does, and uploading is limited per person:
 * making a picture is work for the server.
 */
export const registerPicturePages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, ui, gate, viewFor, page, redirectWith, requireRecentSignIn, limiter, audit } = ctx

  const where = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({ actor: { type: 'user', id: user.id }, ...where(request), self: true })

  app.get(PICTURE, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    // The file is chosen after the new sign-in, not before it: what was chosen would be lost on the way.
    if (!requireRecentSignIn(reply, session, PICTURE)) return reply
    const { t } = viewFor(request, user)

    const content = `<h1>${escapeHtml(t('account.picture.title'))}</h1>
<div class="panel">
${user.pictureKey ? `<p>${pictureElement(user.pictureKey, t('account.picture.current'))}</p>` : ''}
<p>${escapeHtml(t('account.picture.help', { size: MAX_UPLOAD_MEGABYTES }))}</p>
<p class="muted">${escapeHtml(t('account.picture.address'))}</p>
<form method="post" enctype="multipart/form-data" action="${PICTURE}">
<label for="${FIELD}">${escapeHtml(t('account.picture.file'))}</label>
<input id="${FIELD}" name="${FIELD}" type="file" accept="image/jpeg,image/png,image/webp" required>
<div class="actions">
<button type="submit">${escapeHtml(t('account.picture.save'))}</button>
<a class="button secondary" href="${ACCOUNT_PATH}">${escapeHtml(t('common.cancel'))}</a>
</div>
</form>
${user.pictureKey ? `<form class="below" method="post" action="${PICTURE}/remove"><button type="submit" class="secondary">${escapeHtml(t('account.picture.remove'))}</button></form>` : ''}
</div>`
    allowPictures(reply, ui.pages.contentSecurityPolicy)
    return reply.type('text/html').send(page(request, reply, user, 'start', t('account.picture.title'), content))
  })

  // @fastify/multipart is only for the upload: the other pages of the area take no files.
  void app.register(async (scope) => {
    await scope.register(multipart, { throwFileSizeLimit: true, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 } })

    /** The file of the form, or why there is none: nothing was chosen, or it is larger than a picture may be. */
    const uploadOf = async (request: FastifyRequest) => {
      try {
        const file = request.isMultipart() ? await request.file() : undefined
        const bytes = file?.fieldname === FIELD ? await file.toBuffer() : undefined
        return bytes && bytes.length > 0 ? bytes : ('missing' as const)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'FST_REQ_FILE_TOO_LARGE') return 'tooLarge' as const
        // More than the one file, or fields the form does not have: not what this page sent.
        if (typeof code === 'string' && code.startsWith('FST_')) return 'missing' as const
        throw error
      }
    }

    scope.post(PICTURE, async (request, reply) => {
      const signedIn = await gate.requireAccountSession(request, reply)
      if (!signedIn) return reply
      const { user, session } = signedIn
      if (!requireRecentSignIn(reply, session, PICTURE)) return reply
      const refused = (reason: 'missing' | 'tooLarge' | 'unreadable') => redirectWith(reply, PICTURE, { kind: 'error', key: `account.picture.${reason}`, values: { size: MAX_UPLOAD_MEGABYTES } })

      const upload = await uploadOf(request)
      if (typeof upload === 'string') return refused(upload)

      // Counted before the picture is made: that is the work the limit is for.
      const wait = await limiter.pictureUpload(user.id)
      if (wait > 0) {
        await audit.blocked(where(request), { scope: 'picture' })
        return tooManyRequests(reply, viewFor(request, user).view, wait)
      }
      let image: Buffer
      try {
        image = await preparePicture(upload)
      } catch (error) {
        if (error instanceof PictureError) return refused('unreadable')
        throw error
      }
      await setPicture(db, selfContext(request, user), { userId: user.id, image })
      return redirectWith(reply, ACCOUNT_PATH, { kind: 'ok', key: 'account.picture.saved' })
    })
  })

  app.post(`${PICTURE}/remove`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PICTURE)) return reply
    // Nothing to remove is no error: the picture is gone, which is what was asked for.
    await removePicture(db, selfContext(request, user), user.id)
    return redirectWith(reply, ACCOUNT_PATH, { kind: 'ok', key: 'account.picture.removed' })
  })
}
