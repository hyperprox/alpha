// Live acceptance for the guest config editor, opt-in: HPX_LIVE=1.
//
// Runs only against throwaway guests the tester created and tagged `hyperprox-test`; every guest is checked for
// the tag before anything is written, and the test refuses otherwise. It talks to Proxmox through `pvesh` over
// SSH to a node (the same API handlers the token reaches), so it needs no token.
//
//   HPX_LIVE=1 HPX_LIVE_NODES='nodeA=addr,nodeB=addr' HPX_LIVE_CT=nodeA:vmid HPX_LIVE_VM=nodeB:vmid \
//   HPX_LIVE_STORAGE=<storage id> node --import tsx --test test/guest-config-live.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { GuestConfigService, type GuestPve, type NodeShell } from '../src/lib/guest-config/service'
import { MemoryHistoryStore } from '../src/lib/guest-config/history/store'

const LIVE = process.env.HPX_LIVE === '1'
const NODES = Object.fromEntries((process.env.HPX_LIVE_NODES ?? '').split(',').filter(Boolean).map(x => x.split('=')))
const anyAddr = () => Object.values(NODES)[0] as string
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function ssh(addr: string, cmd: string, input?: string): string {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=/tmp/hpx-live-known-hosts', `root@${addr}`, cmd], { input, encoding: 'utf8', maxBuffer: 32 << 20 })
}

