// Finding the VPN clients already on each machine, with no provider credentials: a read-only probe, parsed
// from anonymised real `tailscale status --json` output; cached, refreshed on request, never by a viewer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DETECT_CLIENTS_SCRIPT, parseDetection, ClientDetector, describeDetected } from '../src/lib/remote/detect'
import type { Machine } from '../src/lib/remote/types'

const FIX = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/vpn-detect', f), 'utf8')
const PREFS = (o: Record<string, unknown> = {}) => `HP_PREFS_BEGIN\n${Object.entries({ RouteAll: false, ExitNodeID: '', CorpDNS: false, RunSSH: false, AdvertiseRoutes: ['192.0.2.0/24', '198.51.100.0/24'], NetfilterMode: 2, ...o }).map(([k, v]) => `\t"${k}": ${JSON.stringify(v)},`).join('\n')}\nHP_PREFS_END`
/** What the probe prints on a machine with Tailscale (status from a fixture) and no NetBird. */
const tsOut = (status: string, o: { daemon?: string; prefs?: string } = {}) =>
  `HP_DETECT_BEGIN\nHP_TS_BIN=/usr/bin/tailscale\nHP_TS_DAEMON=${o.daemon ?? 'active'}\nHP_TS_STATUS_BEGIN\n${status}\nHP_TS_STATUS_END\n${o.prefs ?? PREFS()}\nHP_NB_BIN=\nHP_DETECT_END`

test('a node on the tailnet: connected as its MagicDNS name and overlay IP, with its tailnet, version, routes and settings', () => {
  const d = parseDetection(tsOut(FIX('ts-node-running.json')))
  const t = d.tailscale
  assert.equal(t.installed, true); assert.equal(t.running, true); assert.equal(t.loggedIn, true); assert.equal(t.connected, true)
  assert.equal(t.ip, '100.64.0.11'); assert.equal(t.dnsName, 'pve-b.tail0000.ts.net'); assert.equal(t.tailnet, 'owner@example.com')
  assert.equal(t.version, '1.104.5'); assert.equal(t.keyExpiry, null)
  assert.deepEqual(t.advertisedRoutes, ['192.0.2.0/24', '198.51.100.0/24'])
  assert.equal(t.acceptDns, false); assert.equal(t.acceptRoutes, false); assert.equal(t.ssh, false); assert.equal(t.exitNode, null)
  assert.equal(d.netbird.installed, false)
  assert.equal(describeDetected('tailscale', t), 'Tailscale installed, connected as pve-b.tail0000.ts.net (100.64.0.11)')
})

test('a node whose Tailscale is stopped: installed, signed out; the sign-in link it holds is never kept', () => {
  const d = parseDetection(tsOut(FIX('ts-node-stopped.json'), { daemon: 'active', prefs: 'HP_PREFS_BEGIN\nHP_PREFS_END' }))
  const t = d.tailscale
  assert.equal(t.installed, true); assert.equal(t.connected, false); assert.equal(t.loggedIn, false)
  assert.equal(describeDetected('tailscale', t), 'Tailscale installed, signed out')
  assert.doesNotMatch(JSON.stringify(d), /login\.tailscale\.com|0000fixture/)
})

test('a key that expires is read; the daemon being down is said', () => {
  const j = JSON.parse(FIX('ts-container-running.json')); j.Self.KeyExpiry = '2026-12-01T00:00:00Z'
  const t = parseDetection(tsOut(JSON.stringify(j))).tailscale
  assert.equal(t.keyExpiry, '2026-12-01T00:00:00Z')
  const down = parseDetection(tsOut('{}', { daemon: 'inactive' })).tailscale
  assert.equal(down.installed, true); assert.equal(down.running, false)
  assert.equal(describeDetected('tailscale', down), 'Tailscale installed, not running')
  assert.equal(describeDetected('tailscale', parseDetection('HP_DETECT_BEGIN\nHP_TS_BIN=\nHP_NB_BIN=\nHP_DETECT_END').tailscale), 'not installed')
})

