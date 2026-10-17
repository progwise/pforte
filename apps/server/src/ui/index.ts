import { createI18n, type I18nOptions } from '../i18n/index.js'
import { createPages, type PagesOptions } from './pages.js'
import { defaultTheme } from './theme.js'

export interface UiOptions extends I18nOptions, PagesOptions {}


/** The languages and the pages that are rendered in them. */
export const createUi = (options: UiOptions = {}) => {
  const i18n = createI18n(options)
  const theme = options.theme ?? defaultTheme()
  return { i18n, theme, pages: createPages(i18n, { ...options, theme }) }
}

export type Ui = ReturnType<typeof createUi>
