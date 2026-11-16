// lib/shell.ts: one quoting rule. The Nextcloud builders used to validate and then wrap WITHOUT escaping; they now
// validate and escape. For every value their patterns allow the two are the same string, because no pattern allows a quote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { shq, shqStrict, shqWord } from '../src/lib/shell'
import { PATH_RE, NAME_RE, IMAGE_RE, IMAGE_ID_RE, composeCmd } from '../src/lib/nextcloud/update'
import { TOKEN_RE, CONTAINER_RE, OCC_PATH_RE, UNIX_USER_RE } from '../src/lib/nextcloud/occ'

test('shq: any string round-trips through a real shell, quotes included', () => {
  for (const s of ["plain", "it's", "a b", "$(rm -rf /)", "`x`", "a\nb", "''", "'", "\\", '"q"', '', '*', ';|&<>']) {
    assert.equal(execFileSync('bash', ['-c', `printf %s ${shq(s)}`]).toString(), s)
  }
  assert.equal(shq("it's"), `'it'\\''s'`)
  assert.equal(shq('a'), "'a'")
})

test('shqStrict: validate, then quote; the refusal is the caller\'s', () => {
  assert.equal(shqStrict('abc', /^[a-z]+$/), "'abc'")
  assert.throws(() => shqStrict('ab c', /^[a-z]+$/), /cannot be put/)
  assert.throws(() => shqStrict(null, /^.*$/), /cannot be put/)
  class Mine extends Error {}
  assert.throws(() => shqStrict('X', /^[a-z]+$/, () => new Mine('nope')), Mine)
})

test('shqWord: bare when plainly safe, quoted otherwise', () => {
  assert.equal(shqWord('/opt/nc-1/x.yml'), '/opt/nc-1/x.yml')
  assert.equal(shqWord('repo/img:tag@sha'), 'repo/img:tag@sha')
  assert.equal(shqWord('has space'), "'has space'")
  assert.equal(shqWord("a'b"), `'a'\\''b'`)
  assert.equal(shqWord('$x'), "'$x'")
  assert.equal(shqWord(''), "''")
})

// Which characters can a pattern accept, in any position it has? Probe every code point 0..0x2ff in the contexts the
// patterns use (start, middle, end, after a slash, after "sha256:"), and keep what is accepted anywhere.
function accepted(re: RegExp): string[] {
  const ctx = (c: string) => [c, `a${c}`, `a${c}a`, `/${c}`, `/a/${c}`, `/a/${c}/occ`, `/${c}/occ`, `${c}a`, `sha256:${c}`, `a/${c}`, `${'0'.repeat(63)}${c}`, `sha256:${'0'.repeat(63)}${c}`]
  const out = new Set<string>()
  for (let i = 0; i < 0x300; i++) {
    const c = String.fromCharCode(i)
    if (ctx(c).some(s => re.test(s))) out.add(c)
  }
  return [...out]
}

const PATTERNS: Array<[string, RegExp]> = [
  ['PATH_RE', PATH_RE], ['NAME_RE', NAME_RE], ['IMAGE_RE', IMAGE_RE], ['IMAGE_ID_RE', IMAGE_ID_RE],
  ['service', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/], ['project', /^[a-z0-9][a-z0-9_-]{0,62}$/],
  ['TOKEN_RE', TOKEN_RE], ['CONTAINER_RE', CONTAINER_RE], ['OCC_PATH_RE', OCC_PATH_RE], ['UNIX_USER_RE', UNIX_USER_RE],
]

test('no pattern the Nextcloud builders validate with accepts a quote, so validate-then-escape is validate-then-wrap', () => {
  for (const [name, re] of PATTERNS) {
    const alphabet = accepted(re)
    assert.ok(alphabet.length > 5, `${name}: probe found no alphabet`)
    assert.ok(!alphabet.includes("'"), `${name} accepts a quote`)
    // every accepted character quotes to itself inside the quotes
    for (const c of alphabet) assert.equal(shq(c), `'${c}'`, `${name}: ${JSON.stringify(c)}`)
  }
})

test('whole values: identical output to the old wrap, over each allowed alphabet', () => {
  for (const [name, re] of PATTERNS) {
    const alphabet = accepted(re)
    let n = 0
    for (let k = 0; k < 400; k++) {
      // a deterministic pseudo-random string from the alphabet, kept when the pattern accepts it whole
      let v = '', x = k * 2654435761 >>> 0
      const len = 1 + (k % 24)
      for (let j = 0; j < len; j++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; v += alphabet[x % alphabet.length] }
      if (!re.test(v)) continue
      n++
      assert.equal(shqStrict(v, re), `'${v}'`, name)
    }
    if (name !== 'IMAGE_ID_RE' && name !== 'OCC_PATH_RE') assert.ok(n > 3, `${name}: only ${n} whole values were accepted`)
  }
})

test('structured values: an image id and an occ path', () => {
  assert.equal(shqStrict('/var/www/html/occ', OCC_PATH_RE), "'/var/www/html/occ'")
  const id = `sha256:${'ab12'.repeat(16)}`
  assert.equal(shqStrict(id, IMAGE_ID_RE), `'${id}'`)
})

test('composeCmd output is unchanged for ordinary values and still refuses odd ones', () => {
  assert.equal(composeCmd({ workdir: '/opt/nextcloud', configFile: '/opt/nextcloud/docker-compose.yml', project: 'nextcloud' }),
    "docker compose --project-directory '/opt/nextcloud' -f '/opt/nextcloud/docker-compose.yml' -p 'nextcloud'")
  for (const bad of ["/opt/nc'x", '/opt/../etc', '/opt/a b', '/opt/$(x)']) {
    assert.throws(() => composeCmd({ workdir: bad, configFile: '/opt/x.yml', project: 'nc' }), /will not use that directory/)
  }
  assert.throws(() => composeCmd({ workdir: null, configFile: '/opt/x.yml', project: 'nc' }), /will not use that directory/)
})
