// The VPN page with clients already installed and no provider API key: real state per machine from the
// read-only probe, "found, not managed" with Manage it here (adopt), an honest provider card, HyperProx's
// own container shown read-only, and no probe from a viewer's read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RemoteAccessService, overviewForRole, type RemoteJob } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import { ClientDetector, DETECT_CLIENTS_SCRIPT } from '../src/lib/remote/detect'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'

const FIX = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/vpn-detect', f), 'utf8')
const NODE_A: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const NODE_B: Machine = { id: 'node-pve-b', kind: 'node', name: 'pve-b', node: 'pve-b', running: true, address: '192.0.2.12' }
const SELF: Machine = { id: 'lxc-120', kind: 'lxc', name: 'hyperprox', node: 'pve-b', vmid: 120, running: true, ostype: 'debian' }
const WEB: Machine = { id: 'lxc-121', kind: 'lxc', name: 'web', node: 'pve-b', vmid: 121, running: true, ostype: 'debian' }
const PLAIN: Machine = { id: 'lxc-122', kind: 'lxc', name: 'db', node: 'pve-b', vmid: 122, running: true, ostype: 'debian' }

const PREFS = (o: Record<string, unknown> = {}) => `HP_PREFS_BEGIN\n${Object.entries({ RouteAll: false, ExitNodeID: '', CorpDNS: false, RunSSH: false, AdvertiseRoutes: null, NetfilterMode: 0, ...o }).map(([k, v]) => `\t"${k}": ${JSON.stringify(v)},`).join('\n')}\nHP_PREFS_END`
const probe = (status: string | null, prefs = PREFS()) => status === null
  ? 'HP_DETECT_BEGIN\nHP_TS_BIN=\nHP_NB_BIN=\nHP_DETECT_END'
  : `HP_DETECT_BEGIN\nHP_TS_BIN=/usr/bin/tailscale\nHP_TS_DAEMON=active\nHP_TS_STATUS_BEGIN\n${status}\nHP_TS_STATUS_END\n${prefs}\nHP_NB_BIN=\nHP_DETECT_END`
const FACTS = 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1\nHP_HAS_TAILSCALE=1.104.5'
const SNAP = ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')

