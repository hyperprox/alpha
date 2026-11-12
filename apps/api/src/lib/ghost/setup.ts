// =============================================================================
//  HyperProx — Ghost's first run, done for you
//
//  After the install script, the site is up on the container's loopback with
//  its setup waiting. These steps finish it, each one read back before the
//  next starts:
//
//    ghost-start  Ghost answers, and its setup is still waiting (an owner that
//                 HyperProx did not make is never touched);
//    ghost-owner  the owner account, with the title and description, through
//                 Ghost's own setup API; read back as "setup done";
//    ghost-open   only now is Ghost put behind the site's nginx (until then it
//                 serves a 503 holding page); read back over nginx: the site
//                 answers, and every form of the setup endpoint refuses writes;
//    ghost-key    one sign-in as the owner, to make the "HyperProx" custom
//                 integration; its Admin API key goes into the vault, and the
//                 title is read back with that key; then the session is ended;
//    ghost-mail   with an SMTP server, Ghost's new-device sign-in codes are
//                 turned on (Ghost's default) once nothing needs to sign in.
//
//  Every request goes to 127.0.0.1:2368 inside the container, through the node
//  (pct exec): Ghost never listens beyond loopback, and nginx does not proxy to
//  it at all until the owner exists. If any step fails, Ghost and nginx are
//  stopped and the error says so, so a half-made site is never left running.
//
//  Secrets: the owner password, the session cookie and the Admin API key are in
//  request bodies or header files written by the shell, never on a command
//  line, never in the job log (this output is not added to it), and replaced
//  with [hidden] in every message.
// =============================================================================

import { createHmac, randomUUID } from 'node:crypto'
import { GHOST_DIR, GHOST_PORT, NO_MAIL, GHOST_OPEN_SCRIPT, ghostEnvFile } from './recipe'

export const GHOST_SETUP_STEPS = [
  { id: 'ghost-start', label: 'Wait for Ghost to start' },
  { id: 'ghost-owner', label: 'Create the owner account' },
  { id: 'ghost-open',  label: 'Open the site in nginx' },
  { id: 'ghost-key',   label: 'Make HyperProx\'s Admin API key' },
  { id: 'ghost-mail',  label: 'Turn on mail' },
] as const

export interface GhostRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Under /ghost/api/admin/, ending in a slash, with an optional plain query. */
  path: string
  body?: unknown
  /** The admin session cookie, `ghost-admin-api-session=…`. */
  cookie?: string
  /** An Admin API token (lib/ghost/setup.ts adminToken). */
  token?: string
}
export interface GhostAnswer { status: number; body: string; cookie?: string }

/** One HTTP exchange with Ghost on the container's loopback; null when nothing answered. */
export type GhostHttp = (r: GhostRequest) => Promise<GhostAnswer | null>

export type Shell = (script: string, timeoutMs: number) => Promise<{ code: number | null; output: string }>

const PATH_RE = /^\/ghost\/api\/admin\/[A-Za-z0-9_/-]*\/(\?[A-Za-z0-9_=&,.:%-]*)?$/
const COOKIE_RE = /^ghost-admin-api-session=[A-Za-z0-9%._~+/=-]{1,2000}$/
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const HOSTPORT_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/

/** The exact parts of a site address the requests carry: Host, the scheme Ghost must hear, and Origin. */
export function siteParts(url: string): { host: string; proto: 'http' | 'https'; origin: string } {
  const u = new URL(url)
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !HOSTPORT_RE.test(u.host) || u.username || u.password) throw new Error(`${url} is not a site address.`)
  return { host: u.host, proto: u.protocol === 'https:' ? 'https' : 'http', origin: `${u.protocol}//${u.host}` }
}

/**
 * The script for one request, run in the container. The body is a heredoc and the cookie or token is in a header
 * file the shell writes; curl reads both from there, so neither is ever on a command line. Prints the status, the
 * session cookie when Ghost sets one, and the body as base64.
 */
