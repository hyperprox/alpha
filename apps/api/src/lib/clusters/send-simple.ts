// =============================================================================
//  HyperProx — Send files, the simple way
//
//  The owner picks what (from the home library) and where (one of the other server's libraries, by the name
//  Plex gives it), then presses Send. Everything else is found on the nodes:
//
//    - The other server's libraries: writable mounts on its node that are bind-mounted into a container running
//      Plex, named by the Plex library that uses each one. Plex is asked on the node, inside its container
//      (pct exec ... curl to Plex on localhost), with the token read from that container's Preferences.xml at
//      that moment. The token is passed on stdin, never as an argument, is removed from anything printed, and
//      never reaches HyperProx. Without Plex (or when Plex does not answer), the folder's own name is used.
//    - The home library: found the same way on the home nodes (a shared filesystem every home node mounts),
//      plus any folder already allowed for copies.
//    - Which home node sends: one with a tailnet or WireGuard address that reaches the other node on port 22.
//
//  First-time setup (the allowed copy folders on both ends, one sending key per library, and a host-key
//  confirmation when one is needed) is one request, re-confirmed with the master password (lib/roles.ts).
//  The copy itself is the reviewed engine in files.ts, unchanged: vault-only keys that can only add files in
//  one folder, real-path checks at preview, launch, resume and in the run script, and no file ever replaced.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { clusterRow, cleanRoot, ClusterRefusal, HOME_ID, updateCluster } from './registry'
import { runInCluster } from './context'
import { pveFromEnv } from '../pve-env'
import { pinnedKey, pinSource, isConfirmedSource, confirmPin } from '../hostkey-pins'
import { probeHostKey } from '../node-exec'
import { auditCredentialUse } from '../audit'
import {
  q, rootFor, containmentScript, parseContainment, liveNodeRunner, sendKey, setupSending, previewCopy, startCopy, jobStore, kickCopies,
  fmtDuration, plexScan, privateAddress, type NodeRunner, type JobRow, type SendKey,
} from './files'

// ---------------------------------------------------------------------------
//  What a node tells us
// ---------------------------------------------------------------------------

export interface MountRow { source: string; target: string; fstype: string; rw: boolean }
export interface CtMount { ct: string; source: string; target: string }
export interface PlexSection { ct: string; key: string; title: string; type: string; locations: string[] }
export interface NodeFacts {
  node: string
  mounts: MountRow[]
  df: Array<{ target: string; avail: number; size: number }>
  links: Array<{ iface: string; address: string }>
  ctMounts: CtMount[]
  plexCts: string[]
  plexSections: PlexSection[]
  plexTrouble: Array<{ ct: string; why: string }>
  reach: string[]
}

export interface Library {
  id: string
  name: string
  node: string
  path: string
  /** The Plex container and library section that show this folder, when Plex was found. */
  ct: string | null
  sectionKey: string | null
  /** The same folder as Plex sees it inside its container. */
  containerPath: string | null
  free: number | null
  size: number | null
  from: 'plex' | 'folder'
}

const PREFS = [
  '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
  '/var/snap/plexmediaserver/common/Library/Application Support/Plex Media Server/Preferences.xml',
  '/config/Library/Application Support/Plex Media Server/Preferences.xml',
]
/** Runs inside a container: print Plex's Preferences.xml, or fail when this is not a Plex container. */
const PREFS_IN_CT = `for f in ${PREFS.map(p => `"${p}"`).join(' ')}; do [ -f "$f" ] && { cat "$f"; exit 0; }; done; exit 1`

/**
 * Read the token of Plex in container $1 into $T. The file is read through pct exec into a shell variable and
 * the token is cut out by sed reading stdin, so it is never an argument of any command (not visible in ps).
 * Returns 1 when the container has no Plex, 2 when it has Plex but no token.
 */
const PLEX_TOKEN_FN = [
  'plex_token() {',
  `  local p; T=""; p="$(pct exec "$1" -- sh -c ${q(PREFS_IN_CT)} 2>/dev/null)" || return 1`,
  `  T="$(printf '%s' "$p" | sed -n 's/.*PlexOnlineToken="\\([^"]*\\)".*/\\1/p' | head -n1)"; p=""`,
  '  [ -n "$T" ] || return 2',
  '}',
].join('\n')

/** Ask Plex in container $1 for URL $2, the token on curl's stdin (-H @-). Prints the answer with the token cut out. */
const PLEX_GET_FN = [
  'plex_get() {',
  `  local x; x="$(printf 'X-Plex-Token: %s\\n' "$T" | pct exec "$1" -- curl -s -f -m 15 -H @- "$2" 2>/dev/null)" || return 1`,
  `  printf '%s' "\${x//"$T"/}"`,
  '}',
].join('\n')