function rig(o: { nodeBPrefs?: string; provider?: boolean } = {}) {
  const probes: string[] = []
  const ran: Array<{ m: string; script: string }> = []
  const running = FIX('ts-node-running.json')
  const web = JSON.parse(FIX('ts-container-running.json')); web.Self.HostName = 'web'; web.Self.DNSName = 'web.tail0000.ts.net.'; web.Self.TailscaleIPs = ['100.64.0.21']
  const status: Record<string, string | null> = { 'node-pve-a': FIX('ts-node-stopped.json'), 'node-pve-b': running, 'lxc-121': JSON.stringify(web), 'lxc-122': null }
  const exec: RemoteExecutor = {
    listMachines: async () => [NODE_A, NODE_B, SELF, WEB, PLAIN],
    run: async (m, script) => {
      ran.push({ m: m.id, script })
      if (script === DETECT_CLIENTS_SCRIPT) { probes.push(m.id); return { code: 0, output: probe(status[m.id], m.id === 'node-pve-b' ? o.nodeBPrefs ?? PREFS() : PREFS()), timedOut: false } }
      if (script.includes('HP_BUSY=')) return { code: 0, output: 'HP_BUSY=', timedOut: false }
      if (script.includes('HP_OS_ID=')) return { code: 0, output: FACTS, timedOut: false }
      if (script.includes('HP_SNAPSHOT_END')) return { code: 0, output: SNAP, timedOut: false }
      if (script.includes('HP_PREFS_BEGIN') && !script.includes('tailscale set')) return { code: 0, output: m.id === 'node-pve-b' ? o.nodeBPrefs ?? PREFS() : PREFS(), timedOut: false }
      if (script.includes('HP_STATUS_BEGIN')) return { code: 0, output: `HP_STATUS_BEGIN\n${status[m.id] ?? '{}'}\nHP_STATUS_END`, timedOut: false }
      return { code: 0, output: 'ok', timedOut: false }
    },
    lxcConfig: async () => ({}), setLxcConfig: async () => undefined,
    firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
    hostKeyTarget: async () => ({ host: '192.0.2.11', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
  }
  const local: string[] = []
  const detector = new ClientDetector({
    listMachines: exec.listMachines, run: exec.run, selfId: async () => 'lxc-120',
    local: async () => { local.push('x'); return { code: 0, output: probe(FIX('ts-container-running.json')), timedOut: false } },
  })
  const store = new MemoryRemoteStore()
  const svc = new RemoteAccessService({
    store, exec, detector, settleMs: 0, sleep: async () => undefined,
    provider: async () => null, providerSettings: async () => ({ tags: [] }),
  })
  return { svc, store, probes, ran, local, detector }
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 400; i++) { const j = svc.getJob(job.id)!; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('job did not settle')
}

test('no API key: each machine shows what is really on it, and nothing says "not set up"', async () => {
  const r = rig()
  await r.svc.refreshDetection()
  const ov = await r.svc.overview()
  const cell = (id: string) => ov.machines.find(m => m.id === id)!.cells.tailscale
  assert.equal(cell('node-pve-b').state, 'connected'); assert.equal(cell('node-pve-b').managed, false)
  assert.equal(cell('node-pve-b').detectedText, 'Tailscale installed, connected as pve-b.tail0000.ts.net (100.64.0.11)')
  assert.equal(cell('node-pve-b').ip, '100.64.0.11'); assert.equal(cell('node-pve-b').dnsName, 'pve-b.tail0000.ts.net')
  assert.equal(cell('node-pve-a').state, 'signed-out'); assert.equal(cell('node-pve-a').detectedText, 'Tailscale installed, signed out')
  assert.equal(cell('lxc-121').state, 'connected')
  assert.equal(cell('lxc-122').state, 'not-installed')
  assert.equal(ov.machines.find(m => m.id === 'lxc-122')!.cells.netbird.state, 'not-installed')
  const ts = ov.providers.find(p => p.id === 'tailscale')!
  assert.equal(ts.configured, false); assert.equal(ts.onTailnet, 3)
  assert.equal(ts.summary, '3 machines already on a tailnet — add an API key to manage installs and approvals')
  assert.doesNotMatch(JSON.stringify(ov), /not set up/i)
  assert.ok(ov.detection.checkedAt)
})

test('HyperProx\'s own container is read locally and shown read-only as this HyperProx; no job may touch it', async () => {
  const r = rig()
  await r.svc.refreshDetection()
  assert.equal(r.local.length, 1); assert.ok(!r.probes.includes('lxc-120'))
  const ov = await r.svc.overview()
  const self = ov.machines.find(m => m.id === 'lxc-120')!
  assert.equal(self.self, true); assert.equal(self.cells.tailscale.state, 'connected')
  assert.equal(self.cells.tailscale.dnsName, 'hyperprox.tail0000.ts.net')
  const job = await settle(r.svc, r.svc.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-120'] }, 'admin@example.com'))
  assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /this HyperProx.*read-only/i)
  assert.ok(!r.ran.some(x => x.m === 'lxc-120'), 'nothing ran on it')
})

test('a viewer\'s read never probes; an admin\'s read probes only when the cache is stale; Refresh always does', async () => {
  const r = rig()
  const asViewer = overviewForRole(await r.svc.overview({ mayProbe: false }), false)
  assert.equal(r.probes.length, 0, 'viewer: no probe')
  assert.equal(asViewer.machines.find(m => m.id === 'node-pve-b')!.cells.tailscale.state, 'unchecked')
  await r.svc.overview({ mayProbe: true })
  await r.detector.refresh({ ifStale: true })   // the admin's background refresh has finished
  const n = r.probes.length
  assert.ok(n >= 4, 'admin, stale: probed')
  await r.svc.overview({ mayProbe: true })
  assert.equal(r.probes.length, n, 'admin, fresh: not again')
  await r.svc.refreshDetection()
  assert.equal(r.probes.length, n * 2, 'Refresh: again')
  const v = overviewForRole(await r.svc.overview(), false).machines.find(m => m.id === 'node-pve-b')!.cells.tailscale
  assert.equal(v.state, 'connected'); assert.equal(v.detectedText, 'Tailscale installed, connected as pve-b.tail0000.ts.net (100.64.0.11)')
})

test('Manage it here, with no API key: a guest\'s client is adopted from the machine and the job says the provider does not know it yet', async () => {
  const r = rig()
  await r.svc.refreshDetection()
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-121'], existing: 'adopt' }, 'admin@example.com'))
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.steps[0].detail ?? '', /not known to the Tailscale API yet/)
  const rec = await r.store.get('lxc-121', 'tailscale')
  assert.equal(rec?.adopted, true); assert.equal(rec?.deviceId, null); assert.equal(rec?.address, '100.64.0.21')
  const ov = await r.svc.overview()
  const c = ov.machines.find(m => m.id === 'lxc-121')!.cells.tailscale
  assert.equal(c.managed, true); assert.equal(c.state, 'connected')
})

test('Manage it here on a node keeps the node locks: a client accepting DNS is refused, and what differs is said', async () => {
  const r = rig({ nodeBPrefs: PREFS({ CorpDNS: true }) })
  await r.svc.refreshDetection()
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-b'], existing: 'adopt' }, 'admin@example.com'))
  assert.equal(job.status, 'failed')
  assert.match(job.error ?? '', /accepts DNS.*Adopt and apply the node locks/s)
  assert.equal(await r.store.get('node-pve-b', 'tailscale'), null)
})

test('what needs the provider API says so plainly when there is no key; a new install needs one too', async () => {
  const r = rig()
  for (const req of [{ action: 'routing', subnets: [] }, { action: 'install' }] as const) {
    const job = await settle(r.svc, r.svc.startJob({ provider: 'tailscale', machineIds: ['lxc-122'], ...req } as any, 'a'))
    assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /needs a Tailscale API key/)
  }
})