function pvesh(verb: string, path: string, params: Record<string, string> = {}): any {
  const [enc, qs] = path.split('?')
  const p = decodeURIComponent(enc)   // pvesh takes the path as written; the HTTP client sends it encoded
  const extra = new URLSearchParams(qs ?? '')
  const args = [...Object.entries(params), ...extra.entries()].map(([k, v]) => `--${k} ${q(v)}`).join(' ')
  const out = ssh(anyAddr(), `pvesh ${verb} ${q(p)} ${args} --output-format json 2>&1`).trim()
  if (/^(\d{3} |Unknown option|unable to parse|Parameter verification failed|.*error)/i.test(out) && !out.startsWith('{') && !out.startsWith('[') && !out.startsWith('"')) throw new Error(`pvesh ${verb} ${p}: ${out}`)
  try { return out ? JSON.parse(out.split('\n').filter(l => /^[[{"]|^null$/.test(l)).pop() ?? 'null') : null } catch { return out }
}

const pve: GuestPve = {
  get: async (path) => pvesh('get', path),
  put: async (path, params) => pvesh('set', path, params),
  post: async (path, params = {}) => pvesh('create', path, params),
}
const shell: NodeShell = { run: async (node, command) => { const a = NODES[node]; if (!a) return null; try { return { code: 0, output: ssh(a, 'bash -s', command) } } catch (e: any) { return { code: e.status ?? 1, output: String(e.stdout ?? '') } } } }

function service() {
  const audits: any[] = []
  return { s: new GuestConfigService({ pve, shell, history: new MemoryHistoryStore(), audit: async (a, r, d) => { audits.push({ a, r, d }) }, timeouts: { taskMs: 180_000, haMs: 180_000, pollMs: 2000 } }), audits }
}

const parse = (v?: string) => { const [node, vmid] = (v ?? '').split(':'); return { node, vmid: Number(vmid) } }
const OWNER = 'live-test@example.invalid'

async function mustBeThrowaway(type: 'lxc' | 'qemu', node: string, vmid: number) {
  const cfg = await pve.get(`/nodes/${node}/${type}/${vmid}/config`)
  assert.match(String(cfg.tags ?? ''), /hyperprox-test/, `${type} ${vmid} is not tagged hyperprox-test: refusing to write to it`)
  return cfg
}

async function applyOk(s: GuestConfigService, g: any, change: any, confirm: any = {}) {
  const p = await s.preview(OWNER, g, change)
  assert.deepEqual(p.plan.errors, [], `${change.kind}: ${p.plan.errors.join(' | ')}`)
  const r = await s.apply(OWNER, p.id, confirm)
  assert.equal(r.ok, true, `${change.kind}: ${JSON.stringify(r.outcome?.problems ?? r.restart)}`)
  return { p, r }
}

test('live: container — edit, mount point add/remove, GPU on a real iGPU, toggle off and on, revert', { skip: !LIVE }, async () => {
  const { node, vmid } = parse(process.env.HPX_LIVE_CT)
  const storage = process.env.HPX_LIVE_STORAGE!
  const before = await mustBeThrowaway('lxc', node, vmid)
  const { s, audits } = service()
  const G = { node, type: 'lxc' as const, vmid }
  const unknownBefore = { tty: before.tty, timezone: before.timezone, arch: before.arch }

  // 1. cores, memory, tags
  const e1 = await applyOk(s, G, { kind: 'edit', edit: { cores: 2, memory: 640, tags: ['delete-me', 'hyperprox-test', 'hpx-live'] } })
  let cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  assert.equal(Number(cfg.cores), 2); assert.equal(Number(cfg.memory), 640); assert.match(cfg.tags, /hpx-live/)
  assert.deepEqual({ tty: cfg.tty, timezone: cfg.timezone, arch: cfg.arch }, unknownBefore, 'unmodelled keys survived')
  console.log(`[live] edit ok; raw ${e1.r.outcome!.rawBefore}→${e1.r.outcome!.rawAfter}, unmodelled ${e1.r.outcome!.unknownBefore}→${e1.r.outcome!.unknownAfter}`)

  // 2. a volume mount point: add, then remove (its volume is kept as unused), then revert the removal
  await applyOk(s, G, { kind: 'edit', edit: { mounts: { add: [{ kind: 'volume', storage, sizeGb: 1, mp: '/mnt/hpx-live' }] } } })
  cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  const vol = String(cfg.mp0 ?? '')
  assert.match(vol, new RegExp(`^${storage}:vm-${vmid}-disk-\\d+,mp=/mnt/hpx-live`))
  const rm = await applyOk(s, G, { kind: 'edit', edit: { mounts: { remove: ['mp0'] } } })
  cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  assert.equal(cfg.mp0, undefined)
  assert.ok(Object.entries(cfg).some(([k, v]) => /^unused\d+$/.test(k) && v === vol.split(',')[0]), 'the volume is kept as unused')
  await applyOk(s, G, { kind: 'revert', historyId: rm.r.historyId, which: 'before' })
  cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  assert.equal(String(cfg.mp0).split(',')[0], vol.split(',')[0], 'the same volume is mounted again')
  await applyOk(s, G, { kind: 'edit', edit: { mounts: { remove: ['mp0'] } } })
  console.log('[live] mount point add/remove/revert ok')

  // 3. GPU: the node's real iGPU, by devN, with the container's own render gid; started so it can be read.
  pvesh('create', `/nodes/${node}/lxc/${vmid}/status/start`)
  for (let i = 0; i < 30 && (await pve.get(`/nodes/${node}/lxc/${vmid}/status/current`)).status !== 'running'; i++) await new Promise(r => setTimeout(r, 2000))
  const det = await s.gpuDetail(G)
  const gpu = det.devices.find(d => d.kind === 'gpu')
  assert.ok(gpu, 'the node has a GPU in its inventory')
  console.log(`[live] node GPU: ${gpu!.name}; container groups ${JSON.stringify(det.groups)}`)
  const grant = await applyOk(s, G, { kind: 'gpu-grant', grant: { deviceId: gpu!.id, renderGid: det.groups?.render ?? det.groups?.video } }, { name: before.hostname })
  console.log(`[live] grant pending: ${grant.r.pendingKeys.join(',') || '(applied live)'}`)
  let rs = await applyOk(s, G, { kind: 'restart', after: grant.p.id })
  assert.deepEqual(rs.r.restart!.devices.map(d => [d.path, d.seen]), [['/dev/dri/renderD128', true]])
  console.log(`[live] after restart: ${JSON.stringify(rs.r.restart!.devices)}; raw survived ${rs.r.restart!.rawSurvived}`)

  // edit the entry (add card0 too), then the toggle: off (later → pending), restart; on, restart.
  const edit = await applyOk(s, G, { kind: 'gpu-grant', grant: { deviceId: gpu!.id, renderGid: det.groups?.render ?? 0, includeCard: true, videoGid: det.groups?.video ?? 44 } }, { name: before.hostname })
  await applyOk(s, G, { kind: 'restart', after: edit.p.id })
  const off = await applyOk(s, G, { kind: 'gpu-off' })
  assert.ok((await s.view(G)).pending.keys.length > 0 || off.r.pendingKeys.length === 0, 'off is pending while the container runs, or applied live')
  rs = await applyOk(s, G, { kind: 'restart', after: off.p.id })
  assert.ok(rs.r.restart!.devices.every(d => d.seen === false), JSON.stringify(rs.r.restart!.devices))
  const on = await applyOk(s, G, { kind: 'gpu-on' })
  rs = await applyOk(s, G, { kind: 'restart', after: on.p.id })
  assert.ok(rs.r.restart!.devices.every(d => d.seen === true), JSON.stringify(rs.r.restart!.devices))
  console.log('[live] GPU off/on round trip ok')
  // and remove what HyperProx added
  const revoke = await applyOk(s, G, { kind: 'gpu-revoke' }, { name: before.hostname })
  rs = await applyOk(s, G, { kind: 'restart', after: revoke.p.id })
  assert.ok(rs.r.restart!.devices.every(d => d.seen === false))
  cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  assert.ok(!Object.keys(cfg).some(k => /^dev\d+$/.test(k)))

  // 4. revert the first edit
  await applyOk(s, G, { kind: 'revert', historyId: e1.r.historyId, which: 'before' })
  cfg = await pve.get(`/nodes/${node}/lxc/${vmid}/config`)
  assert.equal(Number(cfg.cores), Number(before.cores)); assert.equal(Number(cfg.memory), Number(before.memory))
  pvesh('create', `/nodes/${node}/lxc/${vmid}/status/stop`)
  assert.ok(audits.every(a => a.a === 'guest_config.apply'))
  console.log(`[live] container done: ${audits.length} audited writes`)
})

test('live: VM — cores, memory, tags; revert', { skip: !LIVE || !process.env.HPX_LIVE_VM }, async () => {
  const { node, vmid } = parse(process.env.HPX_LIVE_VM)
  const before = await mustBeThrowaway('qemu', node, vmid)
  const { s } = service()
  const G = { node, type: 'qemu' as const, vmid }
  const cores = Number(before.cores) === 2 ? 1 : 2, memory = Number(before.memory) === 384 ? 256 : 384
  const tags = /hpx-live/.test(String(before.tags)) ? ['delete-me', 'hyperprox-test'] : ['delete-me', 'hyperprox-test', 'hpx-live']
  const e = await applyOk(s, G, { kind: 'edit', edit: { cores, memory, tags } })
  let cfg = await pve.get(`/nodes/${node}/qemu/${vmid}/config`)
  assert.equal(Number(cfg.cores), cores); assert.equal(Number(cfg.memory), memory)
  assert.equal(cfg.smbios1, before.smbios1); assert.equal(cfg.vmgenid, before.vmgenid)
  await applyOk(s, G, { kind: 'revert', historyId: e.r.historyId, which: 'before' })
  cfg = await pve.get(`/nodes/${node}/qemu/${vmid}/config`)
  assert.equal(Number(cfg.cores), Number(before.cores)); assert.equal(Number(cfg.memory), Number(before.memory)); assert.equal(cfg.tags, before.tags)
  console.log('[live] VM edit and revert ok')
})

test('live: device inventory, read-only, on every listed node', { skip: !LIVE || process.env.HPX_LIVE_DEVICES !== '1' }, async () => {
  const { s } = service()
  for (const node of Object.keys(NODES)) {
    const inv = await s.inventory(node, true)
    console.log(`[live] ${node}: ${inv.problem ?? `${inv.devices.length} devices`}`)
    for (const d of inv.devices) console.log(`[live]   ${d.name} | ${[d.vendorProduct, d.serial ? 'serial' : '', d.pciAddress ?? d.port ?? ''].filter(Boolean).join(' ')} | ${d.shareAs.join(',')} | used by ${d.usedBy.map(u => `${u.type}:${u.vmid}${u.running ? '(on)' : ''} via ${u.via}`).join(', ') || 'none'}${d.needsExtraConfirm ? ' | EXTRA CONFIRM' : ''}`)
  }
})
