// The daily check panel and the Command center say honestly how old a skipped check's numbers are, and say
// "checking again" once the job is over.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckPanel } from '../components/updates/ClusterBits'

const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
const row = (extra: object) => ({ cluster: { id: 'home', name: 'Home', kind: 'home' }, at: new Date().toISOString(), result: 'skipped', reason: 'an Updates job is running', lastOkAt: old, targets: [], unread: [], available: 10, packages: 176, security: 4, ...extra })
const panel = (r: any) => renderToStaticMarkup(<CheckPanel status={{ running: false, lastRun: null, nextRun: null, lastNotified: null, clusters: [r] } as any} error={null} busy={false} onCheck={() => {}} current="home" />)

test('a skipped check says when the last full check was', () => {
  const html = panel(row({}))
  assert.match(html, /Last full check 3 days ago/)
  assert.ok(!/checking again/i.test(html))
})

test('once the job is over the line says it is checking again', () => {
  const html = panel(row({ recheck: true }))
  assert.match(html, /Checking again now that the update finished/)
  assert.match(html, /3 days ago/)
  assert.ok(!/Not checked/.test(html))
})
