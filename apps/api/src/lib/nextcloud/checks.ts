// =============================================================================
//  HyperProx — Nextcloud: what to do about each setup warning
//
//  Every problem the page shows gets an action, of one of three kinds:
//    fix       one click (with a confirm that says what will change): HyperProx
//              runs one allow-listed occ command, or a fixed sequence of them;
//    guided    it needs something only the person knows (mail server, which
//              users may skip 2FA) or a step HyperProx cannot take safely for
//              every install (adding a container to a Compose file): a form or
//              exact steps, with whatever part is safe done in one click;
//    optional  an honest "here is what it would give you", with dismiss and
//              snooze, for features most homes do not need.
//  A check Nextcloud reports only because occ runs from the command line (no
//  remote address there) is "none": not a problem, and not counted.
// =============================================================================

import type { Deployment } from './detect'
import type { SetupCheck, Severity } from './parse'

/**
 * A busy window as Load balancing stores it (lib/placement/store.ts): kept here, with the code that reads it, so this
 * file needs nothing from types.ts (which imports this file's action and remedy types).
 */
export interface BusyHoursLike { days?: number[]; start: string; end: string; label?: string }

export type ActionId =
  | 'maintenance-window' | 'phone-region' | 'server-id' | 'disable-app-api' | 'install-notify-push' | 'notify-push-setup'
  | 'add-indices' | 'mimetype-repair' | 'enforce-2fa' | 'unenforce-2fa' | 'smtp' | 'update-apps' | 'update' | 'hpb-update'

export type FlowId = 'smtp' | 'enforce-2fa' | 'client-push' | 'log' | 'cron' | 'app-api-daemon' | 'hpb-manual' | 'update-manual'

/** Every action, its tier and whether it runs in the background. The service enforces these, not the caller. */
export const ACTIONS: Record<ActionId, { secure: boolean; long: boolean; label: string }> = {
  'maintenance-window':  { secure: false, long: false, label: 'Set the maintenance window' },
  'phone-region':        { secure: false, long: false, label: 'Set the default phone region' },
  'server-id':           { secure: false, long: false, label: 'Set the server id' },
  'disable-app-api':     { secure: false, long: false, label: 'Turn off AppAPI' },
  'install-notify-push': { secure: false, long: false, label: 'Install the Client Push app' },
  'notify-push-setup':   { secure: false, long: false, label: 'Point Client Push at its address' },
  'add-indices':         { secure: true,  long: true,  label: 'Add the missing database indices' },
  'mimetype-repair':     { secure: true,  long: true,  label: 'Run the mimetype migrations' },
  'enforce-2fa':         { secure: true,  long: false, label: 'Enforce two-factor authentication' },
  'unenforce-2fa':       { secure: true,  long: false, label: 'Stop enforcing 2FA (turns enforcement off for everyone; earlier group-only settings are not restored)' },
  'smtp':                { secure: true,  long: false, label: 'Save the mail server' },
  'update-apps':         { secure: true,  long: true,  label: 'Update the apps' },
  'update':              { secure: true,  long: true,  label: 'Update Nextcloud' },
  'hpb-update':          { secure: true,  long: true,  label: 'Update the Talk signalling server' },
}
export const isAction = (v: unknown): v is ActionId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, v)

export type Remedy =
  | { kind: 'fix'; action: ActionId; label: string; confirm: string; secure: boolean; long: boolean; params?: Record<string, unknown>; note?: string }
  | { kind: 'guided'; flow: FlowId; label: string; why: string; action?: ActionId }
  | { kind: 'optional'; gives: string; needs: string }
  | { kind: 'none'; why: string }

export interface RemedyContext {
  deployment: Deployment | null
  /** How many External Apps AppAPI runs; null when it could not be read. */
  exApps: number | null
  suggest: Suggestions
  /** Checks came from occ on the command line (not from the admin page, which knows the request). */
  fromCli: boolean
}

export interface Suggestions {
  windowHour: number; windowWhy: string
  region: string | null; regionWhy: string
  serverId: number
}

const S = 'OCA\\Settings\\SetupChecks\\'
const T = 'OCA\\Talk\\SetupCheck\\'

export const OPTIONAL_WORDS: Record<string, { gives: string; needs: string }> = {
  [`${T}RecordingBackend`]: {
    gives: 'Talk can record calls and save the recording into the conversation.',
    needs: 'A separate recording server (Nextcloud Talk Recording) with a headless browser and ffmpeg. It is heavy on CPU while recording. Most homes never record calls; leave it off unless you do.',
  },
  [`${T}SIPConfiguration`]: {
    gives: 'People can dial into a Talk call from an ordinary phone.',
    needs: 'A SIP bridge and a SIP trunk from a phone provider, plus the High-performance backend. Only worth it if you want phone dial-in.',
  },
  'OCA\\AppAPI\\SetupChecks\\DaemonCheck': {
    gives: 'External Apps (ExApps, such as a local AI assistant) run in their own containers through a deploy daemon.',
    needs: 'A Docker socket proxy (or HaRP) registered as the default deploy daemon. If you use no External Apps, turn AppAPI off instead and the warning goes away.',
  },
}