export function requestScript(siteUrl: string, r: GhostRequest): string {
  if (!PATH_RE.test(r.path)) throw new Error(`Refused: ${r.path} is not a Ghost Admin API path.`)
  if (r.cookie !== undefined && !COOKIE_RE.test(r.cookie)) throw new Error('Refused: that is not a Ghost session cookie.')
  if (r.token !== undefined && !TOKEN_RE.test(r.token)) throw new Error('Refused: that is not an Admin API token.')
  const { host, proto, origin } = siteParts(siteUrl)
  const auth = r.cookie ? `Cookie: ${r.cookie}` : r.token ? `Authorization: Ghost ${r.token}` : ''
  const body = r.body === undefined ? null : JSON.stringify(r.body)
  return [
    'set -u',
    'T=$(mktemp -d)',
    'trap \'rm -rf "$T"\' EXIT',
    // Header file and body: written by the shell, read by curl. JSON is one line, so it can never end a heredoc.
    `cat > "$T/hdr" <<'HP_HDR'`,
    `Host: ${host}`, `X-Forwarded-Proto: ${proto}`, `Origin: ${origin}`, 'Accept: application/json',
    ...(body !== null ? ['Content-Type: application/json'] : []),
    ...(auth ? [auth] : []),
    'HP_HDR',
    ...(body !== null ? [`cat > "$T/req" <<'HP_BODY'`, body, 'HP_BODY'] : []),
    `CODE=$(curl -sS --max-time 30 -o "$T/b" -D "$T/h" -w '%{http_code}' -X ${r.method} -H @"$T/hdr" ${body !== null ? '--data-binary @"$T/req" ' : ''}'http://127.0.0.1:${GHOST_PORT}${r.path}' 2>/dev/null) || CODE=000`,
    'echo "HPXG1 status $CODE"',
    'sed -n \'s/^[Ss]et-[Cc]ookie: *\\(ghost-admin-api-session=[^;]*\\).*/HPXG1 cookie \\1/p\' "$T/h" 2>/dev/null | head -n 1',
    'echo "HPXG1 body $(head -c 262144 "$T/b" 2>/dev/null | base64 -w0)"',
    'echo "HPXG1 end"',
  ].join('\n')
}

/** A request script's answer, or null when it did not finish or nothing answered. */
export function parseAnswer(out: string): GhostAnswer | null {
  let status: number | null = null, body = '', cookie: string | undefined, ended = false
  for (const raw of out.split('\n')) {
    const l = raw.replace(/\r$/, '')
    let m: RegExpExecArray | null
    if (l === 'HPXG1 end') { ended = true; break }
    if ((m = /^HPXG1 status (\d{3})$/.exec(l))) status = Number(m[1])
    else if ((m = /^HPXG1 cookie (\S+)$/.exec(l)) && COOKIE_RE.test(m[1])) cookie = m[1]
    else if ((m = /^HPXG1 body ([A-Za-z0-9+/=]*)$/.exec(l))) body = Buffer.from(m[1], 'base64').toString('utf8')
  }
  if (!ended || status === null || status === 0) return null
  return { status, body, ...(cookie ? { cookie } : {}) }
}

/** Ghost over the node login: each request a short script in the container (never added to the job's log). */
export function ghostOverShell(siteUrl: string, sh: Shell): GhostHttp {
  return async r => {
    const out = await sh(requestScript(siteUrl, r), 60_000).catch(() => null)
    return out ? parseAnswer(out.output) : null
  }
}

/** An Admin API token for `id:secret`: HS256 over the hex secret, five minutes, audience /admin/. */
export function adminToken(key: string, nowMs: number): string {
  const m = /^([0-9a-f]{24}):([0-9a-f]{64})$/.exec(key)
  if (!m) throw new Error('That is not a Ghost Admin API key.')
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const iat = Math.floor(nowMs / 1000)
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT', kid: m[1] })}.${b64({ iat, exp: iat + 300, aud: '/admin/' })}`
  return `${unsigned}.${createHmac('sha256', Buffer.from(m[2], 'hex')).update(unsigned).digest('base64url')}`
}

/** Replace every known secret in a message, longest first. */
export function redact(msg: string, secrets: Array<string | undefined>): string {
  let out = msg
  for (const v of [...new Set(secrets.filter((x): x is string => typeof x === 'string' && x.length >= 6))].sort((a, b) => b.length - a.length)) out = out.split(v).join('[hidden]')
  return out
}

const json = (s: string): any => { try { return JSON.parse(s) } catch { return null } }
/** Ghost's own words for a refusal, short. */
const why = (a: GhostAnswer) => {
  const e = json(a.body)?.errors?.[0]
  const t = [e?.message, e?.context].filter((x: unknown) => typeof x === 'string' && x).join(' ')
  return t ? `: ${t.slice(0, 300).replace(/[.\s]+$/, '')}` : ''
}

