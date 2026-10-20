import { describe, expect, it } from 'vitest'
import { createImportStore, IMPORT_TTL_MS, type ImportSettings } from './import-store.js'

const settings: ImportSettings = { encoding: 'utf-8', valueSeparator: ';', ignoreUnknownColumns: false, missing: 'ignore', allowDelete: false, maxMissingPercent: 20 }
const upload = (userId: string) => ({ userId, bytes: new Uint8Array([1, 2, 3]), settings })

describe('the uploads of the administrators', () => {
  it('keeps an upload for 30 minutes, for the person who made it only', () => {
    let time = 0
    const store = createImportStore({ now: () => time })
    const token = store.put(upload('ada'))

    expect(store.get(token, 'ada')?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(store.get(token, 'ben')).toBeUndefined()
    expect(store.get('another', 'ada')).toBeUndefined()

    time = IMPORT_TTL_MS - 1
    expect(store.get(token, 'ada')).toBeDefined()
    time = IMPORT_TTL_MS
    expect(store.get(token, 'ada')).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  it('keeps one upload per person: a new one replaces the old one', () => {
    const store = createImportStore()
    const first = store.put(upload('ada'))
    const second = store.put(upload('ada'))
    const other = store.put(upload('ben'))

    expect(first).not.toBe(second)
    expect(store.get(first, 'ada')).toBeUndefined()
    expect(store.get(second, 'ada')).toBeDefined()
    expect(store.get(other, 'ben')).toBeDefined()
    expect(store.size()).toBe(2)
  })

  it('lets go of the file when it is imported, and keeps the rejected rows to download', () => {
    const store = createImportStore()
    const token = store.put(upload('ada'))

    store.release(token)
    store.setRejectedCsv(token, 'a,b')

    expect(store.get(token, 'ada')).toMatchObject({ bytes: undefined, rejectedCsv: 'a,b' })
  })

  it('names uploads with tokens that cannot be guessed', () => {
    const store = createImportStore()
    const tokens = new Set(Array.from({ length: 50 }, (_, n) => store.put(upload(`user${n}`))))

    expect(tokens.size).toBe(50)
    expect([...tokens].every((token) => token.length >= 32)).toBe(true)
  })
})
