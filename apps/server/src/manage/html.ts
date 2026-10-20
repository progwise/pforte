import { escapeHtml } from '../ui/pages.js'

/** Small pieces of markup for the administration's pages. Everything that comes from outside is escaped here. */

export const field = (options: {
  id: string
  name?: string
  label: string
  value?: string | null
  type?: 'text' | 'email' | 'tel' | 'search' | 'date'
  /** The id of a `<datalist>` with suggestions. */
  list?: string
  hint?: string
  error?: string
  required?: boolean
  maxLength?: number
}) => {
  const { id, name = id, label, value = '', type = 'text', list, hint, error, required, maxLength } = options
  return `<div>
<label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<input id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value ?? '')}"${list ? ` list="${escapeHtml(list)}"` : ''}${required ? ' required' : ''}${maxLength ? ` maxlength="${maxLength}"` : ''}${error ? ' aria-invalid="true"' : ''}>
${hint ? `<small class="muted">${escapeHtml(hint)}</small>` : ''}${error ? `<small class="field-error">${escapeHtml(error)}</small>` : ''}
</div>`
}

export const select = (options: {
  id: string
  name?: string
  label: string
  value?: string
  choices: { value: string; label: string }[]
}) => {
  const { id, name = id, label, value = '', choices } = options
  return `<div>
<label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<select id="${escapeHtml(id)}" name="${escapeHtml(name)}">
${choices.map((choice) => `<option value="${escapeHtml(choice.value)}"${choice.value === value ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`).join('\n')}
</select>
</div>`
}

export const checkbox = (options: { id: string; name?: string; label: string; checked?: boolean }) =>
  `<div><label class="check" for="${escapeHtml(options.id)}"><input id="${escapeHtml(options.id)}" name="${escapeHtml(options.name ?? options.id)}" type="checkbox"${options.checked ? ' checked' : ''}> ${escapeHtml(options.label)}</label></div>`

export const badge = (kind: string, label: string) => `<span class="badge ${escapeHtml(kind)}">${escapeHtml(label)}</span>`

export const link = (href: string, label: string, className = '') =>
  `<a${className ? ` class="${className}"` : ''} href="${escapeHtml(href)}">${escapeHtml(label)}</a>`

export const textarea = (options: { id: string; name?: string; label: string; value?: string; hint?: string; error?: string; rows?: number }) => {
  const { id, name = id, label, value = '', hint, error, rows = 3 } = options
  return `<div>
<label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<textarea id="${escapeHtml(id)}" name="${escapeHtml(name)}" rows="${rows}"${error ? ' aria-invalid="true"' : ''}>${escapeHtml(value)}</textarea>
${hint ? `<small class="muted">${escapeHtml(hint)}</small>` : ''}${error ? `<small class="field-error">${escapeHtml(error)}</small>` : ''}
</div>`
}

/** A group of tick boxes under one name, such as the scopes of a client. */
export const checks = (options: {
  legend: string
  name: string
  hint?: string
  error?: string
  choices: { value: string; label: string; checked?: boolean; disabled?: boolean }[]
}) => `<fieldset class="group">
<legend>${escapeHtml(options.legend)}</legend>
${options.choices
  .map(
    (choice) =>
      `<label class="check"><input type="checkbox" name="${escapeHtml(options.name)}" value="${escapeHtml(choice.value)}"${choice.checked ? ' checked' : ''}${choice.disabled ? ' disabled' : ''}> ${escapeHtml(choice.label)}</label>`,
  )
  .join('\n')}
${options.hint ? `<small class="muted">${escapeHtml(options.hint)}</small>` : ''}${options.error ? `<small class="field-error">${escapeHtml(options.error)}</small>` : ''}
</fieldset>`