export interface StepRef { status: string; detail?: string }

export interface GhostSetupInput {
  /** The site's address, as Ghost's `url` is set: Host and Origin come from it. */
  url: string
  owner: { name: string; email: string; password: string }
  title: string
  description: string
  mail: boolean
  vault: { category: string; provider: string }
}

export interface GhostSetupDeps {
  http: GhostHttp
  sh: Shell
  wait(ms: number): Promise<unknown>
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  now(): number
  /** Stop the whole container, when Compose cannot stop Ghost. */
  stopContainer?: () => Promise<boolean>
}

export const SETUP = '/ghost/api/admin/authentication/setup/'

/** Forms of the setup endpoint a write must never reach through nginx: plain, versioned, upper case, no slash. */
export const SETUP_VARIANTS = [
  '/ghost/api/admin/authentication/setup/', '/ghost/api/v4/admin/authentication/setup/', '/ghost/api/v6.0/admin/authentication/setup/',
  '/GHOST/API/ADMIN/AUTHENTICATION/SETUP/', '/ghost/api/admin/authentication/setup', '/ghost//api/admin/authentication/Setup/',
]

/**
 * Read the site back through nginx (port 80, as the network sees it): Ghost's site endpoint answers, and a POST and a
 * PUT to every form of the setup endpoint are refused. Prints one line: `HPXO site <code> setup <code>...`.
 */
export function openReadbackScript(siteUrl: string): string {
  const { host, proto } = siteParts(siteUrl)
  const curl = (method: string, path: string) =>
    `$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' -X ${method} -H 'Host: ${host}' -H 'X-Forwarded-Proto: ${proto}' -H 'Content-Type: application/json' ${method === 'GET' ? '' : `--data '{"setup":[{}]}' `}'http://127.0.0.1${path}' || echo 000)`
  return [
    'set -u',
    `echo "HPXO site ${curl('GET', '/ghost/api/admin/site/')} setup ${SETUP_VARIANTS.flatMap(p => [curl('POST', p), curl('PUT', p)]).join(' ')}"`,
  ].join('\n')
}

/** The read-back's codes, or null when it did not answer. */
export function parseOpenReadback(out: string): { site: number; setup: number[] } | null {
  const m = /^HPXO site (\d{3}) setup ((?:\d{3} ?)+)$/m.exec(out)
  return m ? { site: Number(m[1]), setup: m[2].trim().split(' ').map(Number) } : null
}

/** Whether Ghost says it has an owner: true, false, or null when it did not say. */
async function isSetUp(d: GhostSetupDeps): Promise<{ answered: boolean; setup: boolean | null }> {
  const a = await d.http({ method: 'GET', path: SETUP })
  if (!a) return { answered: false, setup: null }
  const s = json(a.body)?.setup?.[0]?.status
  return { answered: a.status === 200, setup: a.status === 200 && typeof s === 'boolean' ? s : null }
}

/**
 * Ghost's first run. Throws at the first failure, after stopping Ghost and nginx, with every secret hidden.
 * Returns the Admin API key's integration name for the record.
 */
export async function runGhostSetup(input: GhostSetupInput, step: (id: string) => StepRef, d: GhostSetupDeps): Promise<{ integration: string }> {
  const hidden: Array<string | undefined> = [input.owner.password]
  try {
    return await setup(input, step, d, hidden)
  } catch (e: any) {
    const msg = redact(String(e?.message ?? e), hidden)
    throw new Error(`${msg} ${stoppedSentence(await stopGhost(d.sh, d.stopContainer))}`)
  }
}

