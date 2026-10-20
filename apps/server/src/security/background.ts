/**
 * Work that goes on after a response was sent. A password reset request answers at once, whether or not the
 * address has an account, and only then looks the account up and sends the mail, so that how long the answer takes
 * says nothing about the account. A failure cannot be told to the person any more, so it goes to `onError`.
 */
export interface Background {
  run(task: () => Promise<void>): void
  /** Resolves when everything started so far has finished: before shutting down, and in tests. */
  idle(): Promise<void>
}

export const createBackground = ({ onError }: { onError: (error: unknown) => void }): Background => {
  const pending = new Set<Promise<void>>()
  return {
    run(task) {
      const running: Promise<void> = task()
        .catch(onError)
        .finally(() => pending.delete(running))
      pending.add(running)
    },
    async idle() {
      while (pending.size > 0) await Promise.all(pending)
    },
  }
}
