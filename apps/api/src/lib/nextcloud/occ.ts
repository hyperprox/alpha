// =============================================================================
//  HyperProx — Nextcloud: the occ commands HyperProx may run, and nothing else
//
//  occ is Nextcloud's own admin tool, and it can do anything: delete users,
//  wipe files, decrypt the whole data directory. HyperProx needs a dozen of its
//  commands, so a dozen are listed here, each with its exact arguments. A
//  request names one by id and passes typed values; the values are checked
//  against that command's own rule, then every token is checked again against
//  one plain character set and single-quoted. No text a person typed ever
//  reaches a shell as anything but one quoted, checked word.
//
//  The script runs inside the guest through the remote executor (stdin to
//  `bash -s`, so nothing is on a command line on the node):
//
//    docker   docker exec -u www-data <container> php occ <args>
//    bare     sudo -u <user> php <path>/occ <args>   (runuser when sudo is absent)
//
//  A payload that must not appear on any command line (the SMTP password for
//  config:import) travels inside the script as a quoted heredoc, on stdin of
//  the occ process.
// =============================================================================

export type OccTarget =
  | { mode: 'docker'; container: string }
  | { mode: 'bare'; occPath: string; user: string }

export class OccRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'OccRefusal' }
}

/** Every token that reaches the script: letters, digits and . _ : = / @ + - , only. Never a quote, a space or a $. */
const TOKEN_RE = /^[A-Za-z0-9._:=/@+,-]{1,200}$/
export const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
export const UNIX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
export const OCC_PATH_RE = /^\/(?:[A-Za-z0-9._-]+\/)*occ$/
/** A Nextcloud user id as HyperProx will pass one (Nextcloud allows a little more; those are refused, not escaped). */
export const NC_UID_RE = /^[A-Za-z0-9_.@-]{1,64}$/
export const NC_GROUP_RE = /^[A-Za-z0-9_.@ -]{1,64}$/
export const REGION_RE = /^[A-Z]{2}$/

const q = (t: string) => {
  if (!TOKEN_RE.test(t) || t.includes('..')) throw new OccRefusal(`"${t.slice(0, 40)}" is not a value HyperProx passes to occ.`)
  return `'${t}'`
}

export function checkTarget(t: OccTarget): OccTarget {
  if (t.mode === 'docker') {
    if (!CONTAINER_RE.test(t.container)) throw new OccRefusal('That is not a container name.')
    return t
  }
  if (!OCC_PATH_RE.test(t.occPath) || t.occPath.includes('..')) throw new OccRefusal('That is not a path to occ.')
  if (!UNIX_USER_RE.test(t.user)) throw new OccRefusal('That is not a user name.')
  return t
}

/** The system config keys HyperProx reads. Never a secret one (dbpassword, secret, passwordsalt, mail_smtppassword...). */
export const READ_KEYS = [
  'maintenance_window_start', 'default_phone_region', 'serverid', 'default_timezone', 'default_language', 'default_locale',
  'mail_smtpmode', 'mail_smtphost', 'mail_smtpport', 'mail_smtpsecure', 'mail_smtpauth', 'mail_from_address', 'mail_domain',
  'maintenance', 'dbtype', 'dbname', 'dbuser', 'version', 'upgrade.disable-web', 'overwrite.cli.url', 'updater.release.channel',
] as const
export type ReadKey = typeof READ_KEYS[number]

/** The SMTP settings config:import may set, and their types. mail_smtppassword is the only secret, and only ever written. */
export const SMTP_KEYS = {
  mail_smtpmode: 'string', mail_smtphost: 'string', mail_smtpport: 'number', mail_smtpsecure: 'string', mail_smtpauth: 'boolean',
  mail_smtpname: 'string', mail_smtppassword: 'string', mail_from_address: 'string', mail_domain: 'string',
} as const

/**
 * The allow-list. `args` builds the occ arguments from checked values; `writes` marks a command that changes the
 * instance (the service audits it before it runs and refuses it to anyone below admin).
 */