async function setup(input: GhostSetupInput, step: (id: string) => StepRef, d: GhostSetupDeps, hidden: Array<string | undefined>): Promise<{ integration: string }> {
  // 1. Ghost answers, and its setup waits. MySQL's first start and Ghost's migrations take a minute or two.
  let s = step('ghost-start')
  let state = { answered: false, setup: null as boolean | null }
  for (let i = 0; i < 60; i++) {
    state = await isSetUp(d)
    if (state.answered && state.setup !== null) break
    await d.wait(5000)
  }
  if (!state.answered || state.setup === null) throw new Error('Ghost did not answer on the container\'s loopback within five minutes. See `docker compose logs ghost` in /opt/ghost.')
  if (state.setup) throw new Error('Ghost already has an owner that HyperProx did not make, so nothing was changed.')
  s.status = 'done'; s.detail = 'Ghost answers on 127.0.0.1 only; nginx serves a holding page and does not reach it'

  // 2. The owner, the title and the description, in Ghost's own setup call; then read back.
  s = step('ghost-owner')
  const made = await d.http({ method: 'POST', path: SETUP, body: { setup: [{
    name: input.owner.name, email: input.owner.email, password: input.owner.password, blogTitle: input.title,
    ...(input.description ? { description: input.description } : {}),
  }] } })
  if (!made) throw new Error('Ghost did not answer the owner account request.')
  if (made.status !== 201) throw new Error(`Ghost refused the owner account (${made.status})${why(made)}.`)
  const after = await isSetUp(d)
  if (after.setup !== true) throw new Error('Ghost did not read back as set up after the owner account was made.')
  s.status = 'done'; s.detail = `owner ${input.owner.email}; the setup is closed`

  // 3. Only now does nginx proxy to Ghost (it served a 503 holding page until here). Read back as the network sees it.
  s = step('ghost-open')
  const opened = await d.sh(GHOST_OPEN_SCRIPT, 60_000).catch(() => null)
  if (!opened || !/@@ghost open/.test(opened.output)) {
    throw new Error(/@@ghost nginx refused/.test(opened?.output ?? '') ? 'nginx refused the Ghost site\'s configuration, so the holding page was kept.' : 'The Ghost site could not be turned on in nginx.')
  }
  const back = parseOpenReadback((await d.sh(openReadbackScript(input.url), 120_000).catch(() => null))?.output ?? '')
  if (!back) throw new Error('nginx did not answer when the Ghost site was read back.')
  if (back.site !== 200) throw new Error(`Through nginx, Ghost's site answered ${back.site}, not 200.`)
  const open = back.setup.findIndex(c => c !== 403)
  if (open >= 0 || back.setup.length !== SETUP_VARIANTS.length * 2) {
    throw new Error(`Through nginx, a write to ${SETUP_VARIANTS[Math.floor(Math.max(open, 0) / 2)]} answered ${back.setup[open] ?? 'nothing'}, not 403.`)
  }
  s.status = 'done'; s.detail = `nginx serves Ghost; writes to its setup (${SETUP_VARIANTS.length} forms) are refused with 403`

  // 4. One sign-in as the owner, to make HyperProx's integration. Its Admin API key goes into the vault first,
  //    then the title is read back with that key, and the session is ended.
  s = step('ghost-key')
  const login = await d.http({ method: 'POST', path: '/ghost/api/admin/session/', body: { username: input.owner.email, password: input.owner.password } })
  if (!login) throw new Error('Ghost did not answer the sign-in.')
  if (login.status !== 201 || !login.cookie) throw new Error(`Ghost refused HyperProx's sign-in as the owner (${login.status})${why(login)}.`)
  hidden.push(login.cookie, login.cookie.split('=')[1])
  const cookie = login.cookie
  const name = 'HyperProx'
  try {
    const added = await d.http({ method: 'POST', path: '/ghost/api/admin/integrations/?include=api_keys', cookie,
      body: { integrations: [{ name, description: 'Made by HyperProx at setup. It reads the version, post and member counts for the Sites card.' }] } })
    if (!added) throw new Error('Ghost did not answer the integration request.')
    if (added.status !== 201) throw new Error(`Ghost refused the integration (${added.status})${why(added)}.`)
    const k = (json(added.body)?.integrations?.[0]?.api_keys ?? []).find((x: any) => x?.type === 'admin')
    // Ghost's API sends an admin key's secret already as the whole key, `id:secret` (the database holds the two apart).
    const key = k && typeof k.id === 'string' && typeof k.secret === 'string' ? (k.secret.includes(':') ? k.secret : `${k.id}:${k.secret}`) : ''
    if (!/^[0-9a-f]{24}:[0-9a-f]{64}$/.test(key)) throw new Error('Ghost made the integration but sent no Admin API key.')
    hidden.push(key, key.split(':')[1])
    await d.saveSecrets(input.vault.category, input.vault.provider, { admin_api_key: key })
    // Read back with the key itself: it works, and Ghost holds the title (and description) that were asked for.
    const read = await d.http({ method: 'GET', path: '/ghost/api/admin/settings/', token: adminToken(key, d.now()) })
    if (!read || read.status !== 200) throw new Error(`The Admin API key did not work (${read?.status ?? 'no answer'}).`)
    const settings: any[] = json(read.body)?.settings ?? []
    const value = (k: string) => settings.find(x => x?.key === k)?.value
    if (value('title') !== input.title) throw new Error(`Ghost's title read back as "${String(value('title') ?? '')}", not "${input.title}".`)
    if (input.description && value('description') !== input.description) throw new Error('Ghost\'s description did not read back as it was set.')
  } finally {
    // The owner's session is ended whatever happened: HyperProx keeps only the key.
    await d.http({ method: 'DELETE', path: '/ghost/api/admin/session/', cookie }).catch(() => null)
  }
  s.status = 'done'; s.detail = `integration "${name}" made; its Admin API key is in the vault, and the title reads back`

  // 5. Mail: with an SMTP server, Ghost's new-device sign-in codes go back on (its default), now nothing signs in.
  await mailStep(input, step, d)
  return { integration: name }
}

