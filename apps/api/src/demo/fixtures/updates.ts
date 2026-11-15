// Demo fixtures: the Updates page's target tree (every node, guest, compose project and app that can be updated, with a
// few pending updates, a security one and a node that needs a reboot) and HyperProx's own self-update panel.
// The tree is built from the same inventory the page's other tables read, so the numbers agree.
import type { FixtureRoute } from './types'
import { iso, HOUR, DAY } from './data'
import { inventory } from './apps'

const ok = (data: unknown) => data
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const isCeph = (name: string) => name.startsWith('ceph')
type Pkg = { name: string; from: string | null; to: string; security?: boolean }
type Target = Record<string, unknown>

function targets() {
  const inv = inventory() as unknown as { nodes: any[]; guests: any[]; cluster: unknown }
  const out: Target[] = []
  const cephNodes = inv.nodes.filter(n => n.cephPending)
  const cephPkgs = cephNodes.flatMap(n => (n.pending as Pkg[]).filter(p => isCeph(p.name)).map(p => ({ ...p, name: `${p.name} (${n.node})` })))
  if (cephPkgs.length) {
    out.push({ id: 'ceph', kind: 'ceph', parent: null, label: 'Ceph', sub: `to 19.2.3-pve3 on ${cephNodes.map(n => n.node).join(', ')}, then mon, mgr and OSD restarts in order`,
      pending: cephPkgs.length, security: 0, selectable: true, everything: true, packages: cephPkgs })
  }
  // Run order: the node that hosts HyperProx goes last.
  const ordered = [...inv.nodes].sort((a, b) => Number(a.isSelf) - Number(b.isSelf))
  for (const n of ordered) {
    const own = (n.pending as Pkg[]).filter(p => !isCeph(p.name))
    const nid = `node:${n.node}`
    out.push({ id: nid, kind: 'node', parent: null, label: n.node, node: n.node, sub: own.length ? `apt-get ${n.policy.upgrade} · ${plural(own.length, 'package')}` : 'up to date',
      pending: own.length, security: own.filter(p => p.security).length, selectable: own.length > 0, everything: own.length > 0, needsReboot: n.rebootRequired || n.rebootPending, packages: own,
      notes: [...(n.isSelf ? ['Runs HyperProx itself, so it is upgraded last.'] : []), ...(n.cephPending ? ['Ceph packages are pending here too: they move with the Ceph item, which runs first.'] : [])] })
    for (const p of own) {
      out.push({ id: `node:${n.node}:pkg:${p.name}`, kind: 'node-pkg', parent: nid, label: p.name, node: n.node, sub: `${p.from ?? 'new'} → ${p.to}${p.security ? ' · security' : ''}`,
        pending: 1, security: p.security ? 1 : 0, selectable: true, packages: [p] })
    }
    if (n.rebootRequired || n.rebootPending) {
      out.push({ id: `node:${n.node}:reboot`, kind: 'node-reboot', parent: nid, node: n.node, label: 'Reboot (with HA maintenance)', sub: 'needs reboot', pending: 0, security: 0, selectable: true, everything: false, needsReboot: true })
    }
  }
  for (const g of [...inv.guests].sort((a, b) => ordered.findIndex(n => n.node === a.node) - ordered.findIndex(n => n.node === b.node) || a.vmid - b.vmid)) {
    const gid = `guest:${g.vmid}`
    const self = g.vmid === 104
    const pending = g.pending as Pkg[]
    const compose = (g.compose ?? []) as Array<{ name: string; dir: string; images: Array<{ image: string; current: string; latest: string | null }> }>
    const apps = (g.apps ?? []) as Array<Record<string, any>>
    const imgNew = (c: { images: Array<{ current: string; latest: string | null }> }) => c.images.filter(i => i.latest && i.latest !== i.current).length
    const appsNew = apps.filter(a => a.latest && a.latest !== a.installed)
    const why = !g.managed ? (g.unmanagedReason === 'windows' ? 'Windows updates itself; HyperProx does not touch it.' : g.unmanagedReason === 'no-apt' ? 'It has no apt to run.' : 'It is not running.') : !pending.length ? 'no packages pending' : undefined
    out.push({
      id: gid, kind: 'guest', parent: `node:${g.node}`, label: `${g.vmid} ${g.name}${self ? ' (HyperProx)' : ''}`, node: g.node, vmid: g.vmid, guestType: g.type,
      sub: !g.managed ? why : pending.length ? `apt-get upgrade · ${plural(pending.length, 'package')}` : 'packages up to date',
      pending: pending.length + compose.reduce((a, c) => a + imgNew(c), 0) + appsNew.length,
      security: pending.filter(p => p.security).length + appsNew.filter(a => a.isSecurity).length,
      selectable: !why, ...(why ? { blocked: why } : {}), everything: !why, needsReboot: g.rebootRequired, packages: g.managed ? pending : [],
      ...(self ? { notes: ['HyperProx itself: its packages are updated last, through a handoff from its node, and the page may reconnect.'] } : {}),
    })
    if (g.managed) {
      for (const p of pending) {
        out.push({ id: `guest:${g.vmid}:pkg:${p.name}`, kind: 'guest-pkg', parent: gid, label: p.name, vmid: g.vmid, node: g.node, sub: `${p.from ?? 'new'} → ${p.to}${p.security ? ' · security' : ''}`,
          pending: 1, security: p.security ? 1 : 0, selectable: !self, ...(self ? { blocked: 'HyperProx itself is updated as a whole, not package by package' } : {}), packages: [p] })
      }
    }
    for (const c of compose) {
      const fresh = imgNew(c)
      out.push({ id: `guest:${g.vmid}:compose:${c.name}`, kind: 'compose', parent: gid, vmid: g.vmid, node: g.node, label: `${c.name} (${c.dir})`,
        sub: fresh ? `${plural(fresh, 'newer image')} · compose pull, then up` : 'no newer image seen', pending: fresh, security: 0, selectable: true, everything: true, images: c.images,
        notes: ['In the policy (docker: auto).'] })
    }
    for (const a of appsNew) {
      out.push({ id: `guest:${g.vmid}:app:${a.key}`, kind: 'app', parent: gid, vmid: g.vmid, node: g.node, label: a.name, sub: `${a.installed} → ${a.latest}${a.isSecurity ? ' · security' : ''}`,
        pending: 1, security: a.isSecurity ? 1 : 0, selectable: true, everything: a.mode === 'auto', notes: [a.how, ...(a.notes ?? []).slice(0, 2).map((x: any) => `${x.version}: ${x.text}`)] })
    }
  }
  return { refreshedAt: iso(8 * HOUR), cluster: inv.cluster, targets: out }
}

