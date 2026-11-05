// The VPN page's service features on a fake executor, a stand-in client and a fake provider: one-click
// installs with the provider defaults, per-machine settings read back from the client, sign-in links
// that are captured but never logged or stored, provider device actions, and new-device notifications.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAccessService, overviewForRole, type RemoteJob } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine, ProviderDevice, RemoteProvider } from '../src/lib/remote/types'

const NODE: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const CT: Machine = { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, ostype: 'debian' }
const VM: Machine = { id: 'qemu-102', kind: 'qemu', name: 'app', node: 'pve-a', vmid: 102, running: true, ostype: 'l26' }
const LOGIN = 'https://login.tailscale.com/a/5ecret5ign1n'

const FACTS = 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1\nHP_CURL=1'
const SNAP = ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')
const status = (ip: string, extra: Record<string, unknown> = {}) => `HP_STATUS_BEGIN\n${JSON.stringify({ BackendState: 'Running', Version: '1.92.0', Self: { ID: 'n-1', HostName: 'web', TailscaleIPs: [ip] }, ...extra })}\nHP_STATUS_END`
const prefsDump = (p: Record<string, unknown>) => `HP_PREFS_BEGIN\n${Object.entries({ RouteAll: false, ExitNodeIP: '', ExitNodeAllowLANAccess: false, CorpDNS: false, RunSSH: false, AdvertiseRoutes: null, NetfilterMode: 2, ...p }).map(([k, v]) => `\t"${k}": ${JSON.stringify(v)},`).join('\n')}\nHP_PREFS_END`

function classify(s: string): string {
  if (s.includes('HP_BUSY=')) return 'busy'
  if (s.includes('HP_OS_ID=')) return 'detect'
  if (s.includes('HP_SNAPSHOT_END')) return 'snapshot'
  if (s.includes('HP_KEY=')) return 'up'
  if (s.includes('--timeout=20s') || s.includes('netbird up --no-browser')) return 'login'
  if (/tailscale set '--accept-dns=/.test(s)) return 'configure'
  if (s.includes('HP_PREFS_BEGIN')) return 'prefs'
  if (s.includes('apt-get install -y -qq')) return 'install'
  if (s.includes('HP_STATUS_BEGIN')) return 'status'
  return 'other'
}

function world(answer?: (m: Machine, kind: string, script: string) => [number, string] | undefined) {
  const ran: Array<{ machine: string; kind: string; script: string }> = []
  const prefs: Record<string, unknown> = {}
  const exec: RemoteExecutor = {
    listMachines: async () => [NODE, CT, VM],
    run: async (m, script, o) => {
      const kind = classify(script)
      ran.push({ machine: m.id, kind, script })
      let out = answer?.(m, kind, script)
      if (!out) {
        if (kind === 'configure') {
          // A stand-in client that takes exactly what it was told.
          const flag = (f: string) => new RegExp(`'--${f}=([^']*)'`).exec(script)?.[1]
          prefs.CorpDNS = flag('accept-dns') === 'true'; prefs.RouteAll = flag('accept-routes') === 'true'; prefs.RunSSH = flag('ssh') === 'true'
          prefs.ExitNodeIP = flag('exit-node') ?? ''; prefs.ExitNodeAllowLANAccess = flag('exit-node-allow-lan-access') === 'true'
        }
        out = kind === 'detect' ? [0, FACTS] : kind === 'snapshot' ? [0, SNAP] : kind === 'busy' ? [0, 'HP_BUSY='] :
          kind === 'up' ? [0, status('100.64.0.5')] :
          kind === 'prefs' || kind === 'configure' ? [0, `${prefsDump(prefs)}\n${status('100.64.0.5')}`] :
          kind === 'status' ? [0, status('100.64.0.5')] : [0, 'ok']
      }
      for (let i = 0; i < out[1].length; i += 7) o?.onData?.(out[1].slice(i, i + 7))
      return { code: out[0], output: out[1], timedOut: false }
    },
    lxcConfig: async () => ({}), setLxcConfig: async () => undefined,
    firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
    hostKeyTarget: async () => ({ host: '192.0.2.11', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
  }
  return { exec, ran, prefs, kinds: () => ran.map(r => r.kind) }
}

function provider() {
  const devices: ProviderDevice[] = []
  const calls: string[] = []
  const p: RemoteProvider = {
    id: 'tailscale', test: async () => 'ok',
    mintKey: async () => ({ id: 'k1', secret: 'tskey-auth-KEYMARKER0001', expiresAt: 'soon' }),
    revokeKey: async () => undefined, keyRevoked: async () => true,
    listDevices: async () => devices, deleteDevice: async id => { calls.push(`delete ${id}`) },
    setRouting: async () => [], advertisedRoutes: async () => [],
    setKeyExpiry: async (d, off) => { calls.push(`expiry ${d.id} ${off}`) },
    setTags: async (d, t) => { calls.push(`tags ${d.id} ${t.join(',')}`) },
    approve: async d => { calls.push(`approve ${d.id}`) },
  }
  return { p, devices, calls }
}

function rig(o: { answer?: Parameters<typeof world>[0]; settings?: Record<string, unknown>; locked?: boolean; now?: () => number; netbird?: boolean } = {}) {
  const w = world(o.answer)
  const prov = provider()
  const store = new MemoryRemoteStore()
  const published: Array<{ e: any; o: any }> = []
  const svc = new RemoteAccessService({
    store, exec: w.exec,
    provider: async id => { if (o.locked) throw new Error('HyperProx is locked — sign in to unlock the vault before reading remote/tailscale'); return id === 'tailscale' || o.netbird ? prov.p : null },
    providerSettings: async () => ({ tags: ['tag:server'], ...(o.settings ?? {}) }),
    settleMs: 0, sleep: async () => undefined, now: o.now,
    publish: async (e, opt) => { published.push({ e, o: opt }) },
  })
  return { svc, store, w, prov, published }
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 400; i++) { const j = svc.getJob(job.id)!; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('job did not settle')
}

async function installed(r: ReturnType<typeof rig>, m: Machine) {
  r.prov.devices.push({ id: `dev-${m.id}`, nodeKey: 'n-1', name: m.name, addresses: ['100.64.0.5'], online: true, lastSeen: null, version: '1.92.0' })
  const j = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: [m.id] }, 'admin@example.com'))
  assert.equal(j.status, 'completed', j.error)
  r.w.ran.length = 0
}

