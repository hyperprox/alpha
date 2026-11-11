// The API compiles a copy of the shared plug-in visual types (its rootDir cannot include packages/types).
// This keeps the copy honest: any drift from @hyperprox/types fails here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('lib/plugin-visual-types.ts is a verbatim copy of packages/types/src/plugin-visual.ts', () => {
  const shared = fs.readFileSync(path.resolve(__dirname, '../../../packages/types/src/plugin-visual.ts'), 'utf8')
  const local = fs.readFileSync(path.resolve(__dirname, '../src/lib/plugin-visual-types.ts'), 'utf8')
  const marker = '// --- verbatim copy below ---\n'
  assert.ok(local.includes(marker))
  assert.equal(local.slice(local.indexOf(marker) + marker.length), shared)
})
