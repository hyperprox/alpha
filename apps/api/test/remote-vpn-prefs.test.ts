// VPN per-machine settings: what is read back from the client, what each choice means in words, what a node
// may never do, and the exact flags sent. Pure, plus the real readback filter run on a realistic prefs dump.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  TS_PREFS_READBACK, parseTailscalePrefs, configureScript, loginScript, parseLoginUrl, parseStatus, NB_FLAGS_READBACK,
} from '../src/lib/remote/scripts'
import { checkPrefs, describePrefs, clientFlags, DEFAULT_PREFS, type VpnPrefs } from '../src/lib/remote/planner'
import { redactKnownKeyShapes } from '../src/lib/remote/redact'
import type { Machine } from '../src/lib/remote/types'

const node: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const ct: Machine = { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true }

const PREFS_DUMP = [
  '{', '\t"ControlURL": "https://controlplane.tailscale.com",', '\t"RouteAll": true,', '\t"ExitNodeID": "",', '\t"ExitNodeIP": "100.64.0.9",',
  '\t"ExitNodeAllowLANAccess": true,', '\t"CorpDNS": false,', '\t"RunSSH": true,', '\t"WantRunning": true,', '\t"AdvertiseTags": [', '\t\t"tag:server"', '\t],',
  '\t"AdvertiseRoutes": [', '\t\t"198.51.100.0/24",', '\t\t"0.0.0.0/0",', '\t\t"::/0"', '\t],', '\t"NetfilterMode": 2,', '\t"AutoUpdate": {', '\t\t"Check": true', '\t},',
  '\t"Config": {', '\t\t"PrivateNodeKey": "privkey:4f00ba11deadbeef",', '\t\t"UserProfile": {', '\t\t\t"LoginName": "someone@example.com"', '\t\t},',
  '\t\t"NetworkLockKey": "nlpriv:0000feed"', '\t}', '}',
].join('\n')

test('the prefs readback prints only the settings it needs: never the node key or the login', () => {
  const out = execFileSync('bash', ['-c', `tailscale() { cat <<'X'\n${PREFS_DUMP}\nX\n}; ${TS_PREFS_READBACK}`]).toString()
  assert.doesNotMatch(out, /privkey|nlpriv|someone@example\.com|ControlURL|AutoUpdate/)
  const p = parseTailscalePrefs(out)
  assert.deepEqual(p, {
    acceptDns: false, acceptRoutes: true, ssh: true, advertiseExitNode: true, exitNode: '100.64.0.9', exitNodeAllowLan: true,
    subnets: ['198.51.100.0/24'], tags: ['tag:server'], netfilterOff: false, netfilterMode: 2,
  })
  assert.equal(parseTailscalePrefs('garbage'), null)
})

test('key material is redacted from any log by shape too', () => {
  assert.equal(redactKnownKeyShapes('PrivateNodeKey privkey:4f00ba11deadbeef and nlpriv:0000feed'), 'PrivateNodeKey [redacted] and [redacted]')
  assert.equal(redactKnownKeyShapes('visit https://login.tailscale.com/a/1a2b3c4d5e then'), 'visit [redacted] then')
  assert.equal(redactKnownKeyShapes('{"AuthURL":"https://idp.example.com/device?code=XYZ"}'), '{"AuthURL":"[redacted]"}')
})

test('a node is locked: no DNS, no accepted routes, no SSH, never an exit node or using one', () => {
  for (const [k, v] of [['acceptDns', true], ['acceptRoutes', true], ['ssh', true], ['advertiseExitNode', true], ['exitNode', '100.64.0.9']] as const) {
    const r = checkPrefs(node, 'tailscale', { ...DEFAULT_PREFS, [k]: v })
    assert.ok(r, `${k} must be refused on a node`)
    assert.match(r!, /node/)
  }
  assert.equal(checkPrefs(node, 'tailscale', DEFAULT_PREFS), null)
})

test('a guest may change each setting; using and offering an exit node at once is refused; bad exit nodes are refused', () => {
  assert.equal(checkPrefs(ct, 'tailscale', { ...DEFAULT_PREFS, acceptDns: true, acceptRoutes: true, ssh: true, exitNode: '100.64.0.9', exitNodeAllowLan: true }), null)
  assert.match(checkPrefs(ct, 'tailscale', { ...DEFAULT_PREFS, advertiseExitNode: true, exitNode: '100.64.0.9' }) ?? '', /both/)
  assert.match(checkPrefs(ct, 'tailscale', { ...DEFAULT_PREFS, exitNode: '$(reboot)' }) ?? '', /exit node/)
  assert.match(checkPrefs(ct, 'netbird', { ...DEFAULT_PREFS, exitNode: 'abc;rm' }) ?? '', /exit node/)
})

