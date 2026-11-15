// =============================================================================
//  HyperProx — Nextcloud: reading what occ and the OCS API answer
//
//  Everything a guest or a Nextcloud returns is untrusted text. Each parser
//  takes only the fields it knows, of the types it expects, cut to a length,
//  and drops the rest. A parser never throws on odd input: it returns what it
//  could read and the page says what it could not.
// =============================================================================

export type Severity = 'error' | 'warning' | 'info' | 'success'
const SEVERITIES: Severity[] = ['error', 'warning', 'info', 'success']

export interface SetupCheck {
  /** The check's class, e.g. OCA\Settings\SetupChecks\MaintenanceWindowStart. */
  id:          string
  category:    string
  name:        string
  severity:    Severity
  description: string
  doc:         string | null
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '')
const ID_RE = /^[A-Za-z0-9_\\]{1,160}$/

/** Nextcloud puts {placeholders} in a description and their values beside it; this fills them in as plain text. */
function fill(desc: string, params: unknown): string {
  if (!params || typeof params !== 'object') return desc
  return desc.replace(/\{([A-Za-z0-9_-]{1,40})\}/g, (m, k) => {
    const p = (params as Record<string, any>)[k]
    return p && typeof p === 'object' && typeof p.name === 'string' ? str(p.name, 80) : m
  })
}

/** occ setupchecks --output=json, or the admin page's /settings/setupcheck: { category: { class: result } }. */
export function parseSetupChecks(raw: unknown): SetupCheck[] {
  let j: unknown = raw
  if (typeof raw === 'string') { try { j = JSON.parse(raw) } catch { return [] } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return []
  const out: SetupCheck[] = []
  for (const [cat, checks] of Object.entries(j as Record<string, unknown>).slice(0, 40)) {
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) continue
    for (const [id, c] of Object.entries(checks as Record<string, any>).slice(0, 80)) {
      if (!ID_RE.test(id) || !c || typeof c !== 'object') continue
      const severity = SEVERITIES.includes(c.severity) ? c.severity as Severity : 'info'
      const doc = typeof c.linkToDoc === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(c.linkToDoc) ? c.linkToDoc : null
      out.push({ id, category: str(cat, 40), name: str(c.name, 120) || id.split('\\').pop()!, severity, description: fill(str(c.description), c.descriptionParameters), doc })
    }
  }
  return out
}

export interface NcStatus { installed: boolean; version: string; versionString: string; maintenance: boolean; needsDbUpgrade: boolean; edition: string }

const VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){1,3}$/

/** occ status --output=json. Null when it is not that. */
export function parseStatus(raw: string): NcStatus | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    if (typeof j !== 'object' || !j || typeof j.versionstring !== 'string') return null
    return {
      installed: j.installed === true,
      version: VERSION_RE.test(j.version) ? j.version : '',
      versionString: VERSION_RE.test(j.versionstring) ? j.versionstring : '',
      maintenance: j.maintenance === true,
      needsDbUpgrade: j.needsDbUpgrade === true,
      edition: str(j.edition, 40),
    }
  } catch { return null }
}

export interface UpdateInfo { core: string | null; apps: Array<{ app: string; version: string }> }

/** occ update:check: "Nextcloud 34.0.6 is available." and "Update for mail to version 5.13.2 is available." */
export function parseUpdateCheck(raw: string): UpdateInfo {
  const core = /^Nextcloud (\d{1,3}(?:\.\d{1,3}){1,3}) is available\./m.exec(raw)?.[1] ?? null
  const apps: UpdateInfo['apps'] = []
  const re = /^Update for ([a-z0-9_]{1,64}) to version ([0-9A-Za-z.+-]{1,40}) is available\./gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) && apps.length < 200) apps.push({ app: m[1], version: m[2] })
  return { core, apps }
}

export interface AppList { enabled: Record<string, string>; disabled: string[] }

