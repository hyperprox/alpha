// No import cycle among auto-connect, Homepage and Nextcloud. Auto-connect drives the other two; they reach its
// dismissal record through a port the composition root gives them (lib/services/bootstrap.ts), never by importing it.
// Type-only and lazy (import('...')) imports count: a lazy one is still a dependency at run time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cyclesAmong } from './fakes/import-graph'

test('no import cycle among lib/auto-connect, lib/homepage and lib/nextcloud', () => {
  const cycles = cyclesAmong(['lib/auto-connect', 'lib/homepage', 'lib/nextcloud'])
  assert.deepEqual(cycles, [], `import cycles:\n${cycles.map(c => `  ${c.join(' ↔ ')}`).join('\n')}`)
})

test('the finder is not vacuous: it reports a lazy cycle and a type-only one, and ignores a commented import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-cycles-'))
  try {
    fs.mkdirSync(path.join(dir, 'x'))
    fs.writeFileSync(path.join(dir, 'x', 'a.ts'), "import type { B } from './b'\nexport type A = B\n")
    fs.writeFileSync(path.join(dir, 'x', 'b.ts'), "// import { A } from './a' (a comment is not an edge)\nexport type B = string\nexport const c = () => import('./c')\n")
    fs.writeFileSync(path.join(dir, 'x', 'c.ts'), "import { c } from './b'\nexport { c }\n")
    fs.writeFileSync(path.join(dir, 'x', 'd.ts'), "import type { E } from './e'\nexport type D = E | 1\n")
    fs.writeFileSync(path.join(dir, 'x', 'e.ts'), "import type { D } from './d'\nexport type E = { d?: D }\n")
    const found = cyclesAmong(['x'], dir).map(c => c.join(' ')).sort()
    assert.deepEqual(found, ['x/b.ts x/c.ts', 'x/d.ts x/e.ts'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