async function mailStep(input: GhostSetupInput, step: (id: string) => StepRef, d: GhostSetupDeps): Promise<void> {
  const s = step('ghost-mail')
  if (!input.mail) { s.status = 'skipped'; s.detail = NO_MAIL; return }
  const r = await d.sh([
    'set -e', `cd ${GHOST_DIR}`,
    'sed -i \'s/^security__staffDeviceVerification=false$/security__staffDeviceVerification=true/\' ghost.env',
    'grep -qx \'security__staffDeviceVerification=true\' ghost.env',
    'docker compose up -d --quiet-pull ghost >/dev/null 2>&1',
    'echo "@@ghost mail on"',
  ].join('\n'), 180_000).catch(() => null)
  if (!r || !/@@ghost mail on/.test(r.output)) throw new Error('Ghost\'s mail settings could not be turned on.')
  let up = false
  for (let i = 0; i < 24 && !up; i++) { await d.wait(5000); up = (await isSetUp(d)).setup === true }
  if (!up) throw new Error('Ghost did not come back after its mail settings were turned on.')
  s.status = 'done'; s.detail = 'staff invites and member links can be sent; new-device sign-in codes are on'
}

/** What a failure message says about what it stopped. */
export function stoppedSentence(stopped: 'apps' | 'container' | null): string {
  return stopped === 'apps' ? 'Ghost and nginx were stopped, so nothing is left running half set up; clean up the install or run it again.'
    : stopped === 'container' ? 'Ghost could not be stopped on its own, so the whole container was stopped; clean up the install or run it again.'
      : 'Ghost could not be stopped: stop the container yourself before anyone reaches it.'
}

/** `docker compose stop` and nginx, then the container itself if that fails. */
export async function stopGhost(sh: Shell, stopContainer?: () => Promise<boolean>): Promise<'apps' | 'container' | null> {
  const r = await sh(`cd ${GHOST_DIR} && docker compose stop >/dev/null 2>&1 && systemctl stop nginx && echo "@@ghost stopped"\n`, 180_000).catch(() => null)
  if (r && /@@ghost stopped/.test(r.output)) return 'apps'
  return (await stopContainer?.().catch(() => false)) ? 'container' : null
}

// ── The SMTP password, between the preview and the install ──────────────────

/** Where a preview keeps the SMTP password until its install reads it: one vault item per preview. */
export const pendingSmtpItem = (ref: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)) throw new Error('No SMTP password is planned for this install. Check the plan again.')
  return { category: 'apps', provider: `ghost-smtp-pending-${ref}` }
}
/** The pending SMTP items and when each lapses, so a preview nobody applied does not leave its password behind. */
export const SMTP_PENDING_INDEX = { category: 'apps', provider: 'ghost-smtp-pending', key: 'refs' }
export const SMTP_PENDING_TTL_MS = 30 * 60_000

interface VaultRW {
  saveSecrets(c: string, p: string, v: Record<string, string>): Promise<void>
  readSecrets(c: string, p: string): Promise<Record<string, string>>
  deleteSecrets(c: string, p: string): Promise<void>
}

