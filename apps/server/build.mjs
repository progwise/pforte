// Bundles pforte's own code (the server and the packages of this repository) into one file, dist/pforte.mjs.
// Third-party packages stay outside and are installed next to it, from the lockfile: some are native (argon2)
// and the others read files of their own.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { dependencies } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const thirdParty = Object.keys(dependencies).filter((name) => !name.startsWith('@progwise/'))

const result = await build({
  entryPoints: ['src/entry.ts'],
  outfile: 'dist/pforte.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: thirdParty,
  sourcemap: 'linked',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
})

// The bundle may only reach for packages that are declared as dependencies of the server: those are what the image installs.
const imported = new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith('node:'))
    .map((entry) => (entry.path.startsWith('@') ? entry.path.split('/').slice(0, 2).join('/') : entry.path.split('/')[0])),
)
const undeclared = [...imported].filter((name) => !thirdParty.includes(name))
if (undeclared.length > 0) {
  console.error(`dist/pforte.mjs imports ${undeclared.join(', ')}, which apps/server/package.json does not list as a dependency. The image would lack it.`)
  process.exit(1)
}
console.log(`Built dist/pforte.mjs (${imported.size} packages stay external)`)
