// =============================================================================
//  HyperProx — Nextcloud page: the shapes it reads and the pure logic behind it
//
//  Kept apart from the components so the tests can check the words and the
//  grouping without a browser.
// =============================================================================

export type Severity = 'error' | 'warning' | 'info' | 'success'

export type ActionId =
  | 'maintenance-window' | 'phone-region' | 'server-id' | 'disable-app-api' | 'install-notify-push' | 'notify-push-setup'
  | 'add-indices' | 'mimetype-repair' | 'enforce-2fa' | 'smtp' | 'update-apps' | 'update' | 'hpb-update'
export type FlowId = 'smtp' | 'enforce-2fa' | 'client-push' | 'log' | 'cron' | 'app-api-daemon' | 'hpb-manual' | 'update-manual'

export type Remedy =
  | { kind: 'fix'; action: ActionId; label: string; confirm: string; secure: boolean; long: boolean; params?: Record<string, unknown>; note?: string }
  | { kind: 'guided'; flow: FlowId; label: string; why: string; action?: ActionId }
  | { kind: 'optional'; gives: string; needs: string }
  | { kind: 'none'; why: string }

export interface Check { id: string; category: string; name: string; severity: Severity; description: string; doc: string | null; remedy: Remedy; snoozed: string | null }

export interface Deployment {
  kind: 'compose' | 'docker' | 'bare'
  app?: { container: string; image: string; project: string | null; service: string | null; workdir: string | null; configFile: string | null; built: boolean; dockerfile: boolean; imageVersion: string | null } | null
  db?: { container: string; image: string; engine: 'postgres' | 'mysql' } | null
  signaling?: { container: string; image: string; service: string | null; version: string | null; running: boolean } | null
  notifyPush?: { container: string; running: boolean } | null
  bareDir?: string
}

export interface LogEntry { level: number; time: string; app: string; message: string }

export interface Reading {
  fetchedAt: string
  status: { versionString: string; maintenance: boolean; needsDbUpgrade: boolean } | null
  update: { core: string | null; apps: Array<{ app: string; version: string }>; webUpdaterDisabled: boolean }
  checksFrom: 'web' | 'occ' | null
  checks: Check[]
  counts: { error: number; warning: number; info: number }
  background: { mode: string; lastRun: number | null }
  config: { maintenanceWindowStart: number | null; phoneRegion: string | null; serverId: number | null; timezone: string | null
    mail: { mode: string | null; host: string | null; port: string | null; secure: string | null; from: string | null; domain: string | null } }
  users: { total: number | null; disabled: number | null }
  twoFactor: { enforced: boolean | null; providers: string[] }
  log: LogEntry[] | null
  server: { php: { version: string | null; memoryLimit: number | null }; db: { type: string | null; version: string | null; size: number | null }
    storage: { users: number | null; files: number | null; freeSpace: number | null }; activeUsers: { last5minutes: number | null; last24hours: number | null } } | null
  talk: { installed: boolean; hpb: { version: string | null; image: string | null; container: string | null; missing: string[] } | null; activeCalls: number | null
    push: { app: 'enabled' | 'disabled' | 'missing'; daemon: 'running' | 'stopped' | 'missing'; endpoint: string | null } }
  apps: { enabled: number; exApps: number | null }
  deployment: Deployment | null
  suggest: { windowHour: number; windowWhy: string; region: string | null; regionWhy: string; serverId: number }
  php: string | null
  dbVersion: string | null
  missing: string[]
}

export interface JobStep { key: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }
export interface Job { id: string; action: ActionId; state: 'running' | 'done' | 'failed'; steps: JobStep[]; lines: string[]; startedAt: string; endedAt: string | null; result: string | null; rollback: string | null; by: string }

export interface UpdatePreview {
  ok: boolean; problems: string[]; warnings: string[]; from: string | null; to: string | null; source: 'build' | 'pull' | null
  backupDir: string | null; steps: string[]; snapshotNote: string | null; rollback: string | null; activeUsers: number | null; activeCalls: number | null
}

export const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info']
export const SEVERITY_WORD: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notes', success: 'Passing' }
export const SEVERITY_TONE: Record<Severity, 'bad' | 'warn' | 'accent' | 'good'> = { error: 'bad', warning: 'warn', info: 'accent', success: 'good' }
export const KIND_WORD: Record<Remedy['kind'], string> = { fix: 'one-click fix', guided: 'guided', optional: 'optional', none: 'nothing to do' }

/** The checks to show, by severity; snoozed ones and command-line artefacts apart. */
export function groupChecks(checks: Check[]): { groups: Array<{ severity: Severity; checks: Check[] }>; snoozed: Check[]; quiet: Check[] } {
  const live = checks.filter(c => !c.snoozed && c.remedy.kind !== 'none' && c.severity !== 'success')
  return {
    groups: SEVERITY_ORDER.map(s => ({ severity: s, checks: live.filter(c => c.severity === s) })).filter(g => g.checks.length),
    snoozed: checks.filter(c => !!c.snoozed),
    quiet: checks.filter(c => !c.snoozed && c.remedy.kind === 'none'),
  }
}

/** 0..1 for the HUD ring: an error weighs three warnings, a note a third of one. */
export function healthScore(c: { error: number; warning: number; info: number }): number {
  const weight = c.error * 3 + c.warning + c.info / 3
  return Math.max(0.04, 1 / (1 + weight / 4))
}

