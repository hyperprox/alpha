// When Remote access's list of guests to leave alone cannot be read, the Updates page says so at the top, in plain
// words, and the daily check panel does not call the result "nothing to update".
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/updates-notice.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckPanel } from '../components/updates/ClusterBits'

const NOTICE = "HyperProx could not read Remote access's list of guests to leave alone, so it did not look inside any guest this time."

test('the page draws the inventory notice as a warning above the daily check, and does not claim "Everything is current"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/updates/page.tsx'), 'utf8')
  assert.match(src, /\{inv\?\.notice && <Notice tone="warn">\{inv\.notice\}<\/Notice>\}/)
  assert.ok(src.indexOf('inv?.notice &&') < src.indexOf('<CheckPanel'), 'above the daily check')
  assert.match(src, /inv\?\.notice && base\.text === UP_TO_DATE_TEXT \? \{ text: 'Not every guest could be read'/)
})

test('the daily check panel shows the notice instead of "nothing to update"', () => {
  const status: any = {
    running: false, nextRun: null, lastNotified: null, manualAfter: null, blocked: null,
    clusters: [{ cluster: { id: 'home', name: 'Home', kind: 'home' }, at: '2026-11-16T06:30:00Z', result: 'partial', targets: [], unread: [], available: 0, packages: 0, security: 0, notice: NOTICE }],
  }
  const html = renderToStaticMarkup(<CheckPanel status={status} error={null} busy={false} onCheck={() => {}} current="home" />)
  assert.match(html, /could not read Remote access&#x27;s list of guests to leave alone|could not read Remote access's list of guests to leave alone/)
  assert.ok(!/nothing to update/.test(html))
})
