// The public demo build has no /api rewrite: its front server answers /api itself, so a path the frontend
// receives can never be passed on to an API port of its own. The local demo (scripts/demo.sh) and real builds keep it.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/demo-rewrites.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const load = () => {
  const file = path.join(__dirname, '..', 'next.config.js')
  delete require.cache[require.resolve(file)]
  return require(file)
}

test('public demo build: no rewrites at all', async () => {
  process.env.HYPERPROX_DEMO_PUBLIC = '1'
  try { assert.deepEqual(await load().rewrites(), []) } finally { delete process.env.HYPERPROX_DEMO_PUBLIC }
})

test('every other build: /api goes to the API port', async () => {
  const r = await load().rewrites()
  assert.equal(r.length, 1)
  assert.equal(r[0].source, '/api/:path*')
})