test('NetBird: connected, with its name, address, version, management server and settings', () => {
  const nb = JSON.stringify({ cliVersion: '0.60.0', daemonVersion: '0.60.0', management: { url: 'https://api.netbird.io:443', connected: true }, netbirdIp: '100.92.1.2/16', fqdn: 'web.netbird.cloud', peers: { total: 3, connected: 2 } })
  const out = `HP_DETECT_BEGIN\nHP_TS_BIN=\nHP_NB_BIN=/usr/bin/netbird\nHP_NB_DAEMON=active\nHP_NB_STATE=Connected\nHP_NB_STATUS_BEGIN\n${nb}\nHP_NB_STATUS_END\nHP_NB_CONFIG=/var/lib/netbird/default.json\nHP_NB_FLAG DisableDNS:true\nHP_NB_FLAG DisableClientRoutes:false\nHP_NB_FLAG ServerSSHAllowed:true\nHP_DETECT_END`
  const n = parseDetection(out).netbird
  assert.equal(n.connected, true); assert.equal(n.ip, '100.92.1.2'); assert.equal(n.dnsName, 'web.netbird.cloud'); assert.equal(n.tailnet, 'https://api.netbird.io:443')
  assert.equal(n.acceptDns, false); assert.equal(n.acceptRoutes, true); assert.equal(n.ssh, true)
  const out2 = out.replace('HP_NB_STATE=Connected', 'HP_NB_STATE=NeedsLogin').replace('"connected":true', '"connected":false')
  assert.equal(describeDetected('netbird', parseDetection(out2).netbird), 'NetBird installed, signed out')
})

test('the probe is read-only and runs in real bash where nothing is installed', () => {
  for (const bad of [/tailscale (up|down|set|login|logout)\b/, /netbird (up|down|login|logout|service)\b/, /apt-get|dnf |rm |>\s*\/etc|systemctl (start|stop|restart|enable|disable)/]) {
    assert.doesNotMatch(DETECT_CLIENTS_SCRIPT, bad)
  }
  assert.match(DETECT_CLIENTS_SCRIPT, /--peers=false/)
  const out = execFileSync('bash', ['-s'], { input: DETECT_CLIENTS_SCRIPT, env: { PATH: '/usr/bin:/bin' } }).toString()
  const d = parseDetection(out)
  assert.equal(typeof d.tailscale.installed, 'boolean'); assert.equal(typeof d.netbird.installed, 'boolean')
})

// ── The cache ──────────────────────────────────────────────────────────────

const NODE: Machine = { id: 'node-pve-b', kind: 'node', name: 'pve-b', node: 'pve-b', running: true }
const CT: Machine = { id: 'lxc-120', kind: 'lxc', name: 'hyperprox', node: 'pve-b', vmid: 120, running: true }
const STOPPED: Machine = { id: 'lxc-121', kind: 'lxc', name: 'off', node: 'pve-b', vmid: 121, running: false }
const WIN: Machine = { id: 'qemu-130', kind: 'qemu', name: 'win', node: 'pve-b', vmid: 130, running: true, ostype: 'win11' }

function rig() {
  let t = 0
  const ran: string[] = []
  const local: string[] = []
  const det = new ClientDetector({
    listMachines: async () => [NODE, CT, STOPPED, WIN],
    run: async (m, script) => { ran.push(m.id); assert.equal(script, DETECT_CLIENTS_SCRIPT); return { code: 0, output: tsOut(FIX('ts-node-running.json')), timedOut: false } },
    local: async () => { local.push('self'); return { code: 0, output: tsOut(FIX('ts-container-running.json')), timedOut: false } },
    selfId: async () => 'lxc-120',
    now: () => t,
  })
  return { det, ran, local, tick: (ms: number) => { t += ms } }
}

test('cache: one probe per running node and guest (HyperProx itself read locally), kept for minutes, refreshed on request', async () => {
  const r = rig()
  assert.equal(r.det.cached().size, 0, 'nothing probed until asked')
  assert.equal(r.det.stale(), true)
  await r.det.refresh()
  assert.deepEqual(r.ran.sort(), ['node-pve-b'], 'stopped guests and Windows are not probed; itself is read locally')
  assert.equal(r.local.length, 1)
  const self = r.det.cached().get('lxc-120')!
  assert.equal(self.self, true); assert.equal(self.result!.tailscale.dnsName, 'hyperprox.tail0000.ts.net')
  r.tick(60_000); assert.equal(r.det.stale(), false)
  await r.det.refresh({ ifStale: true })
  assert.equal(r.ran.length, 1, 'fresh: not probed again')
  r.tick(5 * 60_000); assert.equal(r.det.stale(), true)
  await r.det.refresh({ ifStale: true })
  assert.equal(r.ran.length, 2)
  await r.det.refresh()
  assert.equal(r.ran.length, 3, 'Refresh always probes')
})

test('cache: two refreshes at once probe once; a machine that cannot be reached keeps its error, not a guess', async () => {
  const r = rig()
  await Promise.all([r.det.refresh(), r.det.refresh()])
  assert.equal(r.ran.length, 1)
  const det = new ClientDetector({
    listMachines: async () => [NODE], now: () => 0,
    run: async () => { throw new Error('HyperProx is locked — sign in to unlock the vault before reading node logins') },
  })
  await det.refresh()
  const e = det.cached().get('node-pve-b')!
  assert.equal(e.result, null); assert.match(e.error!, /locked/)
})
