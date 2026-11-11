import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeNext } from '../../frontend/lib/safe-next'

const O = 'https://hyperprox.example'

test('login next= only ever lands on this origin', () => {
  for (const raw of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', '/\n/evil.example',
    'javascript:alert(1)', '', null, 'relative', '/login', '/login?next=/x']) {
    assert.equal(safeNext(raw as any, O), '/', String(raw))
  }
  assert.equal(safeNext('/infrastructure?node=a#x', O), '/infrastructure?node=a#x')
  assert.equal(safeNext('/', O), '/')
})