// ── One-click install ────────────────────────────────────────────────────────

test('one-click: a container gets the configured tags and its DNS default; the preview says so in words', async () => {
  const r = rig({ settings: { acceptDnsCt: true, acceptDnsVm: false } })
  const pv = await r.svc.installPreview('lxc-101', 'tailscale')
  assert.equal(pv.profile, 'guest'); assert.equal(pv.acceptDns, true); assert.deepEqual(pv.tags, ['tag:server'])
  assert.match(pv.steps.join(' '), /manage web's DNS/)
  assert.ok(pv.flags.includes('--accept-dns=true'))
  assert.equal((await r.svc.installPreview('qemu-102', 'tailscale')).acceptDns, false, 'VMs have their own default')
  const job = await settle(r.svc, await r.svc.oneClickInstall('lxc-101', 'tailscale', 'admin@example.com'))
  assert.equal(job.status, 'completed', job.error)
  assert.match(r.w.ran.find(x => x.kind === 'up')!.script, /'--accept-dns=true'/)
})

test('one-click: a node keeps the locked-down profile whatever the defaults say', async () => {
  const r = rig({ settings: { acceptDnsCt: true, acceptDnsVm: true } })
  const pv = await r.svc.installPreview('node-pve-a', 'tailscale')
  assert.equal(pv.profile, 'node'); assert.equal(pv.acceptDns, false)
  assert.match(pv.steps.join(' '), /Proxmox node profile/)
  for (const f of ['--accept-dns=false', '--accept-routes=false', '--netfilter-mode=off']) assert.ok(pv.flags.includes(f), f)
  const j = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'], acceptDns: true }, 'a'))
  assert.equal(j.status, 'failed')
  assert.match(j.steps[0].detail ?? '', /locked off on a Proxmox node/)
})

// ── Sign-in links ────────────────────────────────────────────────────────────

test('sign in with my account: no key is minted, the link is captured, sent only to private channels, and never logged or stored', async () => {
  let now = Date.parse('2026-11-05T10:00:00Z')
  const r = rig({
    now: () => now,
    answer: (_m, kind) => kind === 'login' ? [0, `To authenticate, visit:\n\n\t${LOGIN}\n\n${status('', { BackendState: 'NeedsLogin', AuthURL: LOGIN, Self: {} })}`] : undefined,
  })
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'], auth: 'login' }, 'admin@example.com'))
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.steps[0].detail ?? '', /Waiting for a sign-in/)
  assert.ok(!r.w.kinds().includes('up'), 'no key, no keyed up')
  assert.doesNotMatch(JSON.stringify(job), /5ecret5ign1n/)
  assert.doesNotMatch(JSON.stringify([...r.store.audits, ...(await r.store.list())]), /5ecret5ign1n/)
  assert.equal(r.published.length, 1)
  assert.equal(r.published[0].e.sensitiveLink, LOGIN); assert.equal(r.published[0].o.privateOnly, true)
  assert.doesNotMatch(JSON.stringify({ ...r.published[0].e, sensitiveLink: null }), /5ecret5ign1n/, 'only in the sensitive field')
  const ov = await r.svc.overview()
  assert.equal(ov.machines.find(m => m.id === 'lxc-101')!.cells.tailscale.loginPending, true)
  assert.doesNotMatch(JSON.stringify(ov), /5ecret5ign1n/)
  const shown = await r.svc.revealLogin('lxc-101', 'tailscale', 'admin@example.com')
  assert.equal(shown?.url, LOGIN)
  const a = r.store.audits.find(x => x.action === 'remote.login-url.reveal')
  assert.ok(a); assert.doesNotMatch(JSON.stringify(a), /5ecret5ign1n/)
  now += 11 * 60_000
  assert.equal(await r.svc.revealLogin('lxc-101', 'tailscale', 'a'), null, 'expired and forgotten')
})