/** What to do about one check, in context. */
export function remedyFor(c: SetupCheck, ctx: RemedyContext): Remedy {
  const d = ctx.deployment
  switch (c.id) {
    case `${S}MaintenanceWindowStart`:
      return { kind: 'fix', action: 'maintenance-window', label: `Set it to ${pad(ctx.suggest.windowHour)}:00 UTC`, ...tier('maintenance-window'),
        params: { hour: ctx.suggest.windowHour }, note: ctx.suggest.windowWhy,
        confirm: `Nextcloud runs its heavy daily jobs in the four hours from ${pad(ctx.suggest.windowHour)}:00 UTC. Sets maintenance_window_start = ${ctx.suggest.windowHour}. Change it any time.` }
    case `${S}MimeTypeMigrationAvailable`:
      return { kind: 'fix', action: 'mimetype-repair', label: 'Run the migrations', ...tier('mimetype-repair'),
        confirm: 'Runs occ maintenance:repair --include-expensive in the background. On a large library this can take a long time and keeps the database busy; Nextcloud stays usable. Progress is shown here.' }
    case `${S}DatabaseHasMissingIndices`:
      return { kind: 'fix', action: 'add-indices', label: 'Add the indices', ...tier('add-indices'),
        confirm: 'Runs occ db:add-missing-indices (and the matching column and primary-key commands). Adding an index to a big table can take a while and slow queries while it runs.' }
    case `${S}DatabaseHasMissingColumns`:
    case `${S}DatabaseHasMissingPrimaryKeys`:
      return { kind: 'fix', action: 'add-indices', label: 'Add them', ...tier('add-indices'),
        confirm: 'Runs occ db:add-missing-indices, db:add-missing-columns and db:add-missing-primary-keys. Can take a while on big tables.' }
    case `${S}DefaultPhoneRegionSet`:
      return { kind: 'fix', action: 'phone-region', label: ctx.suggest.region ? `Set it to ${ctx.suggest.region}` : 'Pick the country', ...tier('phone-region'),
        params: { region: ctx.suggest.region }, note: ctx.suggest.regionWhy,
        confirm: 'Phone numbers in profiles without a +country code are read as numbers in this country. Sets default_phone_region.' }
    case `${S}ServerIdConfig`:
      return { kind: 'fix', action: 'server-id', label: `Set it to ${ctx.suggest.serverId}`, ...tier('server-id'), params: { id: ctx.suggest.serverId },
        note: 'Any number from 0 to 1023 works for one server; it must differ between servers that share one database.',
        confirm: `Sets serverid = ${ctx.suggest.serverId}. Nextcloud uses it to keep generated ids unique across servers.` }
    case `${S}EmailTestSuccessful`:
      return { kind: 'guided', flow: 'smtp', label: 'Set up mail', action: 'smtp',
        why: 'Nextcloud needs your mail server to send password resets, shares and notifications. HyperProx keeps the password in the vault and writes it to Nextcloud without it appearing on any command line. Send a test mail from Nextcloud afterwards: that clears this check.' }
    case `${S}TwoFactorConfiguration`:
      return { kind: 'guided', flow: 'enforce-2fa', label: 'Review and enforce', action: 'enforce-2fa',
        why: 'Enforcing means every user must set up a second factor at their next sign-in. HyperProx lists who has none yet first, so nobody is locked out by surprise.' }
    case `${S}BruteForceThrottler`:
    case `${S}ForwardedForHeaders`:
      if (ctx.fromCli && /remote address could not be determined/i.test(c.description)) {
        return { kind: 'none', why: 'Only shown because HyperProx asked from the command line, where there is no visitor address. The admin page in a browser does not show it.' }
      }
      return { kind: 'guided', flow: 'update-manual', label: 'How to fix it', why: 'Set trusted_proxies (and forwarded_for_headers if your proxy uses another header) in config.php to your reverse proxy\'s address, so Nextcloud sees each visitor\'s real address.' }
    case `${T}HighPerformanceBackend`:
      if (d?.signaling && d.kind !== 'bare') return { kind: 'fix', action: 'hpb-update', label: 'Update the signalling server', ...tier('hpb-update'),
        confirm: `Pulls the newest ${d.signaling.image} and recreates ${d.signaling.container}. Calls in progress drop for a few seconds; HyperProx refuses while a call is running.` }
      return { kind: 'guided', flow: 'hpb-manual', label: 'How to update it', why: 'HyperProx did not find the signalling server in this guest. Update it where it runs (a newer nextcloud-spreed-signaling release adds the features Talk asks for).' }
    case `${T}NotifyPush`:
      return { kind: 'guided', flow: 'client-push', label: 'Set up Client Push', action: 'install-notify-push',
        why: 'Client Push tells desktop and phone apps about changes the moment they happen, instead of them asking every few minutes. It is an app plus a small daemon behind your reverse proxy at /push.' }
    case 'OCA\\LogReader\\SetupChecks\\LogErrors':
      return { kind: 'guided', flow: 'log', label: 'Read the entries', why: 'Look at what was logged. Failed sign-ins from the internet are common and harmless when 2FA and brute-force protection are on; anything else is worth a look.' }
    case 'OCA\\AppAPI\\SetupChecks\\DaemonCheck':
      if (ctx.exApps === 0) return { kind: 'fix', action: 'disable-app-api', label: 'Turn AppAPI off', ...tier('disable-app-api'),
        note: 'No External Apps are installed, so nothing uses it.',
        confirm: 'Disables the AppAPI app (occ app:disable app_api). Nothing uses it; turn it back on in Apps any time.' }
      return { kind: 'optional', ...OPTIONAL_WORDS[c.id] }
    default:
      if (OPTIONAL_WORDS[c.id]) return { kind: 'optional', ...OPTIONAL_WORDS[c.id] }
      return { kind: 'guided', flow: 'update-manual', label: 'Read how to fix it', why: c.doc ? 'Nextcloud links its own instructions for this one.' : 'Nextcloud gives no link for this one; its words are above.' }
  }
}