/** Everything discovery needs from one node, read-only. `reach` lists addresses to test on port 22 from here. */
export function factsScript(reach: string[] = []): string {
  const addrs = reach.filter(a => /^[0-9a-fA-F:.]{2,45}$/.test(a))
  return [
    'set -u', 'export LC_ALL=C', 'echo "HPX-FACTS 1"',
    `while read -r s t f o _; do printf 'MNT\\t%s\\t%s\\t%s\\t%s\\n' "$s" "$t" "$f" "\${o%%,*}"; done < /proc/self/mounts`,
    `timeout 15 df -P -B1 2>/dev/null | awk 'NR>1 {print "DF\\t" $6 "\\t" $4 "\\t" $2}'`,
    `ip -o addr show 2>/dev/null | awk '{split($4,a,"/"); print "LINK\\t" $2 "\\t" a[1]}'`,
    ...addrs.map(a => `timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/22"' _ ${q(a)} 2>/dev/null && printf 'REACH\\t%s\\n' ${q(a)}`),
    'command -v pct >/dev/null 2>&1 || exit 0',
    PLEX_TOKEN_FN,
    PLEX_GET_FN,
    `for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do`,
    `  case "$id" in ''|*[!0-9]*) continue;; esac`,
    `  M="$(pct config "$id" 2>/dev/null | grep -E '^mp[0-9]+: ')" || continue`,
    `  printf '%s\\n' "$M" | while IFS= read -r l; do printf 'CTMP\\t%s\\t%s\\n' "$id" "$l"; done`,
    '  plex_token "$id"; rc=$?',
    '  [ "$rc" -eq 1 ] && continue',
    `  printf 'PLEX\\t%s\\n' "$id"`,
    `  [ "$rc" -eq 0 ] || { printf 'PLEXWHY\\t%s\\tno-token\\n' "$id"; continue; }`,
    `  X="$(plex_get "$id" http://127.0.0.1:32400/library/sections)" || { T=""; printf 'PLEXWHY\\t%s\\tno-answer\\n' "$id"; continue; }`,
    '  T=""',
    `  printf 'PLEXXML\\t%s\\t%s\\n' "$id" "$(printf '%s' "$X" | tr '\\n\\t' '  ')"`,
    'done',
  ].join('\n')
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
const xmlText = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&')
const attr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? xmlText(m[1]) : null }

/** The libraries in Plex's /library/sections answer: key, title, type and the folders each one shows. */
export function parsePlexSections(ct: string, xml: string): PlexSection[] {
  const out: PlexSection[] = []
  for (const m of String(xml ?? '').matchAll(/<Directory\b([^>]*?)(\/>|>([\s\S]*?)<\/Directory>)/g)) {
    const key = attr(m[1], 'key'), title = attr(m[1], 'title'), type = attr(m[1], 'type') ?? ''
    if (!key || !/^\d{1,6}$/.test(key) || !title) continue
    const locations = [...(m[3] ?? '').matchAll(/<Location\b([^>]*)\/?>/g)].map(l => attr(l[1], 'path')).filter((p): p is string => !!p && p.startsWith('/'))
    out.push({ ct, key, title: title.slice(0, 80), type, locations })
  }
  return out
}

/** Read the facts script's answer. Only the fields below are kept; nothing else a node printed is passed on. */
export function parseFacts(node: string, out: string): NodeFacts {
  const f: NodeFacts = { node, mounts: [], df: [], links: [], ctMounts: [], plexCts: [], plexSections: [], plexTrouble: [], reach: [] }
  for (const line of String(out ?? '').split('\n')) {
    const p = line.split('\t')
    switch (p[0]) {
      case 'MNT': if (p.length >= 5) f.mounts.push({ source: unescapeMount(p[1]), target: unescapeMount(p[2]), fstype: p[3], rw: p[4] === 'rw' }); break
      case 'DF': if (p.length >= 4 && /^\d+$/.test(p[2])) f.df.push({ target: p[1], avail: Number(p[2]), size: Number(p[3]) || 0 }); break
      case 'LINK': if (p.length >= 3) f.links.push({ iface: p[1].replace(/@.*$/, ''), address: p[2] }); break
      case 'REACH': if (p[1]) f.reach.push(p[1]); break
      case 'CTMP': {
        if (!/^\d+$/.test(p[1] ?? '')) break
        const m = /^mp\d+:\s*([^,]+),(?:.*,)?mp=([^,]+)/.exec(p.slice(2).join('\t'))
        if (m && m[1].startsWith('/') && m[2].startsWith('/')) f.ctMounts.push({ ct: p[1], source: m[1].replace(/\/+$/, '') || '/', target: m[2].replace(/\/+$/, '') || '/' })
        break
      }
      case 'PLEX': if (/^\d+$/.test(p[1] ?? '')) f.plexCts.push(p[1]); break
      case 'PLEXWHY': if (/^\d+$/.test(p[1] ?? '')) f.plexTrouble.push({ ct: p[1], why: p[2] === 'no-token' ? 'Plex there is not signed in, so its libraries could not be read' : 'Plex there did not answer' }); break
      case 'PLEXXML': if (/^\d+$/.test(p[1] ?? '')) f.plexSections.push(...parsePlexSections(p[1], p.slice(2).join('\t'))); break
    }
  }
  return f
}

// ---------------------------------------------------------------------------
//  From facts to libraries
// ---------------------------------------------------------------------------

const NETWORK_FS = /^(nfs4?|cifs|smb3|ceph|fuse\.ceph(-fuse)?|glusterfs|fuse\.glusterfs|9p|virtiofs)$/
const LOCAL_FS = /^(ext[234]|xfs|btrfs|zfs|f2fs)$/
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const under = (p: string, root: string) => root === '/' || p === root || p.startsWith(root + '/')

export function mountOf(p: string, mounts: MountRow[]): MountRow | null {
  return mounts.filter(m => under(p, m.target)).sort((a, b) => b.target.length - a.target.length)[0] ?? null
}

/** "movies" -> "Movies", "tv" -> "TV Shows", "kids_films" -> "Kids Films". */
export function friendlyName(folder: string): string {
  const base = folder.split('/').filter(Boolean).pop() ?? folder
  const k = base.toLowerCase().replace(/[^a-z0-9]/g, '')
  const known: Record<string, string> = { movies: 'Movies', films: 'Movies', movie: 'Movies', tv: 'TV Shows', tvshows: 'TV Shows', shows: 'TV Shows', series: 'TV Shows', music: 'Music', photos: 'Photos', pictures: 'Photos' }
  if (known[k]) return known[k]
  return base.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60) || base
}

