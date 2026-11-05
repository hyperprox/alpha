// =============================================================================
//  HyperProx — Updates: is it safe to restart this node's Ceph daemons?
//
//  Pure functions over what Ceph itself reports. The runner reads the pool
//  layout and asks `ceph osd ok-to-stop` before any OSD restart or node reboot;
//  these decide from those answers, and say in plain words what would go offline.
//
//  A pool with size=1 has no second copy: restarting an OSD that holds any of
//  its placement groups takes that share of the pool offline until the OSD is
//  back. A pool whose remaining copies (or EC shards) fall below min_size stops
//  accepting I/O. Either one turns the restart into a dry run.
//
//  Every answer that is incomplete — a PG map that is not ready, a pool with
//  fewer PG rows than pg_num, sources that disagree about which OSDs live on a
//  node — is "unreadable", never "nothing here".
// =============================================================================

/** Ceph's marker for an EC shard with no OSD. */
const NONE = 2147483647

export interface CephPoolInfo {
  id:          number
  name:        string
  size:        number
  minSize:     number
  pgNum:       number
  erasure:     boolean
  /** Data shards of an EC pool; null for replicated pools or when the profile could not be read. */
  k:           number | null
  m:           number | null
  /** Bytes stored (before replication), from `ceph df`; null when not reported. */
  storedBytes: number | null
}

export interface CephPgInfo {
  pgid:   string
  pool:   number
  state:  string
  up:     number[]
  /** Acting set by position; null where an EC shard has no OSD. */
  acting: (number | null)[]
}

export interface CephLayout {
  pools:       CephPoolInfo[]
  /** OSD ids under each CRUSH host bucket. */
  osdsByHost:  Record<string, number[]>
  allOsds:     number[]
  /** The hostname each OSD reports in `ceph osd metadata`. */
  osdHost:     Record<number, string>
  pgs:         CephPgInfo[]
}

export interface OsdRestartBlocker {
  pool:        string
  size:        number
  minSize:     number
  erasure:     boolean
  k:           number | null
  m:           number | null
  /** `offline`: no copy (or too few EC shards) left. `blocked`: data still there, but below min_size, so I/O stops. */
  kind:        'offline' | 'blocked'
  pgs:         number
  pgNum:       number
  percent:     number | null
  approxBytes: number | null
}

function sections(output: string, names: string[]): Record<string, string> {
  const lines = output.split('\n')
  const out: Record<string, string> = {}
  for (const name of names) {
    const a = lines.findIndex(l => l.trim() === `HP_${name}`)
    if (a < 0) continue
    let b = lines.findIndex((l, i) => i > a && /^HP_[A-Z]+$/.test(l.trim()))
    if (b < 0) b = lines.length
    out[name] = lines.slice(a + 1, b).join('\n').trim()
  }
  return out
}

function json(text: string | undefined, what: string): any {
  if (!text) throw new Error(`Ceph returned no ${what}`)
  try { return JSON.parse(text) } catch { throw new Error(`Ceph's ${what} could not be read`) }
}

function pgRows(j: any, what: string): any[] {
  if (!j || Array.isArray(j) || j.pg_ready !== true) throw new Error(`Ceph's ${what} is not ready (pg_ready is not true)`)
  if (!Array.isArray(j.pg_stats)) throw new Error(`Ceph returned no ${what}`)
  return j.pg_stats
}

function parsePg(r: any): CephPgInfo {
  const pgid = String(r.pgid)
  const num = (v: any) => Number(v)
  return {
    pgid, pool: Number(pgid.split('.')[0]), state: String(r.state ?? ''),
    up: (Array.isArray(r.up) ? r.up : []).map(num).filter((n: number) => n >= 0 && n !== NONE),
    acting: (Array.isArray(r.acting) ? r.acting : []).map(num).map((n: number) => (n >= 0 && n !== NONE ? n : null)),
  }
}

