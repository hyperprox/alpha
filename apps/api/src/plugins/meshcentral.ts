// =============================================================================
//  Plug-in — MeshCentral (app updates)
//
//  MeshCentral is usually installed with npm into a directory and run by a
//  systemd unit, so apt and docker never see it. This plug-in contributes an
//  app-update provider that finds it, reads the npm registry and the project's
//  GitHub releases and advisories, and updates it through the npm-app helper.
//
//  Two lessons are built in:
//
//    - Its self-update restarts the server while npm is still installing the
//      new dependencies, and the first sign-in then dies with MODULE_NOT_FOUND.
//      The helper stops the unit first and starts it only once `npm ls` is clean.
//
//    - From 1.2.1 MeshCentral refuses a browser session whose Origin hostname is
//      not the certificate name, the domain's `dns`, or in `allowedOrigin`
//      (webserver.js CheckWebServerOriginName). Behind a reverse proxy on another
//      hostname every sign-in then fails with "Invalid origin in HTTP request",
//      while /health.ashx still answers "ok". So the pre-flight replays that check
//      against the public hostnames, and verify() opens control.ashx through the
//      public URL with a browser's Origin header and reads the answer.
//
//  Config keys are matched case-insensitively, as MeshCentral lower-cases every
//  key it reads. A config change is only ever proposed as a separate fix.
// =============================================================================

import { createHash } from 'node:crypto'
import type {
  AppContext, AppFix, AppInstall, AppIssue, AppRelease, AppStepResult, AppUpdateProvider, Plugin, PluginContext, PluginTileData,
} from '../lib/plugin-host'
import {
  type NpmInstall, describeNpmInstall, detectNpmInstalls, installKey, npmApply, npmFactsScript, npmRelease, npmUpdateBlocker,
  parseNpmFacts, waitForSteadyService,
} from '../lib/app-updates/npm-app'
import { compareVersions, isSafeAbsPath, isUnitName, isVersion, shq } from '../lib/app-updates/versions'

const PKG = 'meshcentral'
const GITHUB = 'Ylianst/MeshCentral'
/** The first version that checks the Origin of browser sessions. */
export const ORIGIN_CHECK_SINCE = '1.2.1'

export interface MeshFacts {
  npm:        NpmInstall
  datapath:   string
  configFile: string
  configText: string | null
  config:     any
  /** The name MeshCentral compares origins with: its web certificate's CN. */
  certName:   string
  port:       number
  errLog:     { size: number; mtime: number } | null
}

const facts = (i: AppInstall) => i.facts as unknown as MeshFacts

// --- Config, the way MeshCentral reads it ------------------------------------------

/**
 * A key, case-insensitively. MeshCentral lower-cases keys in place, so a mixed-case
 * spelling overwrites an all-lowercase one wherever they both appear.
 */
export function ciKey(obj: any, key: string): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const want = key.toLowerCase()
  const keys = Object.keys(obj).filter(k => k.toLowerCase() === want)
  return keys.find(k => k !== want) ?? keys[0]
}

export function ciGet(obj: any, key: string): any {
  const k = ciKey(obj, key)
  return k === undefined ? undefined : obj[k]
}

export interface OriginVerdict { ok: boolean; reason: string }

/**
 * CheckWebServerOriginName, replayed for a browser on https://<hostname>. The request reaches
 * the domain whose `dns` is that hostname, or the default domain.
 */