/**
 * The libraries on one node. `writable` (a destination) also needs the folder's own mount to be read-write and
 * not the node's root filesystem, so a copy can never fill the system disk. `plexElsewhere`: another node of
 * the same cluster has Plex, so this node's plain network mounts are not offered as libraries of their own.
 */
export function librariesOf(f: NodeFacts, writable: boolean, plexElsewhere = false): Library[] {
  const out: Library[] = []
  const add = (name: string, path: string, from: Library['from'], plex: { ct: string; key: string; containerPath: string } | null) => {
    let clean: string
    try { clean = cleanRoot(path) } catch { return }
    const m = mountOf(clean, f.mounts)
    if (writable && (!m || !m.rw || m.target === '/' || !(NETWORK_FS.test(m.fstype) || LOCAL_FS.test(m.fstype)))) return
    if (out.some(l => l.path === clean)) return
    const df = m ? f.df.find(d => d.target === m.target) : undefined
    out.push({ id: sha(`${f.node}:${clean}`), name, node: f.node, path: clean, ct: plex?.ct ?? null, sectionKey: plex?.key ?? null, containerPath: plex?.containerPath ?? null, free: df?.avail ?? null, size: df?.size ?? null, from })
  }
  for (const s of f.plexSections) {
    for (const loc of s.locations) {
      const bind = f.ctMounts.filter(c => c.ct === s.ct && under(loc, c.target)).sort((a, b) => b.target.length - a.target.length)[0]
      if (!bind) continue
      const rest = bind.target === '/' ? loc : loc.slice(bind.target.length)
      add(s.locations.length > 1 ? `${s.title} (${friendlyName(loc)})` : s.title, bind.source + rest, 'plex', { ct: s.ct, key: s.key, containerPath: loc })
    }
  }
  // Plex is there but could not be asked: name its folders by their own names.
  for (const c of f.ctMounts.filter(c => f.plexCts.includes(c.ct) && !f.plexSections.some(s => s.ct === c.ct))) add(friendlyName(c.source), c.source, 'folder', null)
  // No Plex on this node: shared or network mounts outside the system folders.
  if (!f.plexCts.length && !plexElsewhere) {
    for (const m of f.mounts.filter(m => NETWORK_FS.test(m.fstype) && (!writable || m.rw))) add(friendlyName(m.target), m.target, 'folder', null)
  }
  return out
}

/** Tailnet (Tailscale's 100.64.0.0/10 or fd7a:115c:a1e0::/48), WireGuard or NetBird addresses, IPv4 first. */
export function linkAddresses(f: NodeFacts): string[] {
  const tun = /^(tailscale\d*|wg[\w-]*|wt\d*|nb-[\w-]*|zt[\w-]*)$/
  const hits = f.links.filter(l => {
    const a = l.address.toLowerCase()
    if (/^127\.|^::1$|^fe80:/.test(a)) return false
    const v4 = /^100\.(\d+)\./.exec(a)
    return tun.test(l.iface) || (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) || a.startsWith('fd7a:115c:a1e0:')
  }).map(l => l.address)
  return [...new Set(hits)].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
}

// ---------------------------------------------------------------------------
//  The plan: what is there, who sends, and what first-time setup would do
// ---------------------------------------------------------------------------

export interface SendDeps {
  runner: NodeRunner
  /** Online nodes of a cluster. */
  nodes(clusterId: string): Promise<string[]>
  /** The address HyperProx reaches that node on, the host key pinned for it, and whether the owner confirmed it. */
  hostKey(clusterId: string, node: string): Promise<{ address: string | null; pinned: string | null; confirmed: boolean }>
  /** Confirm a pinned host key: it must be what the node presents right now. */
  confirmHostKey(clusterId: string, node: string, fingerprint: string): Promise<void>
  /** Make and install one sending key (files.ts setupSending). */
  setupKey(o: { src: string; dst: string; dstNode: string; root: string; by: string; dstAddress: string }): Promise<void>
  keyFor(src: string, dst: string, dstNode: string, root: string): Promise<SendKey | null>
}

export const liveSendDeps: SendDeps = {
  runner: liveNodeRunner,
  async nodes(clusterId) {
    const rows = await runInCluster(clusterId, () => pveFromEnv().fetchStrict<any[]>('/nodes'))
    return (rows ?? []).filter(n => n?.status === 'online').map(n => String(n.node)).sort()
  },
  async hostKey(clusterId, node) {
    const address = await liveNodeRunner.sshAddress(clusterId, node)
    if (!address) return { address: null, pinned: null, confirmed: false }
    const [pinned, src] = await Promise.all([pinnedKey(address, 22), pinSource(address, 22)])
    return { address, pinned, confirmed: !!pinned && isConfirmedSource(src) }
  },
  async confirmHostKey(clusterId, node, fingerprint) {
    const address = await liveNodeRunner.sshAddress(clusterId, node)
    if (!address) throw new ClusterRefusal(`No address is known for ${node}.`)
    await confirmPin(address, 22, fingerprint, (h, p) => probeHostKey(h, p))
  },
  async setupKey(o) { await setupSending(o) },
  keyFor: sendKey,
}

let active: SendDeps | null = null
/** Tests swap in fakes here; everything below uses sendDeps() unless given deps. */
export function setSendDeps(d: SendDeps | null): void { active = d }
export function sendDeps(): SendDeps { return active ?? liveSendDeps }

export interface HostKeyToConfirm { node: string; fingerprint: string }

export interface SendPlan {
  at: number
  dst: string
  libraries: Library[]
  sources: Library[]
  sourceNode: string | null
  /** The address of each destination node that the source node reaches. */
  links: Record<string, string>
  problems: string[]
  hostKeys: HostKeyToConfirm[]
  /** What first-time setup would do, in words; empty when everything is in place. */
  steps: string[]
  ready: boolean
}

