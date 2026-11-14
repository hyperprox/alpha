// Phone width (390 px) and a 1440x900 window: titles and chips break between words, the VPN table stacks into
// cards with each provider named, and a menu with more below the fold says so.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { navHasMoreBelow } from '../lib/nav-scroll'

const css = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const rule = (text: string, sel: string) => (new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(text)?.[2] ?? '')

test('page titles, HUD titles and pills never break inside a word ("DASHB/OARD", "CONTAIN/ER")', () => {
  const shell = css('components/layout/shell.module.css')
  const kit = css('components/visual/visual.module.css')
  assert.doesNotMatch(rule(shell, '.title'), /overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(rule(kit, '.hudTitle'), /overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(kit, /\.pill \{[^}]*overflow-wrap:\s*anywhere/)
  // On a phone the title row is the crumb and title alone, and the crumb is not cut to "OVERV…".
  const phone = shell.slice(shell.indexOf('@media (max-width: 560px)'))
  assert.match(phone, /\.titleBlock \{ flex: 1 1 100%; \}/)
  assert.match(phone, /\.crumb \{ white-space: normal;/)
})

test('the dashboard ring keeps its size on a phone, so its words fit inside the inner ring', () => {
  const kit = css('components/visual/visual.module.css')
  const phone = kit.slice(kit.indexOf('/* ── phone ── */'))
  assert.match(phone, /\.core \{ width: 170px; height: 170px; \}/)
})

test('a menu with more below the fold is told apart from one that fits', () => {
  assert.equal(navHasMoreBelow({ scrollHeight: 900, scrollTop: 0, clientHeight: 700 }), true)
  assert.equal(navHasMoreBelow({ scrollHeight: 900, scrollTop: 200, clientHeight: 700 }), false)
  assert.equal(navHasMoreBelow({ scrollHeight: 700, scrollTop: 0, clientHeight: 698 }), false, 'a pixel or two is not more')
})