// ---- HyperProx's own update (the panel at the top of Updates; the layout chip reads the summary) --------------------
const INSTALLED = { version: '1.8.0', sha: '7f3c2a91d4e5b6a7c8d9e0f1a2b3c4d5e6f70812', describe: 'v1.8.0', branch: 'main', git: true }
function selfStatus() {
  return {
    installed: INSTALLED, running: { version: INSTALLED.version, commit: INSTALLED.sha },
    settings: { channel: 'stable', checkEveryHours: 12, notify: true, requireSigned: true, includePrereleases: false, autoInstall: false, window: { days: [3], start: '03:00', end: '06:00' } },
    locks: {}, autoInstallBlocked: null,
    check: { checkedAt: iso(3 * HOUR), source: 'hyperprox.dev', available: null, note: 'You are on the newest release of the stable channel.', error: null },
    job: null,
    whatsNew: { job: 'demo-self-update', label: 'v1.8.0', finishedAt: iso(9 * DAY), entries: [{ id: '2026-11-04', date: '2026-11-04', version: 'v1.8.0', title: 'Load balancing, and a Updates page that lists everything',
      sections: [{ kind: 'new' as const, heading: 'New', items: ['Load balancing shows how evenly the cluster is used and proposes the fewest moves to even it out.', 'The Updates page lists every node, guest, compose project and app, so you can tick exactly what to update.'] },
        { kind: 'improved' as const, heading: 'Improved', items: ['Plug-in pages for Nextcloud, Homepage, the backup server and routers.'] }] }] },
    upstream: { repoUrl: 'https://github.com/hyperprox/hyperprox', mirrorUrl: null, trustedKeys: true },
  }
}

export const UPDATE_ROUTES: FixtureRoute[] = [
  { path: '/api/updates/targets', get: () => ok(targets()) },
  { path: '/api/self-update/status', get: () => selfStatus() },
  { path: '/api/self-update/job', get: () => ({ job: null }) },
  { path: '/api/self-update/summary', get: () => ({ available: null, updating: false }) },
  { path: '/api/self-update/preview', get: () => ({ target: null, refusals: [{ code: 'up-to-date', text: 'You are already on the newest release.' }], warnings: [], steps: [], disk: { freeMiB: 18_400, needMiB: 600 } }) },
]
void DAY