const PLAN_MS = 15 * 60_000
const plans = new Map<string, SendPlan>()
export function forgetSendPlans(): void { plans.clear(); held.clear() }

async function factsOf(clusterId: string, node: string, reach: string[], deps: SendDeps): Promise<NodeFacts | null> {
  try { return parseFacts(node, (await deps.runner.run(clusterId, node, factsScript(reach), 90_000)).output) } catch { return null }
}

/** Look at both ends. Read-only: it changes nothing anywhere. */
export async function discoverSend(dstId: string, deps: SendDeps = sendDeps(), o: { fresh?: boolean } = {}): Promise<SendPlan> {
  const dRow = clusterRow(dstId)
  if (!dRow || dRow.kind !== 'remote') throw new ClusterRefusal('Send files goes from home to another server. Open it from that server.', 'not-found')
  const cached = plans.get(dstId)
  if (cached && !o.fresh && Date.now() - cached.at < PLAN_MS) return { ...cached, ...(await readiness(cached, deps)) }

  const problems: string[] = []
  const dstNodes = await deps.nodes(dstId).catch(() => [] as string[])
  if (!dstNodes.length) problems.push(`${dRow.name} is not answering, so its libraries could not be read.`)
  const dstFacts = (await Promise.all(dstNodes.map(n => factsOf(dstId, n, [], deps)))).filter((f): f is NodeFacts => !!f)
  if (dstNodes.length && !dstFacts.length) problems.push(`HyperProx has no working login for ${dRow.name}'s node${dstNodes.length > 1 ? 's' : ''} yet. Add one under Edit server, Nodes and logins.`)
  const libraries = dstFacts.flatMap(f => librariesOf(f, true, dstFacts.some(o => o.plexCts.length > 0)))
  for (const f of dstFacts) for (const t of f.plexTrouble) problems.push(`${f.node}: ${t.why}; its folders are shown by their own names.`)

  // Addresses on each destination node that another server could reach it on: its tailnet/WireGuard addresses,
  // and the address HyperProx itself uses when that is a private one.
  const candidates: Record<string, string[]> = {}
  for (const f of dstFacts) {
    const own = await deps.runner.sshAddress(dstId, f.node).catch(() => null)
    candidates[f.node] = [...new Set([...linkAddresses(f), ...(own && privateAddress(own) ? [own] : [])])]
  }
  const allCandidates = [...new Set(Object.values(candidates).flat())]

  const homeNodes = await deps.nodes(HOME_ID).catch(() => [] as string[])
  const homeFacts = (await Promise.all(homeNodes.map(n => factsOf(HOME_ID, n, allCandidates, deps)))).filter((f): f is NodeFacts => !!f)
  const homeRow = clusterRow(HOME_ID)!
  const sources: Library[] = []
  for (const l of homeFacts.flatMap(f => librariesOf(f, false, homeFacts.some(o => o.plexCts.length > 0)))) if (!sources.some(s => s.path === l.path)) sources.push(l)
  for (const r of homeRow.allowedRoots) if (!sources.some(s => s.path === r)) sources.push({ id: sha(`home:${r}`), name: friendlyName(r), node: '', path: r, ct: null, sectionKey: null, containerPath: null, free: null, size: null, from: 'folder' })
  if (!homeFacts.length) problems.push('HyperProx has no working login for any home node, so it cannot read your library. Add one in Settings, Setup checklist.')
  else if (!sources.length) problems.push('No media library was found on your home nodes. Allow a folder under Files, advanced, first.')

  // The sender: the home node that reaches the most destination nodes (ties: the first by name).
  const reachCount = (f: NodeFacts) => Object.values(candidates).filter(c => c.some(a => f.reach.includes(a))).length
  const best = [...homeFacts].sort((a, b) => reachCount(b) - reachCount(a) || a.node.localeCompare(b.node))[0]
  const links: Record<string, string> = {}
  let sourceNode: string | null = null
  if (best && reachCount(best) > 0) {
    sourceNode = best.node
    for (const [n, c] of Object.entries(candidates)) { const a = c.find(x => best.reach.includes(x)); if (a) links[n] = a }
  } else if (homeFacts.length && dstFacts.length) {
    problems.push(`None of your home nodes can reach ${dRow.name} over a private link (Tailscale or WireGuard). Put one home node on the same private network, then look again.`)
  }
  const reachable = libraries.filter(l => links[l.node])
  if (sourceNode && reachable.length < libraries.length) problems.push(`Some of ${dRow.name}'s nodes cannot be reached from ${sourceNode}; their libraries are left out.`)
  if (dstFacts.length && !libraries.length) problems.push(`No writable media library was found on ${dRow.name}. HyperProx looks for network or local disks that a Plex container uses.`)

  const plan: SendPlan = { at: Date.now(), dst: dstId, libraries: sourceNode ? reachable : libraries, sources, sourceNode, links, problems, hostKeys: [], steps: [], ready: false }
  plans.set(dstId, plan)
  return { ...plan, ...(await readiness(plan, deps)) }
}