export const OCC = {
  // ── reads ──
  'status':            { writes: false, args: () => ['status', '--output=json'] },
  'setupchecks':       { writes: false, args: () => ['setupchecks', '--output=json'] },
  'update-check':      { writes: false, args: () => ['update:check'] },
  'app-list':          { writes: false, args: () => ['app:list', '--output=json'] },
  'user-report':       { writes: false, args: () => ['user:report'] },
  'user-list':         { writes: false, args: () => ['user:list', '--output=json', '--limit=500'] },
  'log-tail':          { writes: false, args: () => ['log:tail', '--raw', '25'] },
  /** Nextcloud redacts every sensitive value itself (passwords, secrets, salts); the service keeps only READ_KEYS. */
  'config-list':       { writes: false, args: () => ['config:list', 'system', '--output=json'] },
  'active-calls':      { writes: false, args: () => ['talk:active-calls', '--output=json'] },
  'appapi-list':       { writes: false, args: () => ['app_api:app:list'] },
  'twofactor-state':   { writes: false, args: (p: { uid: string }) => ['twofactorauth:state', uid(p.uid)] },
  'auth-tokens':       { writes: false, args: (p: { uid: string }) => ['user:auth-tokens:list', '--output=json', uid(p.uid)] },
  'user-locale':       { writes: false, args: (p: { uid: string }) => ['user:setting', uid(p.uid), 'core', 'locale'] },
  'config-get':        { writes: false, args: (p: { key: ReadKey }) => ['config:system:get', readKey(p.key)] },
  'bg-mode':           { writes: false, args: () => ['config:app:get', 'core', 'backgroundjobs_mode'] },
  'bg-lastcron':       { writes: false, args: () => ['config:app:get', 'core', 'lastcron'] },
  'push-endpoint':     { writes: false, args: () => ['config:app:get', 'notify_push', 'base_endpoint'] },
  // ── fixes ──
  'set-maintenance-window': { writes: true, args: (p: { hour: number }) => ['config:system:set', 'maintenance_window_start', '--type=integer', `--value=${intIn(p.hour, 0, 23, 'The hour')}`] },
  'set-phone-region':  { writes: true, args: (p: { region: string }) => ['config:system:set', 'default_phone_region', `--value=${region(p.region)}`] },
  'set-server-id':     { writes: true, args: (p: { id: number }) => ['config:system:set', 'serverid', '--type=integer', `--value=${intIn(p.id, 0, 1023, 'The server id')}`] },
  'add-indices':       { writes: true, args: () => ['db:add-missing-indices'] },
  'add-columns':       { writes: true, args: () => ['db:add-missing-columns'] },
  'add-primary-keys':  { writes: true, args: () => ['db:add-missing-primary-keys'] },
  'repair-expensive':  { writes: true, args: () => ['maintenance:repair', '--include-expensive'] },
  'maintenance-on':    { writes: true, args: () => ['maintenance:mode', '--on'] },
  'maintenance-off':   { writes: true, args: () => ['maintenance:mode', '--off'] },
  'upgrade':           { writes: true, args: () => ['upgrade'] },
  'disable-app-api':   { writes: true, args: () => ['app:disable', 'app_api'] },
  'install-notify-push': { writes: true, args: () => ['app:install', 'notify_push'] },
  'enable-notify-push':  { writes: true, args: () => ['app:enable', 'notify_push'] },
  'notify-push-setup': { writes: true, args: (p: { url: string }) => ['notify_push:setup', pushUrl(p.url)] },
  'enforce-2fa':       { writes: true, args: (p: { exclude?: string[] }) => ['twofactorauth:enforce', '--on', ...(p.exclude ?? []).map(g => `--exclude=${group(g)}`)] },
  'update-apps':       { writes: true, args: () => ['app:update', '--all'] },
  /** Setup only: HyperProx's own app password for this admin, named HyperProx so its activity is not counted as a person's. */
  'add-app-password':  { writes: true, args: (p: { uid: string }) => ['user:auth-tokens:add', '--name=HyperProx', uid(p.uid)] },
  /** Reads JSON from stdin (the script's heredoc); the service builds that JSON from SMTP_KEYS only. */
  'import-smtp':       { writes: true, args: () => ['config:import'] },
} as const

export type OccId = keyof typeof OCC
export type OccParams<K extends OccId> = Parameters<typeof OCC[K]['args']>[0] extends undefined ? Record<string, never> : Parameters<typeof OCC[K]['args']>[0]

