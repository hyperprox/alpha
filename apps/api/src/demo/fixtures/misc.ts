// Demo fixtures: the smaller reads the pages make that the other files do not cover: the top bar's cluster name, the Users page,
// a guest's HA panel and migration check, a guest's config drawer, the proxy's certificates, the new-website address options,
// the VPN pages' install checks and the install wizard's placement. All invented.
import type { FixtureRoute } from './types'
import { NODES, GUESTS, CLUSTER_NAME, DOMAIN, DOMAIN2, DEMO_OWNER, PEOPLE, GiB, iso, DAY, HOUR, MIN, guestByVmid, nodeOf, sidOf, wobble, seeded, fingerprint } from './data'
import { placementGuest } from './placement'

const ok = (data: unknown) => ({ success: true, data })
const other = (n: string) => (n === 'pve-a' ? 'pve-b' : 'pve-a')

// ------------------------------------------------------------------ Users
function users() {
  const members = [
    { id: 'u1', email: DEMO_OWNER.email, name: 'Alex', role: 'owner', status: 'confirmed', twoFactor: true, fingerprint: fingerprint('alex', 8) },
    { id: 'u2', email: `sam@${DOMAIN}`, name: 'Sam', role: 'admin', status: 'confirmed', twoFactor: true, fingerprint: fingerprint('sam', 8) },
    { id: 'u3', email: `jordan@${DOMAIN}`, name: 'Jordan', role: 'operator', status: 'confirmed', twoFactor: false, fingerprint: fingerprint('jordan', 8) },
    { id: 'u4', email: `casey@${DOMAIN}`, name: 'Casey', role: 'viewer', status: 'accepted', twoFactor: false, fingerprint: fingerprint('casey', 8) },
    { id: 'u5', email: `riley@${DOMAIN2}`, name: null, role: 'viewer', status: 'invited', twoFactor: false, fingerprint: null },
  ]
  const invitations = [{ id: 'inv1', email: `riley@${DOMAIN2}`, role: 'viewer', by: DEMO_OWNER.email, expiresAt: new Date(Date.now() + 5 * DAY).toISOString(), joined: false }]
  return { members, invitations }
}

// ------------------------------------------------------------------ HA, per guest
const RULES: Record<string, { id: string; nodes: Array<{ node: string; priority: number }>; resources: string[] }> = {
  'media-on-pve-c': { id: 'media-on-pve-c', nodes: [{ node: 'pve-c', priority: 5 }, { node: 'pve-a', priority: 1 }], resources: ['ct:301', 'ct:302'] },
  'network-core': { id: 'network-core', nodes: [{ node: 'pve-a', priority: 5 }, { node: 'pve-b', priority: 1 }], resources: ['ct:101', 'ct:102', 'ct:205'] },
}
function haGuest(type: string, vmid: string) {
  const g = guestByVmid(Number(vmid)) ?? GUESTS[0]
  const sid = sidOf(g)
  const on = g.status === 'running'
  const r = Object.values(RULES).find(x => x.resources.includes(sid)) ?? null
  const rule = r ? { id: r.id, type: 'node-affinity' as const, affinity: 'positive' as const, strict: false, nodes: r.nodes, resources: r.resources, disabled: false, order: 1 } : null
  const to = other(g.node)
  return {
    sid, vmid: g.vmid, type: g.type, name: g.name, node: g.node, status: g.status, protected: !!g.ha,
    resource: g.ha ? { sid, state: on ? 'started' : 'stopped', maxRestart: 1, maxRelocate: 1, failback: true, autoRebalance: false } : null, haState: g.ha ? (on ? 'started' : 'stopped') : null,
    home: { rule, choice: rule ? { mode: 'prefer' as const, tiers: r!.nodes.map(n => [n.node]) } : { mode: 'none' as const, tiers: [] as string[][] }, avoid: [] as string[], disabled: false,
      sharedWith: r ? r.resources.filter(x => x !== sid) : [], words: rule ? `Prefers ${r!.nodes.map(n => n.node).join(', then ')}; runs anywhere if needed.` : 'No home: it stays where it is until something moves it.' },
    together: [], apart: [],
    prediction: g.ha ? { to, candidates: [to], words: `If ${g.node} fails it will most likely start on ${to}.` } : null,
    statusLine: g.ha ? `Protected by HA, ${on ? 'running' : 'stopped'} on ${g.node}.` : `Not protected by HA: it stays down if ${g.node} fails.`,
    hardware: g.gpu ? [`Uses the GPU in ${g.node}.`] : [],
    warnings: [], notes: g.gpu ? [`If ${g.node} fails it runs on ${to} without its GPU.`] : [],
    nodes: NODES.map(n => ({ node: n.node, online: true, maintenance: false })),
    others: GUESTS.filter(x => x.ha && x.vmid !== g.vmid).slice(0, 8).map(x => ({ sid: sidOf(x), name: x.name, node: x.node })),
    quorate: true, fencing: 'armed', disarmMode: null,
  }
}
function preflight(type: string, vmid: string) {
  const g = guestByVmid(Number(vmid)) ?? GUESTS[0]
  const pg = placementGuest(g)
  const rows = NODES.map(n => {
    if (n.node === g.node) return { node: n.node, current: true, allowed: true, reasons: [] as string[], notes: [] as string[] }
    const t = pg.targets.find(x => x.node === n.node)!
    return { node: n.node, current: false, allowed: t.verdict !== 'no', reasons: t.reasons.filter(r => r.level === 'block').map(r => r.words), notes: t.reasons.filter(r => r.level !== 'block').map(r => r.words) }
  })
  const can = rows.filter(r => r.allowed && !r.current).map(r => r.node)
  return { sid: sidOf(g), node: g.node, running: g.status === 'running', summary: can.length ? `It can move to ${can.join(' or ')}.` : 'It cannot move to any other node.', rows }
}

