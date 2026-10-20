import { describe, expect, it, vi } from 'vitest'
import { createBackground } from './background.js'

describe('work after the response', () => {
  it('runs the task without being waited for, and idle waits for it', async () => {
    const background = createBackground({ onError: () => {} })
    const events: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))

    background.run(async () => {
      await held
      events.push('done')
    })
    events.push('answered')
    expect(events).toEqual(['answered'])

    release()
    await background.idle()
    expect(events).toEqual(['answered', 'done'])
  })

  it('reports a failure to onError and goes on, so one failed task does not stop the next', async () => {
    const onError = vi.fn()
    const background = createBackground({ onError })
    const ran: number[] = []

    background.run(async () => {
      throw new Error('mail server is down')
    })
    background.run(async () => void ran.push(2))
    await background.idle()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'mail server is down' }))
    expect(ran).toEqual([2])
  })

  it('also waits for tasks started while it waits', async () => {
    const background = createBackground({ onError: () => {} })
    const ran: string[] = []
    background.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      ran.push('first')
      background.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        ran.push('second')
      })
    })
    await background.idle()
    expect(ran).toEqual(['first', 'second'])
  })

  it('is idle at once when nothing was started', async () => {
    await createBackground({ onError: () => {} }).idle()
  })
})