export function originVerdict(config: any, certName: string, hostname: string): OriginVerdict {
  const host = hostname.toLowerCase()   // URL parsing lower-cases the Origin hostname
  const domains = ciGet(config, 'domains')
  let domain: any = domains && typeof domains === 'object' ? (domains[''] ?? {}) : {}
  let where = 'the default domain'
  if (domains && typeof domains === 'object') {
    for (const [id, d] of Object.entries(domains)) {
      const dns = ciGet(d, 'dns')
      if (id !== '' && typeof dns === 'string' && dns.toLowerCase() === host) { domain = d; where = `domain "${id}"` }
    }
  }
  const allowed = ciGet(domain, 'allowedorigin')
  if (allowed === true) return { ok: true, reason: `allowedOrigin is true in ${where}: any origin is accepted` }
  if (Array.isArray(allowed)) {
    if (allowed.includes(host)) return { ok: true, reason: `${host} is in allowedOrigin of ${where}` }
    const caseOnly = allowed.some(a => typeof a === 'string' && a.toLowerCase() === host)
    return { ok: false, reason: caseOnly ? `allowedOrigin of ${where} lists ${host} with different capitals, and MeshCentral compares exactly` : `${host} is not in allowedOrigin of ${where} (${JSON.stringify(allowed)})` }
  }
  const dns = ciGet(domain, 'dns')
  if (typeof dns === 'string') return dns === host ? { ok: true, reason: `${host} is the dns of ${where}` } : { ok: false, reason: `${where} has dns ${dns}` }
  // getWebServerName(): without a configured certificate name MeshCentral uses the Host header.
  if (certName === 'un-configured') return { ok: true, reason: 'no certificate name is configured, so MeshCentral compares with the Host header the proxy forwards' }
  return certName === host
    ? { ok: true, reason: `${host} is the certificate name` }
    : { ok: false, reason: `MeshCentral's certificate name is ${certName} and ${where} has no allowedOrigin` }
}

/** The config with domains[""].allowedOrigin set to `list`, keeping whatever spelling of the key is there. */
export function withAllowedOrigin(config: any, list: string[]): any {
  const next = JSON.parse(JSON.stringify(config ?? {}))
  const dk = ciKey(next, 'domains') ?? 'domains'
  if (!next[dk] || typeof next[dk] !== 'object' || Array.isArray(next[dk])) next[dk] = {}
  if (!next[dk][''] || typeof next[dk][''] !== 'object' || Array.isArray(next[dk][''])) next[dk][''] = {}
  const def = next[dk]['']
  const ak = ciKey(def, 'allowedorigin') ?? 'allowedOrigin'
  def[ak] = list
  return next
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The allowedOrigin list that lets every public hostname in without shutting out a name that
 * works today: once the list exists MeshCentral checks ONLY the list, so the certificate name
 * goes in too.
 */
export function proposedAllowedOrigin(config: any, certName: string, hostnames: string[]): string[] {
  const def = ciGet(ciGet(config, 'domains'), '') ?? {}
  const current = ciGet(def, 'allowedorigin')
  const out: string[] = []
  const add = (h: unknown) => { if (typeof h === 'string') { const l = h.toLowerCase(); if (HOSTNAME.test(l) && !out.includes(l)) out.push(l) } }
  if (Array.isArray(current)) current.forEach(add)
  else if (certName !== 'un-configured') add(certName)
  hostnames.forEach(add)
  return out
}

export function fixFor(f: MeshFacts, hostnames: string[]): AppFix | null {
  if (f.configText === null || !f.config) return null
  const list = proposedAllowedOrigin(f.config, f.certName, hostnames)
  if (!hostnames.every(h => list.includes(h.toLowerCase()))) return null
  const id = createHash('sha256').update(`${f.configFile}\n${f.configText}\n${JSON.stringify(list)}`).digest('hex').slice(0, 12)
  return {
    id,
    description: `Add ${hostnames.join(', ')} to MeshCentral's allowedOrigin so browsers on the public URL are accepted`,
    file: f.configFile,
    change: `domains[""].allowedOrigin = ${JSON.stringify(list)}\n` +
      `(the rest of ${f.configFile} is unchanged; the file is rewritten as formatted JSON and the old one is kept beside it as config.json.hp-<time>.bak; MeshCentral is restarted to read it)`,
  }
}

// --- Public URLs --------------------------------------------------------------------

function parseUrls(text: string | undefined): URL[] {
  const out: URL[] = []
  for (const s of (text ?? '').split(/[\s,]+/).filter(Boolean)) {
    try { const u = new URL(s); if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u) } catch { /* ignored */ }
  }
  return out
}