/** What is still missing for this plan, in words, and which host keys need confirming. */
async function readiness(plan: SendPlan, deps: SendDeps): Promise<Pick<SendPlan, 'steps' | 'hostKeys' | 'ready'>> {
  const dRow = clusterRow(plan.dst)!, home = clusterRow(HOME_ID)!
  const steps: string[] = [], hostKeys: HostKeyToConfirm[] = []
  if (!plan.sourceNode || !plan.libraries.length || !plan.sources.length) return { steps, hostKeys, ready: false }
  const newSrc = plan.sources.filter(s => !home.allowedRoots.includes(s.path))
  if (newSrc.length) steps.push(`Let HyperProx copy from your home library: ${newSrc.map(s => s.name).join(', ')}.`)
  const newDst = plan.libraries.filter(l => !dRow.allowedRoots.includes(l.path))
  if (newDst.length) steps.push(`Let HyperProx add files to ${dRow.name}'s ${newDst.map(l => l.name).join(', ')}.`)
  const needKey: Library[] = []
  for (const l of plan.libraries) {
    const k = await deps.keyFor(HOME_ID, plan.dst, l.node, l.path).catch(() => null)
    if (!k || k.dstAddress !== plan.links[l.node]) needKey.push(l)
  }
  if (needKey.length) steps.push(`Make ${needKey.length === 1 ? 'a sending key' : `${needKey.length} sending keys, one per library`}, kept in the vault. Each can only add files to its own folder on ${dRow.name}, and cannot delete anything.`)
  if (needKey.length) steps.push(`Send from ${plan.sourceNode}, which reaches ${dRow.name} over the private link.`)
  for (const n of new Set(plan.libraries.map(l => l.node))) {
    const hk = await deps.hostKey(plan.dst, n)
    if (hk.pinned && !hk.confirmed) hostKeys.push({ node: n, fingerprint: hk.pinned })
  }
  if (hostKeys.length) steps.push(`Confirm ${hostKeys.map(h => h.node).join(' and ')}'s identity key (shown below), so HyperProx is sure it is talking to the right machine.`)
  return { steps, hostKeys, ready: steps.length === 0 }
}

async function planFor(dstId: string, deps: SendDeps): Promise<SendPlan> {
  const p = plans.get(dstId)
  if (p && Date.now() - p.at < PLAN_MS) return { ...p, ...(await readiness(p, deps)) }
  return discoverSend(dstId, deps)
}

// ---------------------------------------------------------------------------
//  First-time setup: one re-confirmed request
// ---------------------------------------------------------------------------

/**
 * Do everything the plan's steps say, in order, and nothing else: allowed folders on both ends, host keys the
 * owner confirmed in this same request, then one sending key per library. Stops at the first refusal.
 */
