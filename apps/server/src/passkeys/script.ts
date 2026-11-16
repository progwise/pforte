import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ui } from '../ui/index.js'
import { escapeHtml } from '../ui/pages.js'
import type { PasskeyCreationOptions, PasskeyRequestOptions } from './ceremonies.js'

/**
 * The one script pforte's pages have: the browser half of a passkey. WebAuthn can only be reached from script,
 * so this is it, and it does nothing else.
 *
 * It talks to nobody. What the device is to be asked comes with the page, in an attribute of the form; the answer
 * goes into a hidden field of that form, and the form is sent as any other. So the page needs no permission to
 * make requests of its own, and the check that a form comes from pforte's own page covers this one too.
 *
 * A page that uses it works without it. Where a passkey is made, the button stays disabled and the page says that
 * this browser cannot do it. Where somebody signs in, the passkey button stays hidden and the page is the one for
 * e-mail address and password. Written for browsers as they are, not for a build step: no dependency, no module,
 * nothing to compile.
 */
const SOURCE = String.raw`(function () {
  'use strict'

  var supported = typeof window.PublicKeyCredential === 'function' && !!navigator.credentials && typeof navigator.credentials.create === 'function' && typeof navigator.credentials.get === 'function'
  if (!supported) return

  var toBuffer = function (text) {
    var binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
  var toText = function (buffer) {
    var bytes = new Uint8Array(buffer)
    var binary = ''
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  var withBufferIds = function (credentials) {
    return (credentials || []).map(function (credential) {
      return Object.assign({}, credential, { id: toBuffer(credential.id) })
    })
  }

  // Newer browsers read and write the JSON form themselves. The rest is for those that do not.
  var creationOptions = function (json) {
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') return PublicKeyCredential.parseCreationOptionsFromJSON(json)
    var options = Object.assign({}, json)
    options.challenge = toBuffer(json.challenge)
    options.user = Object.assign({}, json.user, { id: toBuffer(json.user.id) })
    options.excludeCredentials = withBufferIds(json.excludeCredentials)
    return options
  }
  var requestOptions = function (json) {
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') return PublicKeyCredential.parseRequestOptionsFromJSON(json)
    var options = Object.assign({}, json)
    options.challenge = toBuffer(json.challenge)
    options.allowCredentials = withBufferIds(json.allowCredentials)
    return options
  }
  var answerOf = function (credential) {
    if (typeof credential.toJSON === 'function') return credential.toJSON()
    var response = credential.response
    var answer = {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      response: { clientDataJSON: toText(response.clientDataJSON) },
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
    }
    if (response.attestationObject) {
      // A new passkey.
      answer.response.attestationObject = toText(response.attestationObject)
      answer.response.transports = typeof response.getTransports === 'function' ? response.getTransports() : []
    } else {
      // A sign-in.
      answer.response.authenticatorData = toText(response.authenticatorData)
      answer.response.signature = toText(response.signature)
      if (response.userHandle) answer.response.userHandle = toText(response.userHandle)
    }
    return answer
  }

  var show = function (form, name) {
    var messages = form.querySelectorAll('[data-passkey-message]')
    for (var i = 0; i < messages.length; i++) messages[i].hidden = messages[i].getAttribute('data-passkey-message') !== name
  }
  var each = function (selector, use) {
    var found = document.querySelectorAll(selector)
    for (var i = 0; i < found.length; i++) use(found[i])
  }
  var send = function (form, field, credential) {
    field.value = JSON.stringify(answerOf(credential))
    form.submit()
  }

  // A form that makes a passkey: the button asks the device, the answer goes into the hidden field.
  each('form[data-passkey="create"]', function (form) {
    var button = form.querySelector('button[type="submit"]')
    var field = form.querySelector('input[name="credential"]')
    if (!button || !field) return
    show(form, '')
    button.disabled = false

    form.addEventListener('submit', function (event) {
      // The second time round the answer is in the field, and the form goes to pforte.
      if (field.value) return
      event.preventDefault()
      button.disabled = true
      show(form, '')
      navigator.credentials
        .create({ publicKey: creationOptions(JSON.parse(form.getAttribute('data-options'))) })
        .then(function (credential) {
          send(form, field, credential)
        })
        .catch(function (error) {
          // The device says "invalid state" when it holds a passkey of this person already. Everything else
          // is the person saying no, or the device giving up.
          show(form, error && error.name === 'InvalidStateError' ? 'exists' : 'failed')
          button.disabled = false
        })
    })
  })

  // A form that signs in with a passkey. It is hidden until here: a browser without passkeys never sees it.
  // The device is asked in two ways with the same question: through the browser's autofill of the e-mail
  // field, which waits quietly until the person picks a passkey there, and through the button.
  each('form[data-passkey="get"]', function (form) {
    var button = form.querySelector('button[type="submit"]')
    var field = form.querySelector('input[name="credential"]')
    if (!button || !field) return
    var json = JSON.parse(form.getAttribute('data-options'))
    var waiting = null
    // True from a click on the button until the device has answered it. The quiet question never starts then.
    var asked = false

    var ask = function (quietly) {
      if (waiting) waiting.abort()
      waiting = typeof AbortController === 'function' ? new AbortController() : null
      var request = { publicKey: requestOptions(json) }
      if (quietly) request.mediation = 'conditional'
      if (waiting) request.signal = waiting.signal
      return navigator.credentials.get(request).then(function (credential) {
        send(form, field, credential)
      })
    }
    var askQuietly = function () {
      if (typeof PublicKeyCredential.isConditionalMediationAvailable !== 'function') return
      PublicKeyCredential.isConditionalMediationAvailable()
        .then(function (available) {
          // The browser may take its time to say whether it has an autofill for passkeys. If the person has
          // clicked the button meanwhile, their request is under way, and starting the quiet one would cancel it.
          // Otherwise it ends without a word when the button takes over, or when the person never picks a passkey.
          if (available && !asked) ask(true).catch(function () {})
        })
        .catch(function () {})
    }

    form.hidden = false
    askQuietly()

    form.addEventListener('submit', function (event) {
      if (field.value) return
      event.preventDefault()
      button.disabled = true
      show(form, '')
      asked = true
      ask(false).catch(function () {
        asked = false
        show(form, 'failed')
        button.disabled = false
        askQuietly()
      })
    })
  })

  // A field that tells pforte whether this device can check its person itself, so that a passkey is offered
  // only where one can be made.
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then(function (available) {
        if (available) each('input[data-passkey-capable]', function (input) { input.value = '1' })
      })
      .catch(function () {})
  }
})()
`