test('every change is explained in words, saying what it does to that machine', () => {
  const to: VpnPrefs = { ...DEFAULT_PREFS, acceptDns: true, ssh: true, exitNode: '100.64.0.9', exitNodeAllowLan: true }
  const words = describePrefs(ct, 'tailscale', DEFAULT_PREFS, to).join(' ')
  assert.match(words, /resolv|DNS/); assert.match(words, /MagicDNS/)
  assert.match(words, /SSH/); assert.match(words, /internet traffic.*100\.64\.0\.9/); assert.match(words, /LAN/)
  assert.deepEqual(describePrefs(ct, 'tailscale', DEFAULT_PREFS, DEFAULT_PREFS), [])
})

test('the configure script: Tailscale sets exactly these flags and reads them back', () => {
  const s = configureScript('tailscale', { ...DEFAULT_PREFS, acceptDns: true, ssh: true, exitNode: '100.64.0.9', exitNodeAllowLan: true, acceptRoutes: false }, [])
  assert.match(s, /tailscale set '--accept-dns=true' '--accept-routes=false' '--ssh=true' '--exit-node=100\.64\.0\.9' '--exit-node-allow-lan-access=true'/)
  assert.ok(s.includes(TS_PREFS_READBACK))
  const off = configureScript('tailscale', DEFAULT_PREFS, [])
  assert.match(off, /'--exit-node=' '--exit-node-allow-lan-access=true'/)
})

test('the configure script: NetBird reconnects with every flag explicit and reads its own config back', () => {
  const flags = clientFlags('netbird', { hostname: 'web', kind: 'lxc', prefs: { ...DEFAULT_PREFS, acceptDns: true, acceptRoutes: true, ssh: true } })
  for (const f of ['--disable-dns=false', '--disable-client-routes=false', '--allow-server-ssh=true']) assert.ok(flags.includes(f), f)
  const s = configureScript('netbird', { ...DEFAULT_PREFS, ssh: true, exitNode: 'route-123' }, flags)
  assert.match(s, /netbird up /); assert.match(s, /netbird networks select 'route-123'/)
  assert.ok(s.includes(NB_FLAGS_READBACK))
  assert.match(NB_FLAGS_READBACK, /ServerSSHAllowed/)
  // A node never gets SSH or DNS, whatever is asked.
  const nodeFlags = clientFlags('netbird', { hostname: 'pve-a', kind: 'node', prefs: { ...DEFAULT_PREFS, ssh: true, acceptDns: true } })
  assert.ok(nodeFlags.includes('--allow-server-ssh=false') && nodeFlags.includes('--disable-dns=true'))
  const tsNode = clientFlags('tailscale', { hostname: 'pve-a', kind: 'node', prefs: { ...DEFAULT_PREFS, acceptDns: true, ssh: true } })
  assert.ok(tsNode.includes('--accept-dns=false') && !tsNode.some(f => f.startsWith('--ssh=true')))
})

test('guest flags follow the requested defaults (accept-dns per guest type)', () => {
  assert.ok(clientFlags('tailscale', { hostname: 'web', kind: 'lxc', prefs: { ...DEFAULT_PREFS, acceptDns: true } }).includes('--accept-dns=true'))
  assert.ok(clientFlags('tailscale', { hostname: 'web', kind: 'lxc' }).includes('--accept-dns=false'))
})

test('sign in with my account: no key anywhere, and the login URL is captured from the client', () => {
  const s = loginScript('tailscale', ['--hostname=web', '--accept-dns=false'])
  assert.doesNotMatch(s, /auth-key|HP_KEY/)
  assert.match(s, /tailscale up .*--timeout=/)
  const out = 'To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c4d5e6f\n\nHP_STATUS_BEGIN\n{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/1a2b3c4d5e6f"}\nHP_STATUS_END'
  assert.equal(parseLoginUrl('tailscale', out), 'https://login.tailscale.com/a/1a2b3c4d5e6f')
  const st = parseStatus('tailscale', out)
  assert.equal(st.needsLogin, true)
  assert.equal(JSON.stringify(st).includes('1a2b3c4d5e6f'), false, 'the status object never carries the URL')
  const nb = 'Please do the SSO login in your browser.\nIf your browser didn\'t open automatically, use this URL to log in:\n\nhttps://idp.example.com/device?user_code=ABCD-EFGH\n'
  assert.equal(parseLoginUrl('netbird', nb), 'https://idp.example.com/device?user_code=ABCD-EFGH')
  assert.match(loginScript('netbird', ['--disable-dns=true']), /netbird up --no-browser/)
  assert.equal(parseLoginUrl('tailscale', 'Success.'), null)
})