// ------------------------------------------------------------------ guest drawer (Infrastructure)
function guestConfig(node: string, type: string, vmid: string) {
  const g = guestByVmid(Number(vmid)) ?? GUESTS[0]
  const lxc = g.type === 'lxc'
  const config: Record<string, any> = lxc
    ? { hostname: g.name, cores: g.cores, memory: g.memGiB * 1024, swap: 512, ostype: 'debian', arch: 'amd64', unprivileged: 1, onboot: 1, rootfs: `vm-pool:vm-${g.vmid}-disk-0,size=${g.diskGiB}G`,
        net0: `name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:${(g.vmid % 256).toString(16).padStart(2, '0').toUpperCase()},ip=${g.ip}/16,gw=10.0.0.1`, features: 'nesting=1', tags: (g.tags ?? []).join(';') }
    : { name: g.name, cores: g.cores, memory: g.memGiB * 1024, cpu: 'host', ostype: 'l26', machine: 'q35', bios: 'ovmf', scsihw: 'virtio-scsi-single', scsi0: `vm-pool:vm-${g.vmid}-disk-0,size=${g.diskGiB}G,discard=on`,
        net0: `virtio=BC:24:11:00:00:${(g.vmid % 256).toString(16).padStart(2, '0').toUpperCase()},bridge=vmbr0`, onboot: 1, agent: 'enabled=1' }
  const gpuEntries = g.gpu ? [{ key: lxc ? 'dev0' : 'hostpci0', value: lxc ? '/dev/dri/renderD128,gid=104' : '0000:0b:00.0', via: lxc ? 'devN' as const : 'hostpci' as const, device: '/dev/dri/renderD128', vendor: nodeOf(g.node).gpu?.vendor ?? 'unknown' }] : []
  return {
    guest: { node: g.node, type: g.type, vmid: g.vmid, name: g.name, running: g.status === 'running', haManaged: !!g.ha }, config, digest: 'demo-digest-' + g.vmid, secretKeys: [],
    keys: { modelled: Object.keys(config), raw: [], unknown: [], rawCount: 0, unknownCount: 0 }, pending: { keys: [], rows: [] },
    gpu: { vendors: gpuEntries.map(e => e.vendor), entries: gpuEntries, rawCount: 0, toggle: gpuEntries.length ? 'on' as const : 'none' as const, offSince: null, managed: {}, managedRaw: [] as Array<[string, string]> },
    sharers: g.gpu ? [{ device: '/dev/dri/renderD128', users: GUESTS.filter(x => x.gpu && x.node === g.node).map(x => x.name) }] : [], historyCount: 0,
  }
}
const snapshots = (vmid: string) => [
  { name: 'pre-update', description: 'Before the last package update', snaptime: Math.floor((Date.now() - 6 * DAY) / 1000), parent: null },
  { name: 'known-good', description: 'Everything working', snaptime: Math.floor((Date.now() - 24 * DAY) / 1000), parent: null },
  { name: 'current', description: 'You are here', parent: 'pre-update' },
].filter(() => Number(vmid) !== 206)
const nodeDevices = (node: string) => {
  const n = nodeOf(node)
  return { node, collectedAt: Date.now() - 4 * MIN, devices: n.gpu ? [{
    id: `${node}-gpu0`, node, kind: 'gpu' as const, name: n.gpu.name, product: n.gpu.name, purpose: n.gpu.dedicated ? 'Dedicated GPU: transcoding and compute' : 'Integrated GPU: video decode and encode', vendor: n.gpu.vendor,
    pciAddress: n.gpu.pci, paths: n.gpu.vendor === 'nvidia' ? ['/dev/nvidia0', '/dev/nvidiactl'] : ['/dev/dri/card0', '/dev/dri/renderD128'], driver: n.gpu.vendor === 'nvidia' ? 'nvidia' : n.gpu.vendor === 'intel' ? 'i915' : 'amdgpu',
    shareAs: ['lxc-dev-shared'], usedBy: GUESTS.filter(g => g.gpu && g.node === node).map(g => ({ vmid: g.vmid, type: g.type, name: g.name, running: g.status === 'running', via: 'devN', key: 'dev0' })), notes: [], needsExtraConfirm: false,
  }] : [] }
}

