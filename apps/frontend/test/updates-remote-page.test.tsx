// The Updates page on a remote cluster: every part that works there is offered (compose discovery included),
// HyperProx's own update and plug-in app updates are left off (they are about this install, not the cluster), and
// "Add node login" goes to the remote server's own logins, not home's checklist. No control on it can only answer
// "home cluster only".
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/updates-remote-page.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { updatesPageParts } from '../lib/updates-cluster'
import { NODE_LOGIN_HREF } from '../lib/node-login'
import { NodeLoginAction } from '../components/vault/NodeLoginAction'

test('home: everything, the self-update included', () => {
  assert.deepEqual(updatesPageParts({ id: 'home', kind: 'home' }), { selfUpdate: true, apps: true, discoverCompose: true, nodeLoginHref: NODE_LOGIN_HREF })
})

test('remote: compose discovery offered; self-update and plug-in apps hidden; logins under Edit server', () => {
  const p = updatesPageParts({ id: 'c0123456789', kind: 'remote' })
  assert.equal(p.discoverCompose, true)
  assert.equal(p.selfUpdate, false)
  assert.equal(p.apps, false)
  assert.equal(p.nodeLoginHref, '/clusters/c0123456789?tab=settings')
})

test('Add node login goes where it is given', () => {
  assert.match(renderToStaticMarkup(<NodeLoginAction />), new RegExp(`href="${NODE_LOGIN_HREF}"`))
  assert.match(renderToStaticMarkup(<NodeLoginAction href="/clusters/c0123456789?tab=settings" />), /href="\/clusters\/c0123456789\?tab=settings"/)
})

test('the page draws the self-update, the apps count and the discovery button from those parts only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/updates/page.tsx'), 'utf8')
  assert.match(src, /\{parts\.selfUpdate && <SelfUpdatePanel \/>\}/)
  assert.equal((src.match(/<SelfUpdatePanel/g) ?? []).length, 1, 'no other way onto the page')
  assert.match(src, /parts\.apps \? \[\{ label: 'Apps with updates'/)
  assert.match(src, /\{parts\.discoverCompose && \(/)
  assert.match(src, /<NodeLoginAction small href=\{parts\.nodeLoginHref\} \/>/)
  assert.ok(!/home cluster only/i.test(src), 'nothing on the page says "home cluster only"')
})
