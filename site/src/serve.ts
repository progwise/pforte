// Serves the built site on http://localhost:4000 to look at it. Not part of the site.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' }

createServer((request, response) => {
  const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '')
  let file = join(root, path)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  const found = existsSync(file)
  response.writeHead(found ? 200 : 404, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  response.end(readFileSync(found ? file : join(root, '404.html')))
}).listen(Number(process.env.PORT ?? 4000), () => console.log('Serving the site on http://localhost:4000'))