/** The plug-in's public_url setting, else the proxy hosts HyperProx manages that forward to this guest's MeshCentral port. */
export async function publicUrls(f: MeshFacts, ctx: AppContext): Promise<URL[]> {
  const set = parseUrls(ctx.option('public_url'))
  if (set.length) return set.slice(0, 5)
  try { return parseUrls((await ctx.proxiedUrls([f.port])).join(' ')).slice(0, 5) }
  catch (e: any) { ctx.log(`proxy hosts could not be read: ${e.message}`); return [] }
}

// --- Guest reads --------------------------------------------------------------------

/** Read-only: the web certificate's common name, and mesherrors.txt's size and mtime. */
export function meshFactsScript(datapath: string): string {
  if (!isSafeAbsPath(datapath)) throw new Error(`unsafe data path: ${datapath}`)
  return [
    `dp=${shq(datapath)}`,
    'c="$dp/webserver-cert-public.crt"',
    'if [ -f "$c" ] && [ ! -L "$c" ] && command -v openssl >/dev/null 2>&1; then',
    '  cn=$(openssl x509 -noout -subject -nameopt multiline -in "$c" 2>/dev/null | sed -n "s/^ *commonName *= *//p" | head -n 1)',
    '  echo "HP_CN $(printf %s "$cn" | base64 -w0)"',
    'fi',
    'e="$dp/mesherrors.txt"',
    'if [ -f "$e" ]; then echo "HP_ERRLOG $(stat -c "%s %Y" "$e")"; else echo "HP_ERRLOG 0 0"; fi',
  ].join('\n')
}

export function parseMeshFacts(output: string): { cn: string | null; errLog: { size: number; mtime: number } | null } {
  const cn = /^HP_CN (\S*)$/m.exec(output)?.[1]
  const e = /^HP_ERRLOG (\d+) (\d+)$/m.exec(output)
  return {
    cn: cn ? Buffer.from(cn, 'base64').toString('utf8').trim() || null : null,
    errLog: e ? { size: Number(e[1]), mtime: Number(e[2]) } : null,
  }
}

/** The new part of mesherrors.txt since `from` bytes, last lines only. */
export function errLogTailScript(datapath: string, from: number): string {
  if (!isSafeAbsPath(datapath)) throw new Error(`unsafe data path: ${datapath}`)
  return `tail -c +${Math.max(1, Math.floor(from) + 1)} ${shq(`${datapath}/mesherrors.txt`)} 2>/dev/null | tail -n 15`
}

async function readMesh(ctx: AppContext, npm: NpmInstall): Promise<MeshFacts> {
  let config: any = null
  const configText = npm.files.config ?? null
  if (configText !== null) { try { config = JSON.parse(configText) } catch { config = null } }
  const settings = ciGet(config, 'settings')
  const dpSetting = ciGet(settings, 'datapath')
  const dpArg = /--datapath\s+(\/\S+)/.exec(npm.command)?.[1]
  const datapath = [dpArg, dpSetting].find(p => typeof p === 'string' && isSafeAbsPath(p)) ?? `${npm.dir}/meshcentral-data`
  const extra = await ctx.run(meshFactsScript(datapath), { timeoutMs: 30_000 }).catch(() => ({ code: -1, output: '', timedOut: false }))
  const parsed = parseMeshFacts(extra.output)
  const certSetting = ciGet(settings, 'cert')
  const port = Number(ciGet(settings, 'port'))
  return {
    npm, datapath, configFile: `${npm.dir}/meshcentral-data/config.json`, configText, config,
    certName: parsed.cn ?? (typeof certSetting === 'string' && certSetting ? certSetting : 'un-configured'),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 443,
    errLog: parsed.errLog,
  }
}

function toInstall(f: MeshFacts): AppInstall {
  return {
    key: installKey(f.npm.dir), name: 'MeshCentral', installed: f.npm.installed, location: f.npm.dir,
    runAs: f.npm.owner, service: f.npm.unit, running: f.npm.active, how: describeNpmInstall(f.npm),
    facts: f as unknown as Record<string, unknown>,
  }
}

// --- Verification -------------------------------------------------------------------

const wsUrl = (u: URL) => {
  const base = new URL(u.toString())
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const w = new URL('control.ashx', base)
  w.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return w.toString()
}