function uid(v: unknown): string {
  if (typeof v !== 'string' || !NC_UID_RE.test(v) || v.includes('..')) throw new OccRefusal('That is not a Nextcloud user id HyperProx passes on.')
  return v
}
function group(v: unknown): string {
  // A group name may have spaces in Nextcloud; HyperProx does not pass one that does (the token rule has no space).
  if (typeof v !== 'string' || !NC_GROUP_RE.test(v) || /\s/.test(v)) throw new OccRefusal('Group names with spaces cannot be excluded from here; use occ by hand.')
  return v
}
function readKey(v: unknown): string {
  if (typeof v !== 'string' || !(READ_KEYS as readonly string[]).includes(v)) throw new OccRefusal('HyperProx does not read that setting.')
  return v
}
function intIn(v: unknown, lo: number, hi: number, what: string): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new OccRefusal(`${what} must be a whole number from ${lo} to ${hi}.`)
  return n
}
function region(v: unknown): string {
  if (typeof v !== 'string' || !REGION_RE.test(v) || !REGIONS.includes(v)) throw new OccRefusal('Pick a country from the list (an ISO 3166-1 code such as CA).')
  return v
}
function pushUrl(v: unknown): string {
  let u: URL
  try { u = new URL(String(v)) } catch { throw new OccRefusal('The push address must be a full https:// address ending in /push.') }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/^\/(?:[A-Za-z0-9._-]+\/)*push\/?$/.test(u.pathname)) {
    throw new OccRefusal('The push address must be https://<your Nextcloud>/push.')
  }
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`
}

/** ISO 3166-1 alpha-2, the codes Nextcloud's default_phone_region takes. */
export const REGIONS = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ')

/** The occ arguments for one allow-listed command, checked. Throws OccRefusal for anything else. */
export function occArgs<K extends OccId>(id: K, params?: unknown): string[] {
  const spec = (OCC as Record<string, { writes: boolean; args: (p: any) => string[] }>)[id]
  if (!spec) throw new OccRefusal('HyperProx does not run that occ command.')
  const argv = spec.args((params ?? {}) as any)
  argv.forEach(t => q(t))
  return argv
}

/** The shell line that runs occ with these (already checked) arguments. `stdin` adds -i (docker) for a heredoc. */
export function occLine(target: OccTarget, argv: string[], stdin = false): string {
  const t = checkTarget(target)
  const args = [...argv, '--no-interaction'].map(q).join(' ')
  if (t.mode === 'docker') return `docker exec${stdin ? ' -i' : ''} -u www-data ${q(t.container)} php occ ${args}`
  const user = q(t.user)
  const path = q(t.occPath)
  return `if command -v sudo >/dev/null 2>&1; then sudo -n -u ${user} php ${path} ${args}; else runuser -u ${user} -- php ${path} ${args}; fi`
}

/** A heredoc delimiter that cannot occur in `body`. */
function delimiter(body: string): string {
  for (;;) {
    const d = `HPX_EOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    if (!body.includes(d)) return d
  }
}

/** One occ command as a whole script. `stdin` is fed to occ through a quoted heredoc (never a command line). */
export function occScript<K extends OccId>(target: OccTarget, id: K, params?: unknown, stdin?: string): string {
  const argv = occArgs(id, params)
  if (stdin === undefined) return `set -o pipefail\n${occLine(target, argv)}\n`
  if (stdin.includes('\n')) throw new OccRefusal('That input must be one line.')
  const d = delimiter(stdin)
  return `set -o pipefail\n${occLine(target, argv, true)} <<'${d}'\n${stdin}\n${d}\n`
}

/** Several reads in one round trip, each wrapped in markers that parseBatch() splits again. Reads only. */
export function occBatchScript(target: OccTarget, items: Array<{ key: string; id: OccId; params?: unknown }>): string {
  const lines = ['set +e']
  for (const it of items) {
    const spec = (OCC as any)[it.id]
    if (!spec || spec.writes) throw new OccRefusal('Only reads may be batched.')
    if (!/^[a-z0-9:_-]{1,60}$/.test(it.key)) throw new OccRefusal('Bad batch key.')
    lines.push(`echo '@@HPX-BEGIN ${it.key}@@'`, `${occLine(target, occArgs(it.id, it.params))} 2>&1 | head -c 2000000; _rc=\${PIPESTATUS[0]}`, `echo ''`, `echo "@@HPX-END ${it.key} $_rc@@"`)
  }
  return lines.join('\n') + '\n'
}

export interface BatchPart { output: string; code: number }

/** Split a batch's output back into its parts. A part whose end marker is missing is left out. */
export function parseBatch(out: string): Record<string, BatchPart> {
  const res: Record<string, BatchPart> = {}
  const re = /@@HPX-BEGIN ([a-z0-9:_-]+)@@\n([\s\S]*?)\n?@@HPX-END \1 (-?\d+)@@/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) res[m[1]] = { output: m[2].replace(/\n$/, ''), code: Number(m[3]) }
  return res
}
