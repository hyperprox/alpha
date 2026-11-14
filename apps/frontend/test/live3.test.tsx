// Round-3 live findings: the master-password prompt above every dialog, the row menu placed inside the window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { placeMenu } from '../lib/popover'

const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('the master-password prompt is drawn above any other dialog, app-wide', () => {
  const ui = src('components/vault/ui.tsx')
  assert.match(ui, /export const Z_RECONFIRM = 70/)
  assert.match(ui, /top && typeof document !== 'undefined' \? createPortal\(frame, document\.body\)/)
  assert.match(src('components/vault/ReconfirmModal.tsx'), /<Modal title="Confirm it's you" onClose=\{onClose\} top>/)
  // Nothing else on the pages that pair a dialog with the prompt sits at or above it.
  for (const f of ['app/settings/users/page.tsx', 'app/settings/secrets/page.tsx', 'components/guest-config/GuestDrawer.tsx', 'app/dns/page.tsx']) {
    const s = src(f)
    assert.doesNotMatch(s, /z-\[(7\d|[89]\d|\d{3,})\]|zIndex:\s*(7\d|[89]\d|\d{3,})/, f)
  }
})

test('the row menu opens below its button, flips above near the bottom, and stays inside the window', () => {
  const view = { width: 1000, height: 800 }
  const btn = (top: number, right = 990) => ({ top, bottom: top + 32, left: right - 32, right, width: 32, height: 32 })
  const below = placeMenu(btn(100), { width: 200, height: 240 }, view)
  assert.equal(below.above, false); assert.equal(below.top, 136); assert.equal(below.left, 790)
  const flipped = placeMenu(btn(700), { width: 200, height: 240 }, view)
  assert.equal(flipped.above, true); assert.equal(flipped.top, 700 - 4 - 240)
  const narrow = placeMenu(btn(100, 40), { width: 200, height: 240 }, { width: 390, height: 800 })
  assert.equal(narrow.left, 8, 'never off the left edge')
})

test('sign-in, owner creation and join scroll on a small phone: the stage scrolls, the card is never pushed out of reach', () => {
  const css = src('app/login/login.module.css')
  const stage = /\.stage \{([^}]*)\}/.exec(css)![1]
  assert.match(stage, /height: 100dvh/)
  assert.match(stage, /overflow-y: auto/)
  assert.doesNotMatch(stage, /align-items: center/, 'a centred card taller than the screen loses its top')
  assert.match(/\.card \{([^}]*)\}/.exec(css)![1], /margin: auto/)
  assert.ok(src('app/join/page.tsx').includes("import s from '../login/login.module.css'"), 'join uses the same stage')
})