/** Load the login page and open control.ashx as a browser on `u` would. */
export async function probePublicUrl(u: URL, ctx: AppContext): Promise<{ ok: boolean; detail: string }> {
  const insecure = /^(1|yes|true)$/i.test(ctx.option('insecure_tls') ?? '')
  const origin = u.origin
  try {
    const page = await ctx.http(u.toString(), { headers: { Origin: origin }, timeoutMs: 20_000, insecureTLS: insecure })
    if (page.status >= 400) return { ok: false, detail: `${u} answered HTTP ${page.status}` }
    if (!/meshcentral/i.test(page.body)) return { ok: false, detail: `${u} answered, but not with a MeshCentral page` }
  } catch (e: any) { return { ok: false, detail: `${u} could not be loaded: ${e.message}` } }
  const ws = await ctx.wsProbe(wsUrl(u), { origin, timeoutMs: 20_000, insecureTLS: insecure })
  if (!ws.upgraded) return { ok: false, detail: `control.ashx on ${u.host} did not open a websocket: ${ws.error ?? `HTTP ${ws.status}`}` }
  if (ws.firstMessage && /invalidorigin/i.test(ws.firstMessage)) {
    return { ok: false, detail: `MeshCentral refused the origin ${origin} ("Invalid origin in HTTP request" for every browser on ${u.host}); approve the allowedOrigin fix or add the hostname by hand` }
  }
  if (!ws.firstMessage) return { ok: false, detail: `control.ashx on ${u.host} closed without answering` }
  return { ok: true, detail: `${u.host}: login page loads, control.ashx accepts the origin (${ws.firstMessage.slice(0, 80)})` }
}

async function errLogGrowth(ctx: AppContext, f: MeshFacts, baseline: unknown): Promise<string | null> {
  const before = (baseline as { errLog?: { size: number } } | null)?.errLog
  const now = parseMeshFacts((await ctx.run(meshFactsScript(f.datapath), { timeoutMs: 30_000 })).output).errLog
  if (!now || !before || now.size <= before.size) return null
  const t = await ctx.run(errLogTailScript(f.datapath, before.size), { timeoutMs: 30_000 })
  return t.output.trim().slice(-1500) || `${now.size - before.size} new bytes`
}

async function stateOf(ctx: AppContext, f: MeshFacts) {
  const owner = f.npm.unitUser && /^[a-z_][a-z0-9_-]*$/i.test(f.npm.unitUser) ? f.npm.unitUser : f.npm.owner
  return { unit: f.npm.unit!, owner }
}

// --- The provider -------------------------------------------------------------------