/** Reads the output of CEPH_LAYOUT_COMMAND. Throws when any part is missing or incomplete. */
export function parseCephLayout(output: string): CephLayout {
  const s = sections(output, ['POOLS', 'TREE', 'PGS', 'DF', 'META', 'EC', 'END'])
  const poolsJ = json(s.POOLS, 'pool list')
  const treeJ  = json(s.TREE, 'OSD tree')
  const pgsJ   = json(s.PGS, 'PG map')
  const dfJ    = json(s.DF, 'usage report')
  const metaJ  = json(s.META, 'OSD metadata')
  if (!Array.isArray(poolsJ)) throw new Error('Ceph returned no pool list')
  if (!Array.isArray(metaJ)) throw new Error('Ceph returned no OSD metadata')

  const profiles = new Map<string, { k: number; m: number }>()
  for (const line of (s.EC ?? '').split('\n')) {
    const m = /^(\S+)\s+(\{.*\})\s*$/.exec(line.trim())
    if (!m) continue
    try {
      const p = JSON.parse(m[2])
      const k = Number(p.k), mm = Number(p.m)
      if (Number.isInteger(k) && Number.isInteger(mm)) profiles.set(m[1], { k, m: mm })
    } catch { /* an unreadable profile leaves k unknown: counted conservatively below */ }
  }

  // `stored` is before replication. `bytes_used` is raw (after it), so it is not a stand-in.
  const stored = new Map<number, number>()
  for (const p of Array.isArray(dfJ?.pools) ? dfJ.pools : []) {
    const v = Number(p?.stats?.stored)
    if (Number.isFinite(Number(p?.id)) && p?.stats?.stored !== undefined && Number.isFinite(v)) stored.set(Number(p.id), v)
  }
  const pools: CephPoolInfo[] = poolsJ.map((p: any) => {
    const id = Number(p.pool_id ?? p.pool)
    const size = Number(p.size), minSize = Number(p.min_size), pgNum = Number(p.pg_num)
    if (![id, size, minSize, pgNum].every(Number.isFinite)) throw new Error('Ceph returned a pool without size, min_size or pg_num')
    const erasure = Number(p.type) === 3
    const prof = erasure ? profiles.get(String(p.erasure_code_profile)) : undefined
    return {
      id, name: String(p.pool_name ?? id), size, minSize, pgNum, erasure,
      k: prof?.k ?? null, m: prof?.m ?? null, storedBytes: stored.get(id) ?? null,
    }
  })

  const nodes: any[] = Array.isArray(treeJ?.nodes) ? treeJ.nodes : []
  if (!nodes.length) throw new Error('Ceph returned an empty OSD tree')
  const byId = new Map(nodes.map(n => [Number(n.id), n]))
  const osdsByHost: Record<string, number[]> = {}
  const collect = (n: any, acc: number[]) => {
    if (n?.type === 'osd') { acc.push(Number(n.id)); return }
    for (const c of Array.isArray(n?.children) ? n.children : []) collect(byId.get(Number(c)), acc)
  }
  for (const n of nodes.filter(n => n.type === 'host')) {
    const acc: number[] = []
    collect(n, acc)
    osdsByHost[String(n.name)] = [...new Set(acc)].sort((a, b) => a - b)
  }
  const allOsds = nodes.filter(n => n.type === 'osd').map(n => Number(n.id)).sort((a, b) => a - b)

  const osdHost: Record<number, string> = {}
  for (const m of metaJ) if (Number.isFinite(Number(m?.id)) && typeof m?.hostname === 'string') osdHost[Number(m.id)] = m.hostname

  const pgs = pgRows(pgsJ, 'PG map').map(parsePg)
  for (const p of pools) {
    const rows = pgs.filter(g => g.pool === p.id).length
    if (rows !== p.pgNum) throw new Error(`the PG map lists ${rows} PGs for pool "${p.name}", which has pg_num ${p.pgNum}`)
  }
  return { pools, osdsByHost, allOsds, osdHost, pgs }
}

export type NodeOsdSet = { ok: true; osds: number[] } | { ok: false; reason: string }

const fmt = (ids: Iterable<number>) => `{${[...ids].sort((a, b) => a - b).join(', ')}}`
const same = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every(x => b.has(x))