async function updateSmtpIndex(d: VaultRW, now: number, o: { add?: string; remove?: string } = {}): Promise<void> {
  let idx: Record<string, number> = {}
  try { const v = JSON.parse((await d.readSecrets(SMTP_PENDING_INDEX.category, SMTP_PENDING_INDEX.provider))?.[SMTP_PENDING_INDEX.key] ?? '{}'); if (v && typeof v === 'object') idx = v } catch { /* empty */ }
  for (const [ref, at] of Object.entries(idx)) {
    if (ref === o.remove || !(Number(at) > now)) {
      await d.deleteSecrets(SMTP_PENDING_INDEX.category, `ghost-smtp-pending-${ref}`).catch(() => {})
      delete idx[ref]
    }
  }
  if (o.add) idx[o.add] = now + SMTP_PENDING_TTL_MS
  await d.saveSecrets(SMTP_PENDING_INDEX.category, SMTP_PENDING_INDEX.provider, { [SMTP_PENDING_INDEX.key]: JSON.stringify(idx) })
}

const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/

/**
 * Ghost's part of the preview: the SMTP password goes straight into the vault (only this preview names it), and
 * the checks say what mail will and will not do. `values` are the options after checkOptions.
 */
export async function ghostPreview(values: Record<string, string>, smtpPassword: unknown, d: VaultRW, now = Date.now()):
  Promise<{ errors: string[]; checks: string[]; warnings: string[]; options: Record<string, string> }> {
  const options = { ...values, GHOST_SMTP_REF: '' }
  const errors: string[] = [], checks: string[] = [], warnings: string[] = []
  checks.push(`The owner ${values.GHOST_OWNER_EMAIL || '…'} is made through Ghost's setup API, with a generated password kept in the vault; its setup page is never open to the network.`)
  if (!values.GHOST_SMTP_HOST) { warnings.push(NO_MAIL); return { errors, checks, warnings, options } }
  if (values.GHOST_SMTP_USER) {
    const pw = typeof smtpPassword === 'string' ? smtpPassword : ''
    if (!pw || pw.length > 300 || !ONE_LINE.test(pw)) { errors.push('Enter the SMTP password for that user (one line).'); return { errors, checks, warnings, options } }
    const ref = randomUUID()
    const item = pendingSmtpItem(ref)
    await d.saveSecrets(item.category, item.provider, { smtp_password: pw })
    await updateSmtpIndex(d, now, { add: ref })
    options.GHOST_SMTP_REF = ref
    checks.push('The SMTP password is in the vault; the install reads it from there.')
  }
  checks.push(`Mail through ${values.GHOST_SMTP_HOST}:${values.GHOST_SMTP_PORT || '587'}: staff invites and member sign-in links work, and new-device sign-in codes are turned on after setup.`)
  return { errors, checks, warnings, options }
}

/**
 * What the install needs from Ghost's options: the site's address, ghost.env, and the SMTP password (read from the
 * preview's vault item, to go into the site's own item and the script, then the pending item is deleted).
 */
export async function ghostInstallEnv(o: { options: Record<string, string>; domain?: string; ip?: string }, d: Pick<VaultRW, 'readSecrets'>):
  Promise<{ env: Record<string, string>; vault: Record<string, string>; pendingRef?: string }> {
  const url = o.domain ? `https://${o.domain}` : o.ip ? `http://${o.ip}` : ''
  if (!url) throw new Error('Ghost needs its address for its url setting, and the container has none.')
  const v = o.options
  const env: Record<string, string> = {
    GHOST_URL: url,
    GHOST_ENV_FILE: ghostEnvFile({ url, smtpHost: v.GHOST_SMTP_HOST, smtpPort: v.GHOST_SMTP_PORT, smtpSecure: v.GHOST_SMTP_SECURE, smtpUser: v.GHOST_SMTP_USER, smtpFrom: v.GHOST_SMTP_FROM }),
    GHOST_SMTP_PASSWORD: '',
  }
  if (!v.GHOST_SMTP_HOST || !v.GHOST_SMTP_USER) return { env, vault: {} }
  const item = pendingSmtpItem(v.GHOST_SMTP_REF ?? '')
  const pw = (await d.readSecrets(item.category, item.provider).catch(() => ({} as Record<string, string>))).smtp_password
  if (!pw) throw new Error('The SMTP password is no longer in the vault. Check the plan again and re-enter it.')
  env.GHOST_SMTP_PASSWORD = pw
  return { env, vault: { smtp_password: pw }, pendingRef: v.GHOST_SMTP_REF }
}

/** After the site's own vault item holds the SMTP password: drop the preview's copy. */
export async function dropPendingSmtp(ref: string, d: VaultRW): Promise<void> {
  const item = pendingSmtpItem(ref)
  await d.deleteSecrets(item.category, item.provider).catch(() => {})
  await updateSmtpIndex(d, Date.now(), { remove: ref }).catch(() => {})
}