export const meshcentralProvider: AppUpdateProvider = {
  id: 'meshcentral',
  name: 'MeshCentral',

  async detect(ctx) {
    const installs = await detectNpmInstalls(ctx, PKG, { config: 'meshcentral-data/config.json' })
    const out: AppInstall[] = []
    for (const npm of installs) out.push(toInstall(await readMesh(ctx, npm)))
    return out
  },

  async latest(install, ctx): Promise<AppRelease> {
    return npmRelease(ctx, PKG, install.installed, { github: GITHUB })
  },

  async preflight(install, target, ctx): Promise<AppIssue[]> {
    const f = facts(install)
    const issues: AppIssue[] = []
    const blocker = npmUpdateBlocker(f.npm)
    if (blocker && target) issues.push({ message: `HyperProx will not update it: ${blocker}`, blocking: true })

    const version = target ?? install.installed
    const checks = isVersion(version) && compareVersions(version, ORIGIN_CHECK_SINCE) >= 0
    const urls = await publicUrls(f, ctx)
    if (!urls.length) {
      issues.push({ message: 'No public URL is known (set public_url in the MeshCentral plug-in, or proxy it through a proxy host HyperProx manages), so the origin check cannot be predicted or verified through it', blocking: false })
      return issues
    }
    if (f.configText !== null && !f.config) {
      issues.push({ message: `${f.configFile} is not valid JSON, so the origin check cannot be predicted`, blocking: checks })
      return issues
    }
    const hosts = [...new Set(urls.map(u => u.hostname.toLowerCase()))]
    const failing = hosts.map(h => ({ h, v: originVerdict(f.config ?? {}, f.certName, h) })).filter(x => !x.v.ok)
    if (failing.length) {
      const fix = fixFor(f, failing.map(x => x.h)) ?? undefined
      const when = checks
        ? (target ? `MeshCentral ${version} will refuse` : `MeshCentral ${version} refuses`)
        : `from ${ORIGIN_CHECK_SINCE} MeshCentral will refuse`
      issues.push({
        message: `${when} browsers on ${failing.map(x => x.h).join(', ')} with "Invalid origin in HTTP request": ${failing.map(x => x.v.reason).join('; ')}`,
        blocking: checks,
        ...(fix ? { fix } : {}),
      })
    }
    return issues
  },

  async baseline(install, ctx) {
    const f = facts(install)
    return { errLog: parseMeshFacts((await ctx.run(meshFactsScript(f.datapath), { timeoutMs: 30_000 })).output).errLog }
  },

  async apply(install, version, ctx): Promise<AppStepResult> {
    return npmApply(ctx, facts(install).npm, version)
  },

  async verify(install, version, ctx, baseline): Promise<AppStepResult> {
    const f = facts(install)
    if (!f.npm.unit) return { ok: false, message: 'no system unit to check' }
    const notes: string[] = []

    // The version on disk is the one asked for.
    const r = await ctx.run(npmFactsScript(f.npm.dir, PKG), { timeoutMs: 30_000 })
    let onDisk: unknown = null
    try { onDisk = JSON.parse(parseNpmFacts(r.output).files.installed ?? 'null')?.version } catch { onDisk = null }
    if (onDisk !== version) return { ok: false, message: `node_modules/${PKG} is at ${String(onDisk ?? 'unknown')}, not ${version}` }

    // Running, on one pid, with no npm still installing modules behind it.
    const { unit, owner } = await stateOf(ctx, f)
    const steady = await waitForSteadyService(ctx, unit, owner)
    if (!steady.ok) return { ok: false, message: `${unit} is not running steadily: ${steady.detail}` }
    notes.push(steady.detail)

    const crash = await errLogGrowth(ctx, f, baseline)
    if (crash) return { ok: false, message: 'mesherrors.txt recorded a crash since the update started', output: crash }

    // Through the public URL, as a browser: the page, then control.ashx with a real Origin.
    const urls = await publicUrls(f, ctx)
    if (!urls.length) notes.push('no public URL known: the origin check was not made (set public_url in the MeshCentral plug-in)')
    for (const u of urls) {
      const p = await probePublicUrl(u, ctx)
      if (!p.ok) return { ok: false, message: p.detail }
      notes.push(p.detail)
    }

    // The probes are what crashed it last time: it must still be up, on the same pid, with no new errors.
    await ctx.sleep(3_000)
    const after = await waitForSteadyService(ctx, unit, owner, { steadyMs: 0, maxMs: 30_000 })
    if (!after.ok || after.pid !== steady.pid) return { ok: false, message: `${unit} restarted or stopped after the sign-in checks (${after.detail})` }
    const crash2 = await errLogGrowth(ctx, f, baseline)
    if (crash2) return { ok: false, message: 'mesherrors.txt recorded a crash during the checks', output: crash2 }
    return { ok: true, message: `MeshCentral ${version} verified`, output: notes.join('\n') }
  },

  async applyFix(install, fixId, ctx): Promise<AppStepResult> {
    const f = facts(install)
    const urls = await publicUrls(f, ctx)
    const failing = [...new Set(urls.map(u => u.hostname.toLowerCase()))].filter(h => !originVerdict(f.config ?? {}, f.certName, h).ok)
    if (!failing.length) return { ok: true, message: 'nothing to change: every public hostname already passes the origin check' }
    const fix = fixFor(f, failing)
    if (!fix) return { ok: false, message: `${f.configFile} cannot be changed automatically (not readable as JSON)` }
    if (fix.id !== fixId) return { ok: false, message: 'the configuration or the public URLs changed since this fix was approved; review and approve it again' }
    if (!f.npm.unit || !isUnitName(f.npm.unit)) return { ok: false, message: 'no system unit to restart' }
    const list = proposedAllowedOrigin(f.config, f.certName, failing)
    const text = JSON.stringify(withAllowedOrigin(f.config, list), null, 2) + '\n'
    const sum = createHash('sha256').update(f.configText!).digest('hex')
    const stamp = new Date(ctx.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const script = [
      'set -u',
      `f=${shq(f.configFile)}; want=${shq(sum)}; unit=${shq(f.npm.unit)}; bak=${shq(`${f.configFile}.hp-${stamp}.bak`)}`,
      'fail() { echo "HP_FAIL $*"; exit 1; }',
      '[ -f "$f" ] && [ ! -L "$f" ] || fail "$f is missing or a link"',
      '[ "$(sha256sum < "$f" | cut -d" " -f1)" = "$want" ] || fail "$f changed since it was read; nothing written"',
      'cp -P -p "$f" "$bak" || fail "could not back up $f"',
      'tmp=$(mktemp "$f.hp-XXXXXX") || fail "could not create a temporary file"',
      `printf %s ${shq(Buffer.from(text).toString('base64'))} | base64 -d > "$tmp" || { rm -f "$tmp"; fail "could not write"; }`,
      'chown --reference="$f" "$tmp" && chmod --reference="$f" "$tmp" || { rm -f "$tmp"; fail "could not copy owner and mode"; }',
      'mv -f "$tmp" "$f" || { rm -f "$tmp"; fail "could not replace $f"; }',
      'echo "HP_CONFIG_WRITTEN backup $bak"',
      'systemctl restart "$unit" || fail "config written (backup $bak) but $unit did not restart"',
      'echo HP_RESTARTED',
    ].join('\n')
    const r = await ctx.run(script, { timeoutMs: 120_000 })
    if (r.code !== 0 || !/^HP_RESTARTED$/m.test(r.output)) {
      return { ok: false, message: /^HP_FAIL (.*)$/m.exec(r.output)?.[1] ?? `the config script exited ${r.code}`, output: r.output }
    }
    return { ok: true, message: `allowedOrigin set to ${JSON.stringify(list)}; ${/backup (\S+)/.exec(r.output)?.[1] ?? 'old file kept'}`, output: r.output }
  },

  rollback(install, snapshot) {
    const f = facts(install)
    const byHand = f.npm.unit
      ? `stop ${f.npm.unit}; as ${f.npm.owner} in ${f.npm.dir} run \`npm install ${PKG}@${install.installed} --save-exact\`; start ${f.npm.unit}`
      : `as ${f.npm.owner} in ${f.npm.dir} run \`npm install ${PKG}@${install.installed} --save-exact\``
    return snapshot
      ? `Roll the guest back to snapshot ${snapshot} (Updates offers this on the failed step), or by hand: ${byHand}.`
      : `No snapshot was possible. By hand: ${byHand}.`
  },
}

// --- The plug-in --------------------------------------------------------------------

export const meshcentralPlugin: Plugin = {
  manifest: {
    id:   'meshcentral',
    name: 'MeshCentral',
    description: 'Finds MeshCentral installed with npm in any guest and keeps it updated from the Updates page: release notes, security flag, origin pre-flight, and a real sign-in check through the public URL.',
    kind: 'device',
    icon: '🖧',
    baseUrlSetting: 'public_url',
    auth: { kind: 'none' },
    settings: [
      { key: 'public_url', label: 'Public URL', type: 'text', required: false,
        hint: 'https://mesh.example.com — the address people sign in on. Several may be listed, comma separated. Left empty: taken from the proxy hosts HyperProx manages that forward to the MeshCentral guest.' },
      { key: 'insecure_tls', label: 'Accept a self-signed certificate on the public URL', type: 'text', required: false,
        hint: 'yes or no (default no).' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const url = ctx.option('public_url')
    return {
      headline: 'Watched for updates',
      tone: 'good',
      rows: [
        { label: 'Public URL', value: url || 'from proxy hosts' },
        { label: 'Updates', value: 'on the Updates page' },
      ],
    }
  },

  appUpdates: [meshcentralProvider],
}