// ------------------------------------------------------------------ proxy, websites, VPN
const proxyCerts = () => [
  { id: 'c1', names: [`*.${DOMAIN}`, DOMAIN], expiresAt: iso(-62 * DAY), issuer: 'Let’s Encrypt (R11)', instanceId: 'npm' },
  { id: 'c2', names: [`*.${DOMAIN2}`], expiresAt: iso(-9 * DAY), issuer: 'Let’s Encrypt (R11)', instanceId: 'npm' },
  { id: 'c3', names: [`blog.${DOMAIN}`], expiresAt: iso(-12 * DAY), issuer: 'Let’s Encrypt (R11)', instanceId: 'npm' },
]
const addressOptions = () => ({ dnsConfigured: true, domains: [DOMAIN, DOMAIN2], proxies: [{ id: 'npm', name: 'Nginx Proxy Manager', kind: 'npm', status: 'ok', certificates: 'wildcard certificates cover both domains' }] })
const ghostStats = () => ({ version: '5.96.0', posts: 128, members: Math.round(840 + wobble(6, 6, 'gm')), checkedAt: Date.now() - 2 * MIN })

// ------------------------------------------------------------------ install wizard (Catalogue, Websites)
function wizardPlacement() {
  const nodes = NODES.map(n => {
    const mine = GUESTS.filter(g => g.node === n.node)
    const used = Math.round(n.mem * n.memGiB * 1024)
    return {
      node: n.node, online: true, cores: n.cores, cpuLoad: n.cpu, memTotalMb: n.memGiB * 1024, memUsedMb: used, memCommittedMb: mine.reduce((a, g) => a + g.memGiB * 1024, 0),
      bridges: [{ iface: 'vmbr0', cidr: `${n.ip}/16`, gateway: '10.0.0.1', prefix: 16 }],
      rootStorages: [{ storage: 'vm-pool', type: 'rbd', shared: true, freeGb: 1900 }, { storage: 'local-lvm', type: 'lvmthin', shared: false, freeGb: 120 }],
      verdict: { eligible: true, why: [] as string[], notes: [], score: Math.round(100 - n.mem * 60 - n.cpu * 30), storage: { storage: 'vm-pool' }, freeMemAfterMb: n.memGiB * 1024 - used - 2048, freeMemAfterLiveMb: n.memGiB * 1024 - used - 2048 },
    }
  })
  const best = nodes.slice().sort((a, b) => b.verdict.score - a.verdict.score)[0]
  return { nodes, recommendation: { node: best.node, reason: `${best.node} has the most free memory and the lightest CPU load.`, storage: 'vm-pool' }, partial: [], rule: { kind: 'pattern' as const, pattern: '[node#][last two of IP]' }, nextVmid: 308,
    naming: { settings: null, detection: null } }
}