/**
 * Serves the script and names it to the pages that need it. Its address contains a hash of its content, so the
 * answer for an address never changes, and the policy of a page that runs it allows that one address and no other.
 */
export const createPasskeyScript = ({ issuer, ui }: { issuer: string; ui: Pick<Ui, 'pages'> }) => {
  const path = `/assets/passkey-${createHash('sha256').update(SOURCE).digest('hex').slice(0, 16)}.js`
  const policy = `${ui.pages.contentSecurityPolicy}; script-src ${new URL(issuer).origin}${path}`

  return {
    path,
    source: SOURCE,
    /** The policy of a page that runs the script: the one of every page, and this one file. */
    policy,
    /** Makes this answer a page that may run the script. Every other page keeps the policy without any script. */
    allow: (reply: FastifyReply) => reply.header('Content-Security-Policy', policy),
    /** The element that loads it, for the end of such a page. */
    tag: `<script src="${path}" defer></script>`,
    /** The form attributes the script looks for when a passkey is to be created. */
    createAttributes: (options: PasskeyCreationOptions) => `data-passkey="create" data-options="${escapeHtml(JSON.stringify(options))}"`,
    /** The form attributes the script looks for when somebody is to sign in with a passkey. The form starts hidden. */
    requestAttributes: (options: PasskeyRequestOptions) => `data-passkey="get" data-options="${escapeHtml(JSON.stringify(options))}" hidden`,
    /** A field of a form that says `1` when the device can make a passkey, and nothing without the script. */
    capableField: '<input type="hidden" name="passkeys" value="" data-passkey-capable>',
    routes: async (app: FastifyInstance) => {
      app.get(path, async (_request, reply) =>
        reply
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .type('text/javascript; charset=utf-8')
          .send(SOURCE),
      )
    },
  }
}

export type PasskeyScript = ReturnType<typeof createPasskeyScript>