/** occ app:list --output=json. */
export function parseAppList(raw: string): AppList {
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '')
    const enabled: Record<string, string> = {}
    for (const [k, v] of Object.entries(j?.enabled ?? {}).slice(0, 500)) if (/^[a-z0-9_]{1,64}$/.test(k)) enabled[k] = str(v, 40)
    const disabled = Object.keys(j?.disabled ?? {}).filter(k => /^[a-z0-9_]{1,64}$/.test(k)).slice(0, 500)
    return { enabled, disabled }
  } catch { return { enabled: {}, disabled: [] } }
}

/** occ app_api:app:list: "ExApps:" then one line per app. */
export function parseExApps(raw: string): number | null {
  if (!/ExApps:/.test(raw)) return null
  return raw.split('\n').slice(raw.split('\n').findIndex(l => /ExApps:/.test(l)) + 1).filter(l => l.trim() && !/^No /.test(l.trim())).length
}

export interface UserReport { total: number | null; active: number | null; disabled: number | null }

/** occ user:report, a table: "| total users | 3 |". */
export function parseUserReport(raw: string): UserReport {
  const n = (label: string) => { const m = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d{1,9})\\s*\\|`).exec(raw); return m ? Number(m[1]) : null }
  return { total: n('total users'), active: n('active users'), disabled: n('disabled users') }
}

/**
 * occ user:list --output=json: { uid: display name }. `uids` are the ids HyperProx may pass back to occ; `excluded`
 * are the ones it will not (a space, a quote): they are shown, and count as unknown wherever every user must be
 * checked (who is online before an update, who has a second factor before enforcing one).
 */
export function parseUserList(raw: string): { uids: string[]; excluded: string[]; ok: boolean } {
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '')
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { uids: [], excluded: [], ok: false }
    const all = Object.keys(j).slice(0, 1000)
    const good = (u: string) => /^[A-Za-z0-9_.@-]{1,64}$/.test(u) && !u.includes('..')
    return { uids: all.filter(good), excluded: all.filter(u => !good(u)).map(u => str(u, 80)), ok: true }
  } catch { return { uids: [], excluded: [], ok: false } }
}

/** occ group:list --output=json: { group: [members] }. Only the members of one group. */
export function parseGroupMembers(raw: string, group: string): string[] | null {
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '')
    const m = j?.[group]
    return Array.isArray(m) ? m.filter((u: unknown): u is string => typeof u === 'string').map(u => str(u, 80)).slice(0, 500) : null
  } catch { return null }
}

export interface EnforceState { enforced: boolean; groups: string[]; excluded: string[] }

/** twofactorauth:enforce (no options): "...enforced for all users", "...for members of the group(s) a, b, except members of c". */
export function parseEnforceState(raw: string): EnforceState | null {
  const line = raw.split('\n').find(l => /Two-factor authentication is/.test(l))?.trim() ?? ''
  if (/is not enforced/.test(line)) return { enforced: false, groups: [], excluded: [] }
  const m = /is enforced for (all users|members of the group\(s\) (.+?))(?:, except members of (.+))?$/.exec(line)
  if (!m) return null
  const list = (v?: string) => (v ? v.split(', ').map(x => x.trim()).filter(Boolean) : [])
  return { enforced: true, groups: m[1] === 'all users' ? [] : list(m[2]), excluded: list(m[3]) }
}

/** occ twofactorauth:state <uid>: enabled, not enabled, or unknown. */
export function parseTwoFactorState(raw: string): 'on' | 'off' | null {
  if (/Two-factor authentication is enabled for user/.test(raw)) return 'on'
  if (/Two-factor authentication is not enabled for user/.test(raw)) return 'off'
  return null
}

export interface AuthToken { id: number; name: string; lastActivity: number; type: number }

/** occ user:auth-tokens:list --output=json <uid>. */
export function parseAuthTokens(raw: string): AuthToken[] {
  try {
    const j = JSON.parse(/\[[\s\S]*\]/.exec(raw)?.[0] ?? '')
    if (!Array.isArray(j)) return []
    return j.slice(0, 500).map((t: any) => ({ id: Number(t?.id) || 0, name: str(t?.name, 120), lastActivity: Number(t?.lastActivity) || 0, type: Number(t?.type) || 0 }))
  } catch { return [] }
}

/** occ talk:active-calls --output=json, or the plain "No calls in progress". Null when it cannot be told. */
export function parseActiveCalls(raw: string): number | null {
  if (/No calls in progress/i.test(raw)) return 0
  const m = /There (?:is|are) (?:currently )?(\d{1,6}) calls? in progress/i.exec(raw)
  if (m) return Number(m[1])
  try {
    const j = JSON.parse(raw.trim())
    if (typeof j === 'number') return j
    if (Array.isArray(j)) return j.length
    if (j && typeof j === 'object' && typeof j.calls === 'number') return j.calls
  } catch { /* not JSON */ }
  return null
}

export interface LogEntry { level: number; time: string; app: string; message: string }
export const LEVEL_WORD = ['debug', 'info', 'warning', 'error', 'fatal'] as const

/** occ log:tail --raw: one JSON object per line. Newest last, as Nextcloud prints them. */
export function parseLog(raw: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of raw.split('\n').slice(-400)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const j = JSON.parse(t)
      const level = Number(j.level)
      if (!Number.isInteger(level) || level < 0 || level > 4) continue
      out.push({ level, time: /^\d{4}-\d{2}-\d{2}T[\d:.+-]{8,20}$/.test(j.time) ? j.time : '', app: str(j.app, 60), message: str(j.message, 600) })
    } catch { /* a line that is not one entry */ }
  }
  return out
}

/** A config:system:get value: the trimmed first line, or null when it is not set (occ exits 1). */
export function configValue(part: { output: string; code: number } | undefined): string | null {
  if (!part || part.code !== 0) return null
  const v = part.output.split('\n')[0]?.trim() ?? ''
  return v ? str(v, 300) : null
}

/**
 * occ config:list system --output=json, as strings, for `keys` only. Nextcloud has already replaced every sensitive
 * value; everything else in the answer is dropped here.
 */
export function parseSystemConfig(raw: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '')
    const sys = j?.system ?? {}
    for (const k of keys) {
      const v = sys[k]
      if (typeof v === 'string' && v && !/REMOVED SENSITIVE VALUE/.test(v)) out[k] = str(v, 300)
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    }
  } catch { /* not that */ }
  return out
}

/** The OCS serverinfo answer (ocs.data), the parts the page shows. */
export interface ServerInfo {
  php: { version: string | null; memoryLimit: number | null; maxExecutionTime: number | null; uploadMax: number | null }
  db: { type: string | null; version: string | null; size: number | null }
  storage: { users: number | null; files: number | null; freeSpace: number | null; shares: number | null }
  activeUsers: { last5minutes: number | null; last1hour: number | null; last24hours: number | null }
  webserver: string | null
  memory: { total: number | null; free: number | null }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{1,18}$/.test(v) ? Number(v) : null)

export function parseServerInfo(raw: unknown): ServerInfo | null {
  const d = (raw as any)?.ocs?.data
  if (!d || typeof d !== 'object') return null
  const sys = d.nextcloud?.system ?? {}
  const st = d.nextcloud?.storage ?? {}
  const sh = d.nextcloud?.shares ?? {}
  const php = d.server?.php ?? {}
  const db = d.server?.database ?? {}
  const au = d.activeUsers ?? {}
  return {
    php: { version: str(php.version, 40) || null, memoryLimit: num(php.memory_limit), maxExecutionTime: num(php.max_execution_time), uploadMax: num(php.upload_max_filesize) },
    db: { type: str(db.type, 40) || null, version: str(db.version, 80) || null, size: num(db.size) },
    storage: { users: num(st.num_users), files: num(st.num_files), freeSpace: num(sys.freespace), shares: num(sh.num_shares) },
    activeUsers: { last5minutes: num(au.last5minutes), last1hour: num(au.last1hour), last24hours: num(au.last24hours) },
    webserver: str(d.server?.webserver, 80) || null,
    memory: { total: num(sys.mem_total), free: num(sys.mem_free) },
  }
}

/** 34.0.3 < 34.0.6; -1, 0 or 1. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export const majorOf = (v: string) => Number(v.split('.')[0]) || 0