const tier = (a: ActionId) => ({ secure: ACTIONS[a].secure, long: ACTIONS[a].long })
const pad = (n: number) => String(n).padStart(2, '0')

/** Counted severities: success and the command-line artefacts are not problems. */
export function countable(severity: Severity, r: Remedy): boolean {
  return severity !== 'success' && r.kind !== 'none'
}

// ── suggestions ──────────────────────────────────────────────────────────────

const toMin = (hm: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hm); return m ? Number(m[1]) * 60 + Number(m[2]) : null }

/** Minutes east of UTC for `tz` at `at` (Intl, no library). */
export function tzOffsetMin(tz: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
    const g = (t: string) => Number(parts.find(p => p.type === t)?.value)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'))
    return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000)
  } catch { return 0 }
}

/**
 * The maintenance window start (an hour, UTC; Nextcloud runs heavy jobs for four hours from it). From HyperProx's
 * busy hours when any are set: the first local hour, preferring the small hours, whose four-hour window misses every
 * busy range on every day. Otherwise 01:00 UTC.
 */
export function suggestWindow(busy: BusyHoursLike[] | null, tz: string | null, now: number): { hour: number; why: string } {
  const ranges = (busy ?? []).map(b => ({ s: toMin(b.start), e: toMin(b.end) })).filter(r => r.s !== null && r.e !== null) as Array<{ s: number; e: number }>
  if (!ranges.length || !tz) return { hour: 1, why: 'No busy hours are set in HyperProx (Load balancing settings), so the usual quiet default: 01:00 UTC.' }
  const inBusy = (min: number) => ranges.some(r => (r.s <= r.e ? min >= r.s && min < r.e : min >= r.s || min < r.e))
  const offset = tzOffsetMin(tz, now)
  for (const local of [2, 3, 1, 4, 0, 5, 23, 22, 6, 21, 7, 20, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    let clash = false
    for (let m = local * 60; m < local * 60 + 240; m += 15) if (inBusy(m % 1440)) { clash = true; break }
    if (clash) continue
    const utc = (((local * 60 - offset) % 1440) + 1440) % 1440
    return { hour: Math.floor(utc / 60), why: `Four hours from ${pad(local)}:00 ${tz} miss every busy range in HyperProx's Load balancing settings.` }
  }
  return { hour: 1, why: 'Every four-hour window overlaps a busy range in Load balancing settings, so the usual default: 01:00 UTC.' }
}

/** A few time zones to their country, for the region guess when no locale says it. */
const TZ_REGION: Record<string, string> = {
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/St_Johns': 'CA', 'America/Regina': 'CA',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Lisbon': 'PT', 'Europe/Athens': 'GR', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ', 'Asia/Tokyo': 'JP', 'Asia/Singapore': 'SG', 'Asia/Kolkata': 'IN', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'Africa/Johannesburg': 'ZA',
}

/** The default phone region: from Nextcloud's locale, its language, the admin's own locale, then the time zone. */
export function suggestRegion(f: { locale?: string | null; language?: string | null; adminLocale?: string | null; timezone?: string | null }, valid: (r: string) => boolean): { region: string | null; why: string } {
  const fromLocale = (v: string | null | undefined) => { const m = /^[a-z]{2,3}[_-]([A-Z]{2})\b/.exec(v ?? ''); return m && valid(m[1]) ? m[1] : null }
  let r = fromLocale(f.locale)
  if (r) return { region: r, why: `From Nextcloud's default locale (${f.locale}).` }
  r = fromLocale(f.language)
  if (r) return { region: r, why: `From Nextcloud's default language (${f.language}).` }
  r = fromLocale(f.adminLocale)
  if (r) return { region: r, why: `From the admin account's locale (${f.adminLocale}).` }
  const tz = f.timezone && TZ_REGION[f.timezone]
  if (tz && valid(tz)) return { region: tz, why: `From the server's time zone (${f.timezone}).` }
  return { region: null, why: 'Nextcloud\'s locale and time zone do not name a country: pick yours.' }
}

/** A stable server id (0-1023) for this instance, so two HyperProx-made ids rarely collide. */
export function suggestServerId(instanceId: string): number {
  let h = 0
  for (const ch of instanceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 1024
}