// ── Sign-in on a node: the guard waits for the join ─────────────────────────

const NEEDS = status('', { BackendState: 'NeedsLogin', AuthURL: LOGIN, Self: {} })
/** A node whose client prints a link, reports NeedsLogin for `waits` polls, then joins with `prefs`. */
function nodeLogin(o: { waits?: number; joins?: boolean; prefs?: Record<string, unknown>; snapAfter?: string }) {
  let polls = 0, joined = false, snaps = 0
  return (_m: Machine, kind: string, script: string): [number, string] | undefined => {
    if (kind === 'login') return [0, `To authenticate, visit:\n\n\t${LOGIN}\n\n${NEEDS}`]
    if (kind === 'status') { if (o.joins !== false && ++polls > (o.waits ?? 2)) joined = true; return [0, joined ? status('100.64.0.7') : NEEDS] }
    if (kind === 'prefs') return [0, prefsDump({ NetfilterMode: 0, ...(o.prefs ?? {}) })]
    if (kind === 'snapshot' && o.snapAfter && joined && ++snaps >= 1) return [0, SNAP.replace('HP_SNAPSHOT_END', `${o.snapAfter}\nHP_SNAPSHOT_END`)]
    if (script.includes('HP_REMOVED')) return [0, 'HP_REMOVED']
    return undefined
  }
}
const clock = () => { let t = Date.parse('2026-11-05T10:00:00Z'); return () => (t += 5_000) }

