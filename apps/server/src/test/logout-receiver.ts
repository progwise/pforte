import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** An application's logout address: keeps what it was sent and answers as it is told to. */
export const createReceiver = async () => {
  const requests: { path: string; logoutToken: string }[] = []
  const state = {
    /** The status of the next answers, in order; 200 once they are used up. */
    answers: [] as number[],
    /** While set, answers wait for it: an application that is slow. */
    hold: undefined as Promise<void> | undefined,
  }
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      requests.push({ path: request.url ?? '', logoutToken: new URLSearchParams(body).get('logout_token') ?? '' })
      const status = state.answers.shift() ?? 200
      await state.hold
      response.writeHead(status).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    requests,
    state,
    address: (path: string) => `http://127.0.0.1:${port}${path}`,
    to: (path: string) => requests.filter((request) => request.path === path),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