export function verdictOf(r: Reading): { text: string; tone: 'good' | 'warn' | 'bad' } {
  if (!r.status) return { text: 'not answering', tone: 'bad' }
  if (r.status.maintenance) return { text: 'maintenance mode', tone: 'warn' }
  if (r.counts.error) return { text: `${r.counts.error} error${r.counts.error === 1 ? '' : 's'}`, tone: 'bad' }
  if (r.counts.warning) return { text: `${r.counts.warning} warning${r.counts.warning === 1 ? '' : 's'}`, tone: 'warn' }
  return { text: 'all checks pass', tone: 'good' }
}

export const pad2 = (n: number) => String(n).padStart(2, '0')

/** "01:00 UTC (21:00 here)": the window start in UTC and in the viewer's own time. */
export function hourWords(hourUtc: number, tz?: string): string {
  const d = new Date(Date.UTC(2026, 0, 15, hourUtc, 0))
  let local = ''
  try { local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hourCycle: 'h23' }).format(d) } catch { /* no Intl time zone */ }
  return `${pad2(hourUtc)}:00 UTC${local && local !== `${pad2(hourUtc)}:00` ? ` (${local} ${tz ? tz.split('/').pop()!.replace(/_/g, ' ') : 'here'})` : ''}`
}

/** A country's name from its code, in the reader's language; the code when the browser cannot say. */
export function regionName(code: string, locale = 'en'): string {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code } catch { return code }
}

export const REGIONS = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ')

/** The regions sorted by name, the suggested one first. */
export function regionOptions(suggested: string | null, locale = 'en'): Array<{ code: string; name: string }> {
  const all = REGIONS.map(code => ({ code, name: regionName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name))
  if (!suggested) return all
  const i = all.findIndex(r => r.code === suggested)
  return i < 0 ? all : [all[i], ...all.slice(0, i), ...all.slice(i + 1)]
}

export const LEVEL_WORD = ['debug', 'info', 'warning', 'error', 'fatal']

export function deploymentWords(d: Deployment | null): string {
  if (!d) return 'not detected yet'
  if (d.kind === 'bare') return 'plain install'
  if (d.kind === 'docker') return 'Docker, without Compose'
  return d.app?.built ? 'Docker Compose, built from a Dockerfile' : 'Docker Compose'
}

/** The notify_push daemon as a Compose service, from the app service's own image and volume. */
export function pushComposeSnippet(d: Deployment | null): string {
  const image = d?.app?.image ?? 'nextcloud:apache'
  const app = d?.app?.service ?? 'app'
  return [
    '  notify_push:',
    `    image: ${image}`,
    '    restart: unless-stopped',
    `    depends_on: [${app}]`,
    '    entrypoint: /var/www/html/custom_apps/notify_push/bin/x86_64/notify_push',
    '    command: /var/www/html/config/config.php',
    '    environment:',
    '      PORT: "7867"',
    `      NEXTCLOUD_URL: http://${app}`,
    '    volumes:',
    '      - nextcloud:/var/www/html:ro   # the same volume the app service mounts at /var/www/html',
    '    ports: ["7867:7867"]',
  ].join('\n')
}

/** The /push location for an nginx in front of Nextcloud (NPM's Advanced tab takes it as it is). */
export function pushNginxSnippet(upstream: string): string {
  return [
    'location ^~ /push/ {',
    `    proxy_pass http://${upstream}:7867/;`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Upgrade $http_upgrade;',
    '    proxy_set_header Connection "Upgrade";',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '}',
  ].join('\n')
}

/** Cron for a Compose install: a service that runs the image's own cron loop. */
export function cronSnippet(d: Deployment | null): string {
  if (d?.kind === 'bare') return '*/5 * * * * php -f ' + (d.bareDir ?? '/var/www/nextcloud') + '/cron.php   # in the crontab of the web server user (crontab -u www-data -e)'
  const image = d?.app?.image ?? 'nextcloud:apache'
  return [
    '  cron:',
    `    image: ${image}`,
    '    restart: unless-stopped',
    '    entrypoint: /cron.sh',
    `    depends_on: [${d?.app?.service ?? 'app'}]`,
    '    volumes:   # the same volumes as the app service',
    '      - nextcloud:/var/www/html',
  ].join('\n')
}

/** Exact update steps for an install HyperProx does not update itself. */
export function manualUpdateSteps(d: Deployment | null, to: string | null): string[] {
  if (d?.kind === 'bare') {
    const dir = d.bareDir ?? '/var/www/nextcloud'
    return [
      'Back up the database and config.php first.',
      `sudo -u www-data php ${dir}/updater/updater.phar --no-interaction`,
      `sudo -u www-data php ${dir}/occ upgrade`,
      `sudo -u www-data php ${dir}/occ db:add-missing-indices`,
    ]
  }
  return [
    'Back up the database first (pg_dump or mysqldump inside its container).',
    `docker pull ${d?.app?.image ?? 'nextcloud:apache'}${to ? `   # must hold Nextcloud ${to}` : ''}`,
    `docker stop ${d?.app?.container ?? 'nextcloud'} && docker rm ${d?.app?.container ?? 'nextcloud'}`,
    'Start it again with the same docker run options and volumes: the image upgrades itself on start.',
    `docker exec -u www-data ${d?.app?.container ?? 'nextcloud'} php occ db:add-missing-indices`,
  ]
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

export function sinceWords(epochS: number | null, now = Date.now()): string {
  if (!epochS) return 'never'
  const m = Math.round((now / 1000 - epochS) / 60)
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

export function bytesWords(b: number | null): string {
  if (b === null) return '—'
  return b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`
}

export const jobDone = (j: Job | null) => !!j && j.state !== 'running'