test('sign-in on a node: the guard holds until the client joins, then checks the node and the locks', async () => {
  const r = rig({ now: clock(), answer: nodeLogin({ waits: 3 }) })
  r.prov.devices.push({ id: 'dev-node', nodeKey: 'n-1', name: 'pve-a', addresses: ['100.64.0.7'], online: true, lastSeen: null, version: '1.92.0' })
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'], auth: 'login' }, 'admin@example.com'))
  assert.equal(job.status, 'completed', job.error)
  const k = r.w.kinds()
  const joinedAt = k.lastIndexOf('status'), prefsAt = k.lastIndexOf('prefs'), lastSnap = k.lastIndexOf('snapshot')
  assert.ok(k.filter(x => x === 'status').length >= 4, `polled until it joined: ${k.join(' ')}`)
  assert.ok(prefsAt > k.indexOf('login') && lastSnap > prefsAt && lastSnap > joinedAt - 1, `after-check after the join: ${k.join(' ')}`)
  assert.equal(await r.svc.revealLogin('node-pve-a', 'tailscale', 'a'), null, 'the link is forgotten once used')
  assert.doesNotMatch(JSON.stringify(job), /5ecret5ign1n/)
})

test('sign-in on a node that nobody completes: when the link expires the client is taken off again', async () => {
  const r = rig({ now: clock(), answer: nodeLogin({ joins: false }) })
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'], auth: 'login' }, 'a'))
  assert.equal(job.status, 'failed')
  assert.match(job.error ?? job.steps[0].detail ?? '', /link expired/)
  assert.ok(r.w.ran.some(x => x.script.includes('HP_REMOVED')), 'the client was removed')
})

test('sign-in on a node: joined without the node locks is rolled back', async () => {
  const r = rig({ now: clock(), answer: nodeLogin({ prefs: { CorpDNS: true } }) })
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'], auth: 'login' }, 'a'))
  assert.equal(job.status, 'failed')
  assert.match(job.error ?? job.steps[0].detail ?? '', /node locks/)
  assert.ok(r.w.ran.some(x => x.script.includes('HP_REMOVED')))
})

