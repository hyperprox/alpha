// =============================================================================
//  HyperProx — Updates: is it safe to restart this node's Ceph daemons?
//
//  Pure functions over what Ceph itself reports. The runner reads the pool
//  layout and asks `ceph osd ok-to-stop` before any OSD restart; these decide
//  from those answers, and say in plain words what would go offline.
//
//  A pool with size=1 has no second copy: restarting an OSD that holds any of
//  its placement groups takes that share of the pool offline until the OSD is
//  back. A replicated pool whose remaining copies fall below min_size stops
//  accepting I/O. Either one turns the restart into a dry run.
// =============================================================================

export interface CephPoolInfo {
  id:          number
  name:        string
  size:        number
  minSize:     number
  pgNum:       number
  /** Bytes stored (before replication), from `ceph df`; null when not reported. */
  storedBytes: number | null
}

export interface CephPgInfo { pgid: string; pool: number; osds: number[] }

export interface CephLayout {
  pools:       CephPoolInfo[]
  /** OSD ids under each CRUSH host bucket. */
  osdsByHost:  Record<string, number[]>
  allOsds:     number[]
  pgs:         CephPgInfo[]
}

export interface OsdRestartBlocker {
  pool:        string
  size:        number
  minSize:     number
  /** `offline`: no copy left (size=1). `blocked`: copies left, but fewer than min_size, so I/O stops. */
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

/** Reads the output of CEPH_LAYOUT_COMMAND. Throws when any part is missing: no guess stands in for an answer. */
export function parseCephLayout(output: string): CephLayout {
  const s = sections(output, ['POOLS', 'TREE', 'PGS', 'DF', 'END'])
  const poolsJ = json(s.POOLS, 'pool list')
  const treeJ  = json(s.TREE, 'OSD tree')
  const pgsJ   = json(s.PGS, 'PG map')
  const dfJ    = json(s.DF, 'usage report')
  if (!Array.isArray(poolsJ)) throw new Error('Ceph returned no pool list')

  const stored = new Map<number, number>()
  for (const p of Array.isArray(dfJ?.pools) ? dfJ.pools : []) {
    const v = Number(p?.stats?.stored ?? p?.stats?.bytes_used)
    if (Number.isFinite(p?.id) && Number.isFinite(v)) stored.set(Number(p.id), v)
  }
  const pools: CephPoolInfo[] = poolsJ.map((p: any) => {
    const id = Number(p.pool_id ?? p.pool)
    const size = Number(p.size), minSize = Number(p.min_size), pgNum = Number(p.pg_num)
    if (![id, size, minSize, pgNum].every(Number.isFinite)) throw new Error('Ceph returned a pool without size, min_size or pg_num')
    return { id, name: String(p.pool_name ?? id), size, minSize, pgNum, storedBytes: stored.get(id) ?? null }
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

  const rows: any[] = Array.isArray(pgsJ) ? pgsJ : Array.isArray(pgsJ?.pg_stats) ? pgsJ.pg_stats : []
  if (!rows.length && pools.some(p => p.pgNum > 0)) throw new Error('Ceph returned an empty PG map')
  const pgs: CephPgInfo[] = rows.map(r => {
    const pgid = String(r.pgid)
    const osds = [...new Set([...(r.up ?? []), ...(r.acting ?? [])].map(Number).filter(n => n >= 0 && n !== 2147483647))]
    return { pgid, pool: Number(pgid.split('.')[0]), osds }
  })
  return { pools, osdsByHost, allOsds, pgs }
}

/** The node's OSDs: its CRUSH host bucket, or, when there is none by that name, the OSD units found on it. */
export function osdsOnNode(layout: CephLayout, node: string, unitIds: number[]): number[] {
  const fromTree = layout.osdsByHost[node]
  if (fromTree) return fromTree
  return unitIds.filter(id => layout.allOsds.includes(id)).sort((a, b) => a - b)
}

/** Every pool that would lose availability if all of `osds` were down at once. */
export function assessOsdRestart(layout: CephLayout, osds: number[]): OsdRestartBlocker[] {
  const down = new Set(osds)
  const out: OsdRestartBlocker[] = []
  for (const pool of layout.pools) {
    const pgs = layout.pgs.filter(p => p.pool === pool.id && p.osds.some(o => down.has(o)))
    const offline = pgs.filter(p => p.osds.every(o => down.has(o))).length
    const blocked = pgs.filter(p => {
      const left = p.osds.filter(o => !down.has(o)).length
      return left > 0 && left < pool.minSize
    }).length
    const hit = pool.size <= 1 ? pgs.length : offline + blocked
    if (!hit) continue
    const pgNum = pool.pgNum || layout.pgs.filter(p => p.pool === pool.id).length
    const share = pgNum ? hit / pgNum : null
    out.push({
      pool: pool.name, size: pool.size, minSize: pool.minSize,
      kind: pool.size <= 1 || offline > 0 ? 'offline' : 'blocked',
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
    const what = b.kind === 'offline' ? 'would go offline' : `would stop accepting reads and writes (fewer than min_size=${b.minSize} copies left)`
    const share = b.percent === null ? `${b.pgs} placement group${b.pgs === 1 ? '' : 's'}` : `${b.percent}% of it (${b.pgs} of ${b.pgNum} placement groups)`
    const size = b.approxBytes === null ? '' : `, about ${formatBytes(b.approxBytes)}`
    return `pool "${b.pool}" (size=${b.size}, min_size=${b.minSize}): ${share}${size} ${what}`
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
