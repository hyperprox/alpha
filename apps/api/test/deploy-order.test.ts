// deploy.sh: nothing that can still fail (typecheck, API build, frontend build, the static-asset check) runs
// after the live database is migrated. A failed build must leave the database as the running API expects it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const lines = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'deploy.sh'), 'utf8').split('\n')
const at = (re: RegExp): number => {
  const i = lines.findIndex(l => !l.trim().startsWith('#') && re.test(l))
  assert.ok(i >= 0, `deploy.sh has no line matching ${re}`)
  return i
}

test('deploy.sh builds and checks everything before it migrates the database, and migrates before it restarts', () => {
  const generate = at(/prisma generate/)
  const tsc = at(/npx tsc -p tsconfig\.json/)
  const next = at(/npx next build/)
  const staticCheck = at(/Static assets were not copied/)
  const migrate = at(/prisma migrate deploy/)
  const restart = at(/systemctl restart hyperprox-api/)
  assert.ok(generate < tsc, 'the Prisma client is generated before the API is compiled against it')
  for (const [name, i] of [['the API build', tsc], ['the frontend build', next], ['the static-asset check', staticCheck]] as const) {
    assert.ok(i < migrate, `${name} (line ${i + 1}) runs before prisma migrate deploy (line ${migrate + 1})`)
  }
  assert.ok(migrate < restart, 'the database is migrated before the new API starts')
  assert.equal(lines.filter(l => !l.trim().startsWith('#') && /prisma migrate deploy/.test(l)).length, 1)
  assert.ok(lines.some(l => /^set -euo pipefail/.test(l)), 'any failing step stops the deploy')
})