test('sign-in on a node: a change to the node after the join is rolled back', async () => {
  const r = rig({ now: clock(), answer: nodeLogin({ snapAfter: 'HP_ROUTE4 0.0.0.0/1 dev tailscale0' }) })
  const job = await settle(r.svc, r.svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'], auth: 'login' }, 'a'))
  assert.equal(job.status, 'failed')
  assert.match(job.error ?? job.steps[0].detail ?? '', /Rolled back|rolled back/)
})

test('NetBird: a `netbird up` that asks for a sign-in is captured, sent only as a sign-in link, and the log is dropped after 10 minutes', async () => {
  const NB_LINK = 'https://login.netbird.io/activate?user_code=MARK-NBLK'
  let t = Date.parse('2026-11-05T10:00:00Z')
  let dns = true
  const flags = () => `HP_NB_CONFIG=/etc/netbird/config.json\nHP_NB_FLAG DisableDNS:${dns}\nHP_NB_FLAG DisableClientRoutes:true\nHP_NB_FLAG ServerSSHAllowed:false`
  const r = rig({
    netbird: true, now: () => t,
    answer: (_m, _kind, script) => {
      if (script.includes('netbird up')) { dns = /--disable-dns=true/.test(script); return [0, `Please do the SSO login in your browser.\nIf your browser didn't open automatically, use this URL to log in:\n\n${NB_LINK}\n\n${flags()}`] }
      if (script.includes('HP_NB_CONFIG')) return [0, flags()]
      return undefined
    },
  })
  await r.store.upsert({ machineId: 'lxc-101', provider: 'netbird', deviceId: 'peer1', nodeKey: null, hostname: 'web', address: '100.92.0.4', mode: 'kernel', version: '0.60.0', routes: [], exitNode: false, routeIds: [], adopted: false, forwardingBefore: null, connected: true, checkedAt: null, lastError: null })
  const job = await settle(r.svc, r.svc.startJob({ action: 'configure', provider: 'netbird', machineIds: ['lxc-101'], prefs: { acceptDns: true } }, 'admin@example.com'))
  assert.ok(!job.log.includes('MARK-NBLK'), job.log)
  assert.doesNotMatch(JSON.stringify(job), /MARK-NBLK/)
  const sent = r.published.find(p => p.e.sensitiveLink === NB_LINK)
  assert.ok(sent, 'sent through the sign-in-link flow'); assert.equal(sent!.o.privateOnly, true)
  assert.equal((await r.svc.revealLogin('lxc-101', 'netbird', 'a'))?.url, NB_LINK)
  assert.ok(r.svc.getJob(job.id)!.log.length > 100, 'the log is there for now')
  t += 11 * 60_000
  assert.match(r.svc.getJob(job.id)!.log, /^\[This log was dropped/)
})

test('a key that expired: a check finds the client waiting with its own link and captures it', async () => {
  const r = rig()
  await installed(r, CT)
  const r2Answer = (m: Machine, kind: string) => kind === 'status' ? [0, status('100.64.0.5', { BackendState: 'NeedsLogin', AuthURL: LOGIN })] as [number, string] : undefined
  ;(r.w.exec as any).run = (orig => async (m: Machine, s: string, o: any) => (classify(s) === 'status' ? (() => { const out = r2Answer(m, 'status')!; o?.onData?.(out[1]); return { code: 0, output: out[1], timedOut: false } })() : orig(m, s, o)))(r.w.exec.run)
  const job = await settle(r.svc, r.svc.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.match(job.steps[0].detail ?? '', /needs a sign-in/)
  assert.doesNotMatch(job.log, /5ecret5ign1n/, 'the status dump in the log has the link redacted')
  assert.equal(r.published[0]?.e.sensitiveLink, LOGIN)
})

// ── Per-machine settings ─────────────────────────────────────────────────────

test('settings: previewed in words from what the client reports, applied, and confirmed from its own read-back', async () => {
  const r = rig()
  await installed(r, CT)
  const pv = await r.svc.configurePreview('lxc-101', 'tailscale', { acceptDns: true, ssh: true, exitNode: '100.64.0.9' })
  assert.equal(pv.refusal, null)
  assert.match(pv.changes.join(' '), /MagicDNS/); assert.match(pv.changes.join(' '), /internet traffic through 100\.64\.0\.9/)
  assert.match(pv.changes.join(' '), /LAN access stays direct/, 'allow LAN access is on by default')
  const job = await settle(r.svc, r.svc.startJob({ action: 'configure', provider: 'tailscale', machineIds: ['lxc-101'], prefs: { acceptDns: true, ssh: true, exitNode: '100.64.0.9' } }, 'a'))
  assert.equal(job.status, 'completed', job.error)
  assert.match(r.w.ran.find(x => x.kind === 'configure')!.script, /'--exit-node-allow-lan-access=true'/)
  const rec = await r.store.get('lxc-101', 'tailscale')
  assert.equal(rec?.prefs?.acceptDns, true); assert.equal(rec?.prefs?.ssh, true)
  assert.ok(r.store.audits.some(a => a.action === 'remote.configure'))
})

test('settings: a client that does not take the change is put back and the job says what it reports', async () => {
  const r = rig({ answer: (_m, kind) => kind === 'configure' ? [0, `${prefsDump({ CorpDNS: false })}\n${status('100.64.0.5')}`] : undefined })
  await installed(r, CT)
  const job = await settle(r.svc, r.svc.startJob({ action: 'configure', provider: 'tailscale', machineIds: ['lxc-101'], prefs: { acceptDns: true } }, 'a'))
  assert.equal(job.status, 'failed')
  assert.match(job.steps[0].detail ?? '', /did not take the change: acceptDns is false.*put the previous settings back/s)
  assert.equal(r.w.kinds().filter(k => k === 'configure').length, 2, 'the change and its undo')
})

test('settings: a node refuses DNS, SSH, accepted routes and exit nodes before anything runs', async () => {
  const r = rig()
  await installed(r, NODE)
  for (const prefs of [{ acceptDns: true }, { ssh: true }, { acceptRoutes: true }, { exitNode: '100.64.0.9' }, { advertiseExitNode: true }]) {
    const j = await settle(r.svc, r.svc.startJob({ action: 'configure', provider: 'tailscale', machineIds: ['node-pve-a'], prefs }, 'a'))
    assert.equal(j.status, 'failed', JSON.stringify(prefs))
    assert.match(j.steps[0].detail ?? '', /node/)
  }
  assert.ok(!r.w.kinds().includes('configure'))
})

// ── Devices at the provider ──────────────────────────────────────────────────

test('key expiry and tags act on the recorded device by id, and are audited', async () => {
  const r = rig()
  await installed(r, CT)
  assert.match(await r.svc.setKeyExpiry('lxc-101', 'tailscale', true, 'admin@example.com'), /stays signed in/)
  await r.svc.setTags('lxc-101', 'tailscale', ['tag:web'], 'admin@example.com')
  await assert.rejects(r.svc.setTags('lxc-101', 'tailscale', ['web'], 'a'), /tag:server/)
  assert.deepEqual(r.prov.calls, ['expiry dev-lxc-101 true', 'tags dev-lxc-101 tag:web'])
  assert.ok(r.store.audits.some(a => a.action === 'remote.key-expiry'))
  await assert.rejects(r.svc.setKeyExpiry('qemu-102', 'tailscale', true, 'a'), /No Tailscale device is recorded/)
})

test('the overview shows the DNS name and key expiry, warns under 14 days, and lists devices waiting for approval', async () => {
  const now = Date.parse('2026-11-05T10:00:00Z')
  const r = rig({ now: () => now })
  await installed(r, CT)
  Object.assign(r.prov.devices[0], { dnsName: 'web.tail0.ts.net', expiresAt: '2026-11-12T00:00:00Z' })
  r.prov.devices.push({ id: 'phone', name: 'pixel', addresses: [], online: false, lastSeen: null, version: null, pending: true, os: 'android', user: 'someone@example.com' })
  const ov = await r.svc.overview()
  const c = ov.machines.find(m => m.id === 'lxc-101')!.cells.tailscale
  assert.equal(c.dnsName, 'web.tail0.ts.net'); assert.equal(c.expiresAt, '2026-11-12T00:00:00Z'); assert.equal(c.expiryWarning, true)
  assert.deepEqual(ov.pendingDevices.map(d => [d.id, d.os]), [['phone', 'android']])
  assert.match(await r.svc.approveDevice('tailscale', 'phone', 'a'), /Approved pixel/)
  await r.svc.removeDevice('tailscale', 'phone', 'a')
  assert.deepEqual(r.prov.calls, ['approve phone', 'delete phone'])
  const viewer = overviewForRole(ov, false)
  assert.equal(viewer.pendingDevices.length, 0)
  assert.equal(viewer.machines.find(m => m.id === 'lxc-101')!.cells.tailscale.dnsName, 'web.tail0.ts.net')
  assert.deepEqual(viewer.machines.find(m => m.id === 'lxc-101')!.cells.tailscale.tags, [])
})

// ── New devices ──────────────────────────────────────────────────────────────

test('new devices: the first look learns what is there; each new one is announced once; ours are not announced', async () => {
  const r = rig()
  r.prov.devices.push({ id: 'old', name: 'laptop', addresses: [], online: true, lastSeen: null, version: null })
  await r.svc.pollDevices()
  assert.equal(r.published.length, 0, 'the first look is silent')
  r.prov.devices.push({ id: 'new', name: 'tablet', addresses: [], online: true, lastSeen: null, version: null, os: 'iOS', user: 'kid@example.com', pending: true })
  await installed(r, CT)   // HyperProx's own install adds dev-lxc-101
  await r.svc.pollDevices()
  assert.equal(r.published.length, 1)
  const e = r.published[0].e
  assert.equal(e.type, 'vpn.device.new'); assert.equal(e.severity, 'warning')
  assert.match(e.title, /tablet/); assert.match(e.lines.join(' '), /iOS.*kid@example\.com.*approve/s)
  assert.equal(e.link, '/vpn'); assert.equal(r.published[0].o, undefined, 'not a sensitive event')
  assert.deepEqual(e.plain, ['tablet', 'iOS', 'kid@example.com'], 'outside values are marked to show as plain text')
  await r.svc.pollDevices()
  assert.equal(r.published.length, 1, 'announced once')
})

test('new devices: while HyperProx is locked the poller does nothing and says nothing', async () => {
  const r = rig({ locked: true })
  await r.svc.pollDevices()
  assert.equal(r.published.length, 0)
  assert.equal((await r.store.listKnownDevices('tailscale')).length, 0)
})