/**
 * The OSDs on a node, from three sources that must agree: the CRUSH tree (the host bucket with the node's
 * name, plus any host bucket holding an OSD that reports this host), `ceph osd metadata` hostnames, and the
 * `ceph-osd@` units on the node. Any disagreement, a failed unit listing, or units that name no OSD is a
 * refusal: an OSD that is missed is an OSD that is never assessed.
 */
export function nodeOsdSet(layout: CephLayout, node: string, units: { ok: boolean; ids: string[]; reason?: string }): NodeOsdSet {
  if (!units.ok) return { ok: false, reason: `could not list the Ceph OSD units on ${node}${units.reason ? `: ${units.reason}` : ''}` }
  const unitIds = units.ids.filter(id => /^\d+$/.test(id)).map(Number)
  if (units.ids.length && !unitIds.length) return { ok: false, reason: `${node} has ceph-osd units (${units.ids.join(', ')}) but none names an OSD id` }

  const meta = new Set(Object.entries(layout.osdHost).filter(([, h]) => h === node).map(([id]) => Number(id)))
  const crush = new Set<number>(layout.osdsByHost[node] ?? [])
  for (const ids of Object.values(layout.osdsByHost)) {
    if (ids.some(id => layout.osdHost[id] === node)) for (const id of ids) crush.add(id)
  }
  const unit = new Set(unitIds)
  const all = new Set([...meta, ...crush, ...unit])
  if (!same(all, meta) || !same(all, crush) || !same(all, unit)) {
    return { ok: false, reason: `the sources disagree about which OSDs are on ${node}: CRUSH ${fmt(crush)}, OSD metadata ${fmt(meta)}, systemd units ${fmt(unit)}` }
  }
  return { ok: true, osds: [...all].sort((a, b) => a - b) }
}

/** Every pool that would lose availability if all of `osds` were down at once. */
export function assessOsdRestart(layout: CephLayout, osds: number[]): OsdRestartBlocker[] {
  const down = new Set(osds)
  const out: OsdRestartBlocker[] = []
  for (const pool of layout.pools) {
    // Whether a PG touches the node: up ∪ acting, which errs towards "yes".
    const touched = layout.pgs.filter(p => p.pool === pool.id && [...p.up, ...p.acting].some(o => o !== null && down.has(o)))
    let offline = 0, blocked = 0
    for (const p of touched) {
      // What survives: the acting set only. An `up` OSD that is still backfilling holds no complete copy.
      const left = p.acting.filter((o): o is number => o !== null && !down.has(o)).length
      if (!pool.erasure && pool.size <= 1) { offline++; continue }
      const needed = pool.erasure ? (pool.k ?? pool.minSize) : 1
      if (left < needed) offline++
      else if (left < pool.minSize) blocked++
    }
    const hit = offline + blocked
    if (!hit) continue
    const pgNum = pool.pgNum || layout.pgs.filter(p => p.pool === pool.id).length
    const share = pgNum ? hit / pgNum : null
    out.push({
      pool: pool.name, size: pool.size, minSize: pool.minSize, erasure: pool.erasure, k: pool.k, m: pool.m,
      kind: offline > 0 ? 'offline' : 'blocked',
      pgs: hit, pgNum,
      percent: share === null ? null : Math.round(share * 1000) / 10,
      approxBytes: share === null || pool.storedBytes === null ? null : Math.round(pool.storedBytes * share),
    })
  }
  return out
}