export async function setupSend(dstId: string, by: string, confirmHostKeys: string[], deps: SendDeps = sendDeps()): Promise<{ words: string; plan: SendPlan }> {
  const plan = await planFor(dstId, deps)
  if (!plan.sourceNode) throw new ClusterRefusal(plan.problems[0] ?? 'No home node can send to that server yet.')
  if (!plan.libraries.length) throw new ClusterRefusal(plan.problems[0] ?? 'No library was found on that server.')
  if (!plan.sources.length) throw new ClusterRefusal(plan.problems[0] ?? 'No library was found at home.')
  const dRow = clusterRow(dstId)!, home = clusterRow(HOME_ID)!

  // Host keys first: nothing is changed unless every key that needs it was confirmed in this request.
  const missing = plan.hostKeys.filter(h => !confirmHostKeys.includes(h.fingerprint))
  if (missing.length) throw new ClusterRefusal(`Confirm ${missing.map(h => `${h.node}'s identity key (${h.fingerprint})`).join(' and ')} first. Nothing was changed.`, 'confirm')
  for (const h of plan.hostKeys) await deps.confirmHostKey(dstId, h.node, h.fingerprint)

  const srcRoots = [...new Set([...home.allowedRoots, ...plan.sources.map(s => s.path)])]
  const dstRoots = [...new Set([...dRow.allowedRoots, ...plan.libraries.map(l => l.path)])]
  if (srcRoots.length > 20 || dstRoots.length > 20) throw new ClusterRefusal('That would allow more than 20 folders on one server. Remove some under Files, advanced, first.')
  if (srcRoots.length !== home.allowedRoots.length) await updateCluster(HOME_ID, { allowedRoots: srcRoots })
  if (dstRoots.length !== dRow.allowedRoots.length) await updateCluster(dstId, { allowedRoots: dstRoots })

  let made = 0
  for (const l of plan.libraries) {
    const k = await deps.keyFor(HOME_ID, dstId, l.node, l.path).catch(() => null)
    if (k && k.dstAddress === plan.links[l.node]) continue
    await deps.setupKey({ src: HOME_ID, dst: dstId, dstNode: l.node, root: l.path, by, dstAddress: plan.links[l.node] })
    made++
  }
  await auditCredentialUse('cluster.files.setup', `cluster:${dstId}`, { by, sourceNode: plan.sourceNode, libraries: plan.libraries.length, keysMade: made, hostKeysConfirmed: plan.hostKeys.length })
  const after = { ...plan, ...(await readiness(plan, deps)) }
  return { words: `Ready. Your home library can now be sent to ${dRow.name}'s ${plan.libraries.map(l => l.name).join(', ')}.`, plan: after }
}

// ---------------------------------------------------------------------------
//  Browse and search the home library
// ---------------------------------------------------------------------------

export interface SendPick { name: string; path: string; dir: boolean; size: number | null }

function sourceRootFor(plan: SendPlan, p: string): string {
  const home = clusterRow(HOME_ID)!
  const root = rootFor(p, [...new Set([...home.allowedRoots, ...plan.sources.map(s => s.path)])])
  if (!root) throw new ClusterRefusal(`${p} is not inside your home library.`)
  return root
}

async function browseNode(plan: SendPlan, deps: SendDeps): Promise<string> {
  if (plan.sourceNode) return plan.sourceNode
  const n = plan.sources.find(s => s.node)?.node ?? (await deps.nodes(HOME_ID).catch(() => []))[0]
  if (!n) throw new ClusterRefusal('No home node answers right now.')
  return n
}

/** Folder sizes: CephFS keeps them as an attribute (instant); elsewhere du, with 20 seconds for the whole folder. */
const DIR_SIZES = (dir: string) => [
  `cd -- ${dir} || exit 0`, 'S0=$SECONDS',
  `find . -mindepth 1 -maxdepth 1 -type d -not -name '.*' -print0 2>/dev/null | head -z -n 500 | while IFS= read -r -d '' d; do`,
  `  s="$(getfattr --only-values --absolute-names -n ceph.dir.rbytes -- "$d" 2>/dev/null)"`,
  `  if [ -z "$s" ] && [ $((SECONDS - S0)) -lt 20 ]; then s="$(timeout 10 du -sb -- "$d" 2>/dev/null | cut -f1)"; fi`,
  `  printf 'DSIZE\\t%s\\t%s\\n' "\${s:-}" "\${d#./}"`,
  'done',
].join('\n')

export async function browseSend(dstId: string, p: string, deps: SendDeps = sendDeps()): Promise<{ path: string | null; roots: SendPick[]; entries: SendPick[]; up: string | null }> {
  const plan = await planFor(dstId, deps)
  const roots: SendPick[] = plan.sources.map(s => ({ name: s.name, path: s.path, dir: true, size: null }))
  if (!p) return { path: null, roots, entries: [], up: null }
  const target = cleanRoot(p)
  const root = sourceRootFor(plan, target)
  const node = await browseNode(plan, deps)
  const r = await deps.runner.run(HOME_ID, node, [
    containmentScript(target, root, true),
    `P="$(realpath -e -- ${q(target)})" || exit 0`,
    `find "$P" -mindepth 1 -maxdepth 1 -not -name '.*' -printf 'E\\t%y\\t%s\\t%f\\n' 2>/dev/null | head -2000`,
    DIR_SIZES('"$P"'),
  ].join('\n'), 120_000)
  parseContainment(r.output.split('\n').find(l => /^(OK|NO-|OUTSIDE|NOT-DIR)/.test(l)) ?? '', 'your home library', target)
  const sizes = new Map(r.output.split('\n').filter(l => l.startsWith('DSIZE\t')).map(l => l.split('\t')).map(x => [x.slice(2).join('\t'), x[1] ? Number(x[1]) : null] as const))
  const entries = r.output.split('\n').filter(l => l.startsWith('E\t')).map(l => l.split('\t')).filter(x => x.length >= 4 && /^[dfl]$/.test(x[1]))
    .filter(x => x[1] !== 'l')
    .map(([, t, s, ...n]) => { const name = n.join('\t'); return { name, path: `${target}/${name}`, dir: t === 'd', size: t === 'd' ? sizes.get(name) ?? null : Number(s) || 0 } })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { path: target, roots, entries, up: target === root ? null : target.replace(/\/[^/]+$/, '') }
}

/** Find by name in the whole home library: folders and files whose name contains the words, at most 200. */
export async function searchSend(dstId: string, query: string, deps: SendDeps = sendDeps()): Promise<SendPick[]> {
  const words = String(query ?? '').trim()
  if (words.length < 2 || words.length > 60) throw new ClusterRefusal('Type 2 to 60 characters to search.')
  if (/[*?[\]\\\u0000-\u001f]/.test(words)) throw new ClusterRefusal('Search for plain words (no * ? [ ] or \\).')
  const plan = await planFor(dstId, deps)
  if (!plan.sources.length) return []
  const node = await browseNode(plan, deps)
  const pattern = `*${words}*`
  const r = await deps.runner.run(HOME_ID, node, [
    ...plan.sources.map(s => `R="$(realpath -e -- ${q(s.path)} 2>/dev/null)" && timeout 30 find "$R" -mindepth 1 -maxdepth 4 -name '.*' -prune -o \\( -type d -o -type f \\) -iname ${q(pattern)} -printf 'S\\t%y\\t%s\\t%p\\n' 2>/dev/null | head -200`),
  ].join('\n'), 120_000)
  const out: SendPick[] = []
  for (const x of r.output.split('\n').filter(l => l.startsWith('S\t')).map(l => l.split('\t'))) {
    const path = x.slice(3).join('\t')
    if (!path.startsWith('/') || out.some(o => o.path === path)) continue
    try { sourceRootFor(plan, path) } catch { continue }
    out.push({ name: path.split('/').pop() ?? path, path, dir: x[1] === 'd', size: x[1] === 'd' ? null : Number(x[2]) || 0 })
  }
  return out.slice(0, 200)
}

// ---------------------------------------------------------------------------
//  Preview: sizes, what is already there, time, room
// ---------------------------------------------------------------------------

export interface ItemPreview { path: string; name: string; files: number; bytes: number; skippedFiles: number; already: boolean }
export interface SendPreview {
  previewId: string; library: Library; items: ItemPreview[]; files: number; bytes: number; already: number; skippedFiles: number
  seconds: number; speed: number; speedMeasured: boolean; words: string; ready: boolean; steps: string[]; hostKeys: HostKeyToConfirm[]
}

/** Until a copy to that server has finished, the estimate assumes this (a typical home upload over a tailnet). */
export const DEFAULT_SPEED = 7.5 * 1024 * 1024

/** Bytes a second, from the last copies to that server that ran long enough to say (median of up to five). */
export function linkSpeed(dst: string, jobs: JobRow[]): { speed: number; measured: boolean } {
  const rates = jobs.filter(j => j.dstCluster === dst && j.state === 'done' && j.startedAt && j.finishedAt && Number(j.preview?.bytes) >= 50 * 1024 * 1024)
    .sort((a, b) => +new Date(b.finishedAt!) - +new Date(a.finishedAt!)).slice(0, 5)
    .map(j => Number(j.preview.bytes) / Math.max(1, (+new Date(j.finishedAt!) - +new Date(j.startedAt!)) / 1000)).sort((a, b) => a - b)
  if (!rates.length) return { speed: DEFAULT_SPEED, measured: false }
  return { speed: rates[Math.floor(rates.length / 2)], measured: true }
}

/** 14.2 GB, 950 MB, 3.1 TB: one decimal under 100. */
export function sizeWords(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${i === 0 || v >= 100 ? Math.round(v) : Number(v.toFixed(1))} ${u[i]}`
}

/** "3 items, 14.2 GB, about 32 min; 1 already there and will be skipped" */
export function previewWords(p: { items: number; bytes: number; seconds: number; already: number; skippedFiles: number }): string {
  const sending = p.items - p.already
  if (sending <= 0) return `${p.items === 1 ? 'It is' : `All ${p.items} are`} already there. Nothing to send.`
  const time = p.seconds < 60 ? 'under a minute' : `about ${fmtDuration(p.seconds)}`
  let w = `${sending} item${sending === 1 ? '' : 's'}, ${sizeWords(p.bytes)}, ${time}`
  if (p.already) w += `; ${p.already} already there and will be skipped`
  else if (p.skippedFiles) w += `; ${p.skippedFiles} file${p.skippedFiles === 1 ? ' is' : 's are'} already there and will be skipped`
  return w
}

const MAX_ITEMS = 20
interface Held { id: string; owner: string; at: number; dst: string; library: Library; items: ItemPreview[]; sourceNode: string }
const held = new Map<string, Held>()

/** Lists the files of each picked item at home and of the same names in the library, through HyperProx's own logins. */
function listScript(items: Array<{ path: string; root: string }>): string {
  return items.map((it, i) => [
    `echo "ITEM ${i}"`, containmentScript(it.path, it.root, false),
    `P="$(realpath -e -- ${q(it.path)} 2>/dev/null)" && { if [ -d "$P" ]; then find "$P" -type f -printf 'F\\t%s\\t%P\\n' 2>/dev/null | head -n 200000; else printf 'F\\t%s\\t\\n' "$(stat -c %s -- "$P")"; fi; }`,
  ].join('\n')).join('\n')
}
function existingScript(lib: string, names: string[]): string {
  return [containmentScript(lib, lib, true), ...names.map((n, i) => [
    `echo "ITEM ${i}"`, `T=${q(`${lib}/${n}`)}`,
    `if [ -d "$T" ]; then find "$T" -type f -printf 'F\\t%s\\t%P\\n' 2>/dev/null | head -n 200000; elif [ -e "$T" ]; then printf 'F\\t0\\t\\n'; fi`,
  ].join('\n'))].join('\n')
}
function filesByItem(out: string): Map<number, Map<string, number>> {
  const m = new Map<number, Map<string, number>>(); let cur = -1
  for (const l of out.split('\n')) {
    const it = /^ITEM (\d+)$/.exec(l)
    if (it) { cur = Number(it[1]); m.set(cur, new Map()); continue }
    if (cur >= 0 && l.startsWith('F\t')) { const x = l.split('\t'); m.get(cur)!.set(x.slice(2).join('\t'), Number(x[1]) || 0) }
  }
  return m
}

export async function previewSend(owner: string, dstId: string, picks: string[], libraryId: string, deps: SendDeps = sendDeps()): Promise<SendPreview> {
  if (!Array.isArray(picks) || !picks.length) throw new ClusterRefusal('Pick something to send.')
  if (picks.length > MAX_ITEMS) throw new ClusterRefusal(`Pick at most ${MAX_ITEMS} things at once.`)
  const plan = await planFor(dstId, deps)
  const lib = plan.libraries.find(l => l.id === libraryId)
  if (!lib) throw new ClusterRefusal('That library is no longer there. Look again.', 'not-found')
  if (!plan.sourceNode) throw new ClusterRefusal(plan.problems[0] ?? 'No home node can send to that server.')
  const paths = [...new Set(picks.map(p => cleanRoot(p)))]
  const items = paths.map(path => ({ path, root: sourceRootFor(plan, path) }))
  for (const it of items) if (it.path === it.root) throw new ClusterRefusal('Pick folders or files inside a library, not the whole library.')
  const names = items.map(it => it.path.split('/').pop()!)
  if (new Set(names).size !== names.length) throw new ClusterRefusal('Two of the picked things have the same name; they would land in the same place. Send them separately.')
  for (const [a, b] of items.flatMap(a => items.map(b => [a, b] as const))) if (a !== b && b.path.startsWith(a.path + '/')) throw new ClusterRefusal(`${b.path.split('/').pop()} is inside ${a.path.split('/').pop()}, which is already picked.`)

  const src = await deps.runner.run(HOME_ID, plan.sourceNode, listScript(items), 10 * 60_000)
  for (const [i, it] of items.entries()) {
    const block = src.output.split(/^ITEM \d+$/m)[i + 1] ?? ''
    parseContainment(block.split('\n').find(l => /^(OK|NO-|OUTSIDE|NOT-DIR)/.test(l)) ?? '', 'your home library', it.path)
  }
  const dst = await deps.runner.run(dstId, lib.node, existingScript(lib.path, names), 10 * 60_000)
  parseContainment(dst.output.split('\n').find(l => /^(OK|NO-|OUTSIDE|NOT-DIR)/.test(l)) ?? '', lib.name, lib.path)
  const have = filesByItem(src.output), there = filesByItem(dst.output)
  const out: ItemPreview[] = items.map((it, i) => {
    const s = have.get(i) ?? new Map(), d = there.get(i) ?? new Map()
    let files = 0, bytes = 0, skipped = 0
    for (const [rel, size] of s) { if (d.has(rel)) skipped++; else { files++; bytes += size } }
    return { path: it.path, name: names[i], files, bytes, skippedFiles: skipped, already: s.size > 0 && files === 0 }
  })
  const total = out.reduce((a, x) => ({ files: a.files + x.files, bytes: a.bytes + x.bytes, skipped: a.skipped + x.skippedFiles }), { files: 0, bytes: 0, skipped: 0 })
  if (lib.free !== null && total.bytes > lib.free) throw new ClusterRefusal(`Not enough room in ${lib.name}: this needs ${sizeWords(total.bytes)} and ${sizeWords(lib.free)} is free.`)
  const { speed, measured } = linkSpeed(dstId, await jobStore().list().catch(() => [] as JobRow[]))
  const seconds = Math.round(total.bytes / speed)
  const already = out.filter(x => x.already).length
  const id = randomUUID()
  held.set(id, { id, owner, at: Date.now(), dst: dstId, library: lib, items: out, sourceNode: plan.sourceNode })
  for (const [k, v] of held) if (Date.now() - v.at > PLAN_MS) held.delete(k)
  return {
    previewId: id, library: lib, items: out, files: total.files, bytes: total.bytes, already, skippedFiles: total.skipped, seconds, speed, speedMeasured: measured,
    words: previewWords({ items: out.length, bytes: total.bytes, seconds, already, skippedFiles: total.skipped }), ready: plan.ready, steps: plan.steps, hostKeys: plan.hostKeys,
  }
}

// ---------------------------------------------------------------------------
//  Send
// ---------------------------------------------------------------------------

/** One copy job per picked item, through the reviewed engine (its own preview, checks and audit). */
export async function sendNow(owner: string, previewId: string, deps: SendDeps = sendDeps()): Promise<JobRow[]> {
  const h = held.get(previewId)
  if (!h || h.owner !== owner) throw new ClusterRefusal('No such preview. Pick again.', 'not-found')
  if (Date.now() - h.at > PLAN_MS) { held.delete(previewId); throw new ClusterRefusal('That preview is older than 15 minutes. Look again.') }
  const plan = await planFor(h.dst, deps)
  if (!plan.ready) throw new ClusterRefusal('Sending to that server is not set up yet.', 'confirm')
  held.delete(previewId)
  const lib = h.library
  const out: JobRow[] = []
  for (const it of h.items.filter(x => !x.already)) {
    const p = await previewCopy(owner, { src: { cluster: HOME_ID, node: h.sourceNode, path: it.path }, dst: { cluster: h.dst, node: lib.node, path: lib.path }, speedKBps: 0, plexScan: !!lib.sectionKey }, deps.runner)
    out.push(await startCopy(p.previewId, owner, undefined, {
      simple: true, item: it.name, library: { id: lib.id, name: lib.name, node: lib.node, ct: lib.ct, sectionKey: lib.sectionKey, containerPath: lib.containerPath },
    }))
  }
  kickCopies()
  return out
}

// ---------------------------------------------------------------------------
//  After a copy: ask that library's Plex to scan just what arrived
// ---------------------------------------------------------------------------

/** The node-side scan: the token is read inside the node, passed to curl on stdin, and only the HTTP code is printed. */
export function plexScanScript(ct: string, sectionKey: string, containerPath: string | null): string {
  if (!/^\d{1,9}$/.test(ct) || !/^\d{1,6}$/.test(sectionKey)) throw new Error('Not a container or library number.')
  const url = `http://127.0.0.1:32400/library/sections/${sectionKey}/refresh${containerPath ? `?path=${encodeURIComponent(containerPath)}` : ''}`
  return [
    'set -u', PLEX_TOKEN_FN,
    `plex_token ${ct}; rc=$?`,
    '[ "$rc" -eq 1 ] && { echo "PLEX-GONE"; exit 0; }',
    '[ "$rc" -eq 0 ] || { echo "PLEX-NOTOKEN"; exit 0; }',
    `C="$(printf 'X-Plex-Token: %s\\n' "$T" | pct exec ${ct} -- curl -s -o /dev/null -m 20 -w '%{http_code}' -H @- ${q(url)} 2>/dev/null)"; T=""`,
    'echo "PLEX-HTTP ${C:-000}"',
  ].join('\n')
}

/** Ask the library's Plex to scan the copied folder; answer in words ("Added to Movies"). Never throws. */
export async function scanLibraryAfterCopy(job: JobRow, runner: NodeRunner = liveNodeRunner): Promise<string> {
  const lib = job.preview?.library
  const name = String(lib?.name ?? 'the library')
  if (!lib?.ct || !lib?.sectionKey) return `Copied into ${name}.`
  try {
    const item = String(job.srcPath.split('/').pop() ?? '')
    const r = await runner.run(job.dstCluster, String(lib.node || job.dstNode), plexScanScript(String(lib.ct), String(lib.sectionKey), lib.containerPath ? `${lib.containerPath}/${item}` : null), 60_000)
    const code = /PLEX-HTTP (\d{3})/.exec(r.output)?.[1]
    if (code && /^2/.test(code)) return `Added to ${name}.`
    if (/PLEX-NOTOKEN/.test(r.output)) return `Copied into ${name}. Plex there is not signed in, so it was not asked to scan; it will find the files at its next scan.`
    if (/PLEX-GONE/.test(r.output)) return `Copied into ${name}. Plex was not found in its container any more, so it was not asked to scan.`
    return `Copied into ${name}. Plex did not take the scan request${code ? ` (it answered ${code})` : ''}; it will find the files at its next scan.`
  } catch {
    return `Copied into ${name}. Plex could not be asked to scan just now; it will find the files at its next scan.`
  }
}

/** The CopyRunner's after-copy step: simple-flow jobs scan their one library; others keep the old behaviour. */
export async function afterCopyScan(clusterId: string, job?: JobRow): Promise<string | null> {
  if (job?.preview?.library) return scanLibraryAfterCopy(job)
  return plexScan(clusterId)
}
