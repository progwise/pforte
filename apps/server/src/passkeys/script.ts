import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ui } from '../ui/index.js'
import { escapeHtml } from '../ui/pages.js'
import type { PasskeyCreationOptions } from './ceremonies.js'

/**
 * The one script pforte's pages have: the browser half of a passkey. WebAuthn can only be reached from script,
 * so this is it, and it does nothing else.
 *
 * It talks to nobody. What the device is to be asked comes with the page, in an attribute of the form; the answer
 * goes into a hidden field of that form, and the form is sent as any other. So the page needs no permission to
 * make requests of its own, and the check that a form comes from pforte's own page covers this one too.
 *
 * A page that uses it works without it: the button stays disabled and the page says that this browser cannot do
 * it. Written for browsers as they are, not for a build step: no dependency, no module, nothing to compile.
 */
const SOURCE = String.raw`(function () {
  'use strict'

  var supported = typeof window.PublicKeyCredential === 'function' && !!navigator.credentials && typeof navigator.credentials.create === 'function'

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

  // Newer browsers read and write the JSON form themselves. The rest is for those that do not.
  var creationOptions = function (json) {
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') return PublicKeyCredential.parseCreationOptionsFromJSON(json)
    var options = Object.assign({}, json)
    options.challenge = toBuffer(json.challenge)
    options.user = Object.assign({}, json.user, { id: toBuffer(json.user.id) })
    options.excludeCredentials = (json.excludeCredentials || []).map(function (credential) {
      return Object.assign({}, credential, { id: toBuffer(credential.id) })
    })
    return options
  }
  var created = function (credential) {
    if (typeof credential.toJSON === 'function') return credential.toJSON()
    var response = credential.response
    return {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toText(response.clientDataJSON),
        attestationObject: toText(response.attestationObject),
        transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
    }
  }

  var show = function (form, name) {
    var messages = form.querySelectorAll('[data-passkey-message]')
    for (var i = 0; i < messages.length; i++) messages[i].hidden = messages[i].getAttribute('data-passkey-message') !== name
  }

  var forms = document.querySelectorAll('form[data-passkey="create"]')
  for (var i = 0; i < forms.length; i++) {
    (function (form) {
      var button = form.querySelector('button[type="submit"]')
      var field = form.querySelector('input[name="credential"]')
      if (!supported || !button || !field) return
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
            field.value = JSON.stringify(created(credential))
            form.submit()
          })
          .catch(function (error) {
            // The device says "invalid state" when it holds a passkey of this person already. Everything else
            // is the person saying no, or the device giving up.
            show(form, error && error.name === 'InvalidStateError' ? 'exists' : 'failed')
            button.disabled = false
          })
      })
    })(forms[i])
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
