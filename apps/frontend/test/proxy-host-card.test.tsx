// Proxy host cards: provider, state (off hosts included), certificate days, "+N more", and the actions by role.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { HostCard, hostActionRequest, type HostView } from '../components/proxy/HostCard'

const host = (o: Partial<HostView> = {}): HostView => ({
  id: '7', instanceId: 'inst-1', instanceName: 'edge', kind: 'caddy', domains: ['app.example.org', 'www.example.org', 'm.example.org'],
  forwardScheme: 'http', forwardHost: '10.0.0.5', forwardPort: 8080, enabled: true, readOnly: false,
  tls: { kind: 'certificate', expiresAt: new Date(Date.now() + 20 * 86_400_000 + 3_600_000).toISOString() }, online: true, ...o,
})
const html = (h: HostView, admin: boolean) => renderToStaticMarkup(<HostCard h={h} admin={admin} onEdit={() => {}} onAction={() => {}} />)

test('the card shows provider, +N more, certificate days left and the flow', () => {
  const out = html(host(), true)
  assert.match(out, />Caddy</)
  assert.match(out, /\+2 more/)
  assert.match(out, /TLS 20d left/)
  assert.match(out, />20d</)
  assert.match(out, /http:\/\/10\.0\.0\.5:8080/)
  assert.match(out, />live</)
})

test('an off host is still a card, marked off', () => {
  const out = html(host({ enabled: false }), true)
  assert.match(out, />off</)
  assert.match(out, /data-enabled="false"/)
  assert.match(out, /aria-label="Turn on app\.example\.org"/)
})

test('admins get Edit, On/Off and Delete; viewers and read-only hosts get none', () => {
  const admin = html(host(), true)
  for (const l of ['Edit app.example.org', 'Turn off app.example.org', 'Delete app.example.org']) assert.ok(admin.includes(`aria-label="${l}"`), l)
  assert.ok(!/<button/.test(html(host(), false)), 'viewer')
  const ro = html(host({ readOnly: true }), true)
  assert.ok(!/<button/.test(ro)); assert.match(ro, /read-only/)
})

// The card is a function component without hooks, so its element tree can be walked and a click simulated.
function buttons(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => buttons(n, out)); return out }
  if (node.type === 'button') out.push(node)
  buttons(node.props?.children, out)
  return out
}
test('Edit opens the editor for that host; On/Off and Delete ask for a preview', () => {
  const calls: any[] = []
  const h = host()
  const tree = (HostCard as any)({ h, admin: true, onEdit: (x: any) => calls.push(['edit', x.id]), onAction: (x: any, a: string) => calls.push([a, x.id]) })
  const byLabel = (l: string) => buttons(tree).find(b => b.props['aria-label'] === l)
  byLabel('Edit app.example.org').props.onClick()
  byLabel('Turn off app.example.org').props.onClick()
  byLabel('Delete app.example.org').props.onClick()
  assert.deepEqual(calls, [['edit', '7'], ['disable', '7'], ['delete', '7']])
})

test('the preview request is the one the table sent', () => {
  const r = hostActionRequest({ id: '7', instanceId: 'inst-1' }, 'enable')
  assert.equal(r.url, '/api/proxy/instances/inst-1/preview')
  assert.equal(r.init.method, 'POST')
  assert.deepEqual(JSON.parse(r.init.body as string), { action: 'enable', hostId: '7' })
})