export function formatBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`
  if (b >= 1e9)  return `${Math.round(b / 1e9)} GB`
  return `${(b / 1e9).toFixed(2)} GB`
}

/** One sentence per pool, for a person deciding whether to restart by hand. */
export function describeBlockers(blockers: OsdRestartBlocker[]): string {
  return blockers.map(b => {
    const what = b.kind === 'offline' ? 'would go offline'
      : `would stop accepting reads and writes (fewer than min_size=${b.minSize} ${b.erasure ? 'shards' : 'copies'} left)`
    const share = b.percent === null ? `${b.pgs} placement group${b.pgs === 1 ? '' : 's'}` : `${b.percent}% of it (${b.pgs} of ${b.pgNum} placement groups)`
    const size = b.approxBytes === null ? '' : `, about ${formatBytes(b.approxBytes)}`
    const kind = b.erasure
      ? `erasure-coded${b.k !== null && b.m !== null ? ` k=${b.k} m=${b.m}` : ''}, min_size=${b.minSize}`
      : `size=${b.size}, min_size=${b.minSize}`
    return `pool "${b.pool}" (${kind}): ${share}${size} ${what}`
  }).join('; ')
}

export interface OkToStop { ok: boolean; reason: string }

/** Output of `ceph osd ok-to-stop … -f json` followed by `HP_RC <exit code>`. Anything unreadable is a no. */
export function parseOsdOkToStop(output: string): OkToStop {
  const rc = /HP_RC (\d+)/.exec(output)?.[1]
  const line = output.split('\n').find(l => l.trim().startsWith('{'))
  let j: any = null
  try { j = line ? JSON.parse(line) : null } catch { j = null }
  if (j && j.ok_to_stop === true && rc === '0') return { ok: true, reason: `Ceph says it is safe (${Number(j.num_ok_pgs ?? 0)} PGs stay available)` }
  if (j && j.ok_to_stop === false) {
    const n = Number(j.num_not_ok_pgs ?? (Array.isArray(j.bad_become_inactive) ? j.bad_become_inactive.length : 0))
    return { ok: false, reason: `ceph osd ok-to-stop says no: ${n} placement group${n === 1 ? '' : 's'} are or would become unavailable` }
  }
  return { ok: false, reason: `ceph osd ok-to-stop gave no clear answer (${output.replace(/HP_RC \d+/, '').trim().slice(0, 200) || `exit ${rc ?? '?'}`})` }
}

/**
 * `ceph mon ok-to-stop` / `ceph mds ok-to-stop` answer in words, and exit 0 even for an id they do not know,
 * so only the sentence that means yes counts as yes.
 */
export function parseDaemonOkToStop(daemon: 'mon' | 'mds', output: string): OkToStop {
  const rc = /HP_RC (\d+)/.exec(output)?.[1]
  const text = output.replace(/HP_RC \d+/, '').trim()
  const yes = daemon === 'mon' ? /quorum should be preserved/i : /should be safe to stop/i
  if (rc === '0' && yes.test(text) && !/invalid|not found|does not exist/i.test(text)) return { ok: true, reason: text.slice(0, 200) }
  return { ok: false, reason: `ceph ${daemon} ok-to-stop says no: ${text.slice(0, 200) || `exit ${rc ?? '?'}`}` }
}

/** `systemctl list-units 'ceph-osd@*'` lines → ids. */
export function parseUnitIds(daemon: string, output: string): string[] {
  const re = new RegExp(`^ceph-${daemon}@([A-Za-z0-9_.-]+)\\.service`)
  return [...new Set(output.split('\n').map(l => re.exec(l.trim())?.[1]).filter((x): x is string => Boolean(x)))].sort()
}

/** Output of cephUnitsCommand: the ids, and whether the listing itself succeeded (its exit status is printed). */
export function parseUnitListing(daemon: string, output: string): { ok: boolean; ids: string[]; reason?: string } {
  const rc = /HP_RC (\d+)/.exec(output)?.[1]
  if (rc !== '0') return { ok: false, ids: [], reason: rc === undefined ? 'no exit status' : `systemctl exited ${rc}` }
  return { ok: true, ids: parseUnitIds(daemon, output) }
}

// --- Live state, for the health gate between restarts ------------------------------------------------

export interface CephState {
  flags: Set<string>
  osds:  Map<number, { up: boolean; in: boolean }>
  pgs:   Map<string, CephPgInfo>
}

/** Output of CEPH_STATE_COMMAND: `ceph osd dump` and `ceph pg dump pgs_brief`. Throws when incomplete. */
export function parseCephState(output: string): CephState {
  const s = sections(output, ['OSDS', 'PGS', 'END'])
  const dump = json(s.OSDS, 'OSD map')
  if (!Array.isArray(dump?.osds)) throw new Error('Ceph returned no OSD map')
  const flags = new Set<string>(Array.isArray(dump.flags_set) ? dump.flags_set.map(String)
    : String(dump.flags ?? '').split(',').map(f => f.trim()).filter(Boolean))
  const osds = new Map<number, { up: boolean; in: boolean }>()
  for (const o of dump.osds) osds.set(Number(o.osd), { up: Number(o.up) === 1, in: Number(o.in) === 1 })
  const pgs = new Map<string, CephPgInfo>()
  for (const r of pgRows(json(s.PGS, 'PG map'), 'PG map')) { const p = parsePg(r); pgs.set(p.pgid, p) }
  return { flags, osds, pgs }
}

/** `ceph osd dump -f json` → its flags, or null when the answer cannot be read. */
export function parseOsdFlags(output: string): Set<string> | null {
  const line = output.split('\n').find(l => l.trim().startsWith('{'))
  try {
    const d = JSON.parse(line ?? '')
    if (!Array.isArray(d?.osds)) return null
    return new Set<string>(Array.isArray(d.flags_set) ? d.flags_set.map(String) : String(d.flags ?? '').split(',').map((f: string) => f.trim()).filter(Boolean))
  } catch { return null }
}

/** PG states that mean data is at risk or unavailable, as opposed to merely being moved (remapped, backfill). */
export const RISKY_PG = /(^|\+)(degraded|undersized|down|stale|incomplete|peering|activating|unknown|inconsistent|recovery_unfound|backfill_unfound|backfill_toofull|recovery_toofull)(\+|$)/
const REDUCED = /(^|\+)(degraded|undersized)(\+|$)/

export interface RestoredResult { ok: boolean; reason: string }

/**
 * After restarting one daemon: compared by identity, not by count. Every PG active; no OSD down or out that
 * was not already; no PG at risk that was not already. After an OSD restart, that OSD itself up and in, and
 * none of the PGs it serves degraded or undersized — whatever their state before.
 */
export function judgeRestoredState(before: CephState, now: CephState, restarted?: number): RestoredResult {
  if (restarted !== undefined) {
    const o = now.osds.get(restarted)
    if (!o || !o.up) return { ok: false, reason: `osd.${restarted} is not up` }
    if (!o.in) return { ok: false, reason: `osd.${restarted} is not in` }
    const reduced = [...now.pgs.values()].filter(p => [...p.up, ...p.acting].includes(restarted) && REDUCED.test(p.state)).map(p => p.pgid)
    if (reduced.length) return { ok: false, reason: `${reduced.length} PG(s) on osd.${restarted} still degraded or undersized (${reduced.slice(0, 5).join(', ')}${reduced.length > 5 ? ', …' : ''})` }
  }
  const newlyDown = [...now.osds].filter(([id, o]) => !o.up && before.osds.get(id)?.up !== false).map(([id]) => `osd.${id}`)
  if (newlyDown.length) return { ok: false, reason: `down that were up before: ${newlyDown.join(', ')}` }
  const newlyOut = [...now.osds].filter(([id, o]) => !o.in && before.osds.get(id)?.in !== false).map(([id]) => `osd.${id}`)
  if (newlyOut.length) return { ok: false, reason: `out that were in before: ${newlyOut.join(', ')}` }
  const inactive = [...now.pgs.values()].filter(p => !p.state.split('+').includes('active')).map(p => p.pgid)
  if (inactive.length) return { ok: false, reason: `${inactive.length} PG(s) not active (${inactive.slice(0, 5).join(', ')})` }
  const risky = [...now.pgs.values()].filter(p => RISKY_PG.test(p.state) && !(before.pgs.get(p.pgid) && RISKY_PG.test(before.pgs.get(p.pgid)!.state))).map(p => p.pgid)
  if (risky.length) return { ok: false, reason: `${risky.length} PG(s) at risk that were not before (${risky.slice(0, 5).join(', ')})` }
  const unclean = [...now.pgs.values()].filter(p => p.state.split('+').filter(x => !['scrubbing', 'deep'].includes(x)).sort().join('+') !== 'active+clean').length
  return { ok: true, reason: unclean ? `back to the state before the restart: all PGs active, none newly at risk (${unclean} not clean, as before)` : 'all OSDs up, all PGs active+clean' }
}