export const MISC_ROUTES: FixtureRoute[] = [
  { path: '/api/proxmox/cluster-name', get: () => ok({ name: CLUSTER_NAME }) },
  { path: '/api/users', get: () => ok(users()) },
  { path: '/api/ha/guests/:type/:vmid', get: p => ok(haGuest(p.type, p.vmid)) },
  { path: '/api/ha/guests/:type/:vmid/preflight', get: p => ok(preflight(p.type, p.vmid)) },
  { path: '/api/infra/guest-config/guests/:node/:type/:vmid', get: p => ok(guestConfig(p.node, p.type, p.vmid)) },
  { path: '/api/infra/guest-config/guests/:node/:type/:vmid/history', get: () => ok([]) },
  { path: '/api/infra/guest-config/nodes/:node/devices', get: p => ({ success: true, data: nodeDevices(p.node), redacted: false }) },
  { path: '/api/infra/vms/:node/:vmid/:type/snapshots', get: p => ok(snapshots(p.vmid)) },
  { path: '/api/infra/tasks/:node/:upid', get: () => ok({ status: 'stopped', exitstatus: 'OK', running: false, ok: true }) },
  { path: '/api/proxy/instances/:id/certificates', get: () => ok(proxyCerts()) },
  { path: '/api/sites/address/options', get: () => ok(addressOptions()) },
  { path: '/api/sites/:id/ghost', get: () => ok(ghostStats()) },
  { path: '/api/vpn/install-pending', get: () => ({ entries: [] }) },
  { path: '/api/remote/machines/:id/:provider/firewall', get: () => ({ clusterEnabled: true, exists: false, rule: { type: 'in', action: 'ACCEPT', proto: 'udp', dport: '41641', comment: 'Tailscale direct connections' }, message: 'The cluster firewall is on and has no rule for Tailscale\u2019s direct connections. Adding one lets this machine reach its peers without a relay.' }) },
  { path: '/api/remote/machines/:id/host-key', get: () => ({ host: '10.0.2.11', port: 22, fingerprint: `SHA256:${Buffer.from(fingerprint('demo-host-key', 32).replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`, pinned: null }) },
  { path: '/api/remote/v1/machines/:id/:provider/install-preview', get: (p) => ({ machineId: p.id, provider: p.provider, profile: 'guest', tags: ['tag:server'], acceptDns: false, flags: ['--ssh=false', '--accept-dns=false'],
    steps: ['Download the client from the provider\u2019s own package repository', 'Install and start the service', 'Join the network with a one-time key (never stored)', 'Check the machine appears with its address'] }) },
  { path: '/api/remote/v1/machines/:id/:provider/settings', get: () => ({ current: { acceptDns: false, acceptRoutes: false, ssh: false, advertiseExitNode: false, exitNode: null, exitNodeAllowLan: false, subnets: [] } }) },
  { path: '/api/catalogue/wizard/transcode/hardware', get: (_p, q) => ok({ vaapi: nodeOf(q.node || 'pve-a').gpu?.vendor === 'nvidia' ? null : { names: [nodeOf(q.node || 'pve-a').gpu?.name ?? 'integrated GPU'] }, nvidia: nodeOf(q.node || 'pve-a').gpu?.vendor === 'nvidia' ? { names: [nodeOf(q.node).gpu!.name], driver: '550.127' } : null, auto: nodeOf(q.node || 'pve-a').gpu?.vendor === 'nvidia' ? 'nvidia' : 'vaapi' }) },
  { path: '/api/vpn/wg/module', get: () => ({ ok: true, reason: null, fix: null }) },
  { path: '/api/catalogue/wizard/placement', get: () => ok(wizardPlacement()) },
  { path: '/api/catalogue/wizard/arr/seerr', get: () => ok({ jobs: [] }) },
  { path: '/api/catalogue/wizard/pbs/nas', get: (_p, q) => ok(q.host ? { exports: ['/volume1/backups', '/volume1/media'], note: null } : [{ host: '10.0.0.5', label: 'nas-01', source: 'cluster', exports: ['/volume1/backups', '/volume1/media'] }]) },
  { path: '/api/ai/wizard/jobs/:id', get: () => ({ ok: true, status: 'completed', steps: [] }) },
]
void PEOPLE; void GiB; void HOUR; void seeded
