// =============================================================================
//  HyperProx — App updates: the npm-app helper
//
//  For apps installed with `npm install <pkg>` into a directory and run by a
//  systemd unit (`node .../node_modules/<pkg>/...`), which is how MeshCentral,
//  Uptime Kuma, Node-RED and many self-hosted apps are commonly set up. A
//  provider names the package; this file finds the installs, reads the
//  registry and the release notes, and applies an update the safe way:
//
//    stop the unit → npm install <pkg>@<exact version> as the install's owner
//    → wait for it to finish → `npm ls` must resolve → start the unit
//
//  Never the other way round. An app that restarts itself while npm is still
//  writing node_modules crashes on the first request that needs the half-
//  installed module (MODULE_NOT_FOUND), and a health endpoint will not notice.
//
//  Trust: the scripts run as root in the guest, and everything they read there
//  is untrusted — any user can start a process whose arguments mention
//  node_modules/<pkg>. So: every field comes back base64-encoded (a newline in
//  an argument cannot forge a line); paths, users, units and versions are
//  validated before they go back into a script, and quoted; only installs run
//  by a SYSTEM unit are ever updated; and no binary found in the guest is run
//  as root unless the install itself runs as root and the binary is root-owned
//  and not writable by anyone else.
// =============================================================================

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AppContext, AppRelease, AppReleaseNote, AppStepResult } from '../plugin-host'
import {
  compareVersions, inRange, isNpmName, isSafeAbsPath, isStableVersion, isUnitName, isUserName, isVersion, shq,
} from './versions'

export interface NpmInstall {
  /** The directory holding package.json and node_modules/<pkg>. */
  dir:       string
  pkg:       string
  installed: string
  /** The dependency spec in package.json, e.g. "1.1.53" or "^1.1.53"; null when package.json does not list it. */
  spec:      string | null
  /** The spec pins one exact version (no ^ or ~). */
  exact:     boolean
  /** Where package.json lists it; null when it does not. */
  section:   'dependencies' | 'optionalDependencies' | 'devDependencies' | null
  /** Owner of `dir`: who npm runs as. */
  owner:     string
  /** System unit running it, or null (then HyperProx will not update it). */
  unit:      string | null
  unitUser:  string | null
  active:    boolean
  mainPid:   number | null
  /** The node binary the unit's ExecStart names (never a process's argv); may be a bare `node`. */
  nodeBin:   string | null
  /** The process's command line, for people. */
  command:   string
  /** Extra files the provider asked for, relative to `dir`, decoded; null when absent or too large. */
  files:     Record<string, string | null>
}

const b64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')

/**
 * Id of an install: its real directory, unit, owner and node binary. An approval names this key,
 * so if any of what a person reviewed changes before the run, the approval matches nothing.
 */
export function installKey(i: Pick<NpmInstall, 'dir' | 'unit' | 'owner' | 'nodeBin' | 'unitUser'>): string {
  return createHash('sha256').update(JSON.stringify([i.dir, i.unit, i.owner, i.unitUser, i.nodeBin])).digest('hex').slice(0, 12)
}

// --- Detection --------------------------------------------------------------------

/**
 * Read-only. Lists processes and system unit files that mention node_modules/<pkg>. Every
 * field is base64, so nothing a process puts in its arguments can forge a line.
 */
export function npmDiscoverScript(pkg: string): string {
  if (!isNpmName(pkg)) throw new Error(`not an npm package name: ${pkg}`)
  return [
    `needle=${shq(`node_modules/${pkg}`)}`,
    'e() { printf %s "$1" | base64 -w0; }',
    'for d in /proc/[0-9]*; do',
    '  [ -r "$d/cmdline" ] || continue',
    '  args=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue',
    '  case "$args" in *"$needle"*) ;; *) continue ;; esac',
    '  pid=${d#/proc/}',
    '  [ "$pid" = "$$" ] && continue',
    '  user=$(stat -c %U "$d" 2>/dev/null); cwd=$(readlink "$d/cwd" 2>/dev/null); cg=$(head -c 1024 "$d/cgroup" 2>/dev/null)',
    '  echo "HP_PROC $pid $(e "$user") $(e "$cwd") $(e "$cg") $(e "$args")"',
    'done',
    'for f in /etc/systemd/system/*.service /lib/systemd/system/*.service /usr/lib/systemd/system/*.service; do',
    '  [ -f "$f" ] || continue',
    '  grep -qF -- "$needle" "$f" 2>/dev/null || continue',
    '  u=${f##*/}',
    '  echo "HP_UNIT $(e "$u") $(systemctl show "$u" -p ExecStart -p WorkingDirectory -p User -p ActiveState -p MainPID 2>/dev/null | base64 -w0)"',
    'done',
    'echo HP_DISCOVER_DONE',
  ].join('\n')
}

interface Candidate {
  dir: string; unit: string | null; unitUser: string | null; active: boolean; mainPid: number | null
  nodeBin: string | null; command: string; procUser: string | null
}

/** The directory an argument list runs <pkg> from, resolved against `cwd` when relative. */
export function dirFromArgs(args: string, pkg: string, cwd: string | null): string | null {
  const marker = `node_modules/${pkg}`
  for (const tok of args.split(/\s+/)) {
    const i = tok.indexOf(marker)
    if (i < 0) continue
    const rest = tok.slice(i + marker.length)
    if (rest && !rest.startsWith('/')) continue          // node_modules/<pkg>-something-else
    const prefix = tok.slice(0, i)
    if (prefix && !prefix.endsWith('/')) continue
    let dir: string
    if (prefix.startsWith('/')) dir = prefix
    else if (cwd && isSafeAbsPath(cwd)) dir = path.posix.join(cwd, prefix || '.')
    else continue
    dir = path.posix.normalize(dir).replace(/\/+$/, '') || '/'
    return isSafeAbsPath(dir) ? dir : null
  }
  return null
}

function firstToken(args: string): string | null {
  const t = args.trim().split(/\s+/)[0]
  return t && /(^|\/)node(js)?$/.test(t) ? t : null
}

/** systemd's ExecStart property: `{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/app/node_modules/x ; ... }`. */
function execArgv(execStart: string): string {
  return /argv\[\]=([^;]*)/.exec(execStart)?.[1]?.trim() ?? ''
}

export function parseNpmDiscover(output: string, pkg: string): Candidate[] {
  const byDir = new Map<string, Candidate>()
  // Unit files first, so a process merges into the install its unit declares.
  const lines = output.split('\n').sort((a, b) => Number(b.trim().startsWith('HP_UNIT ')) - Number(a.trim().startsWith('HP_UNIT ')))
  for (const line of lines) {
    const t = line.trim()
    let m = /^HP_UNIT (\S+) (\S*)$/.exec(t)
    if (m) {
      const unit = b64(m[1])
      if (!isUnitName(unit)) continue
      const props: Record<string, string> = {}
      for (const l of b64(m[2]).split('\n')) { const k = l.indexOf('='); if (k > 0) props[l.slice(0, k)] = l.slice(k + 1) }
      const argv = execArgv(props.ExecStart ?? '')
      const dir = dirFromArgs(argv, pkg, props.WorkingDirectory || null)
      if (!dir) continue
      const pid = Number(props.MainPID)
      byDir.set(dir, {
        dir, unit, unitUser: props.User || 'root', active: props.ActiveState === 'active',
        mainPid: pid > 0 ? pid : null, nodeBin: firstToken(argv), command: argv, procUser: null,
      })
      continue
    }
    m = /^HP_PROC (\d+) (\S*) (\S*) (\S*) (\S*)$/.exec(t)
    if (m) {
      const user = b64(m[2]), cwd = b64(m[3]), cgroup = b64(m[4]), args = b64(m[5]).trim()
      const dir = dirFromArgs(args, pkg, cwd || null)
      if (!dir) continue
      // A process only confirms a unit file's install; it never makes one updatable on its own. Being in
      // some system.slice service proves nothing (cron jobs run inside cron.service), and its argv —
      // directory and node binary alike — is whatever the user who started it chose.
      const unit = /(?:^|\n)\d+:(?:name=systemd)?:\/system\.slice\/([^/\s]+\.service)[ \t]*(?=\n|$)/.exec(cgroup)?.[1] ?? null
      const known = byDir.get(dir)
      if (known) {
        if (known.unit && unit === known.unit) {
          known.active = true
          if (!known.mainPid) known.mainPid = Number(m[1])
        }
        continue
      }
      byDir.set(dir, {
        dir, unit: null, unitUser: null, active: false,
        mainPid: Number(m[1]), nodeBin: null, command: args, procUser: user || null,
      })
    }
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir))
}

const FILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const MAX_FILE = 1024 * 1024

/** A relative path inside the install directory, fit to quote: no `..`, no leading slash. */
function isSafeRelPath(p: string): boolean {
  return p.length > 0 && p.length < 256 && !p.startsWith('/') && isSafeAbsPath('/' + p)
}

/**
 * Read-only. The owner of `dir`, package.json, the installed package's package.json, and any
 * extra files (relative to `dir`). Symlinks are not followed: a file the app's owner can
 * replace with a link must not become a way to read anything root can.
 */
export function npmFactsScript(dir: string, pkg: string, extra: Record<string, string> = {}): string {
  if (!isSafeAbsPath(dir)) throw new Error(`unsafe directory: ${dir}`)
  if (!isNpmName(pkg)) throw new Error(`not an npm package name: ${pkg}`)
  const files: Record<string, string> = { package: 'package.json', installed: `node_modules/${pkg}/package.json`, ...extra }
  // The files are read as the directory's owner: a link anywhere along the way then reaches only
  // what that user could read anyway.
  const reads = [
    'd=$1',
    'f() { p="$d/$2"; if [ -f "$p" ] && [ ! -L "$p" ] && [ "$(stat -c %s "$p")" -le ' + MAX_FILE + ' ]; then echo "HP_FILE $1 $(base64 -w0 < "$p")"; else echo "HP_FILE $1 -"; fi; }',
  ]
  for (const [name, rel] of Object.entries(files)) {
    if (!FILE_NAME.test(name) || !isSafeRelPath(rel)) throw new Error(`unsafe file request ${name}: ${rel}`)
    reads.push(`f ${name} ${shq(rel)}`)
  }
  return [
    `d=${shq(dir)}; reads=${shq(reads.join('\n'))}`,
    '[ -d "$d" ] || { echo HP_NO_DIR; exit 0; }',
    'echo "HP_REAL $(readlink -f -- "$d" | base64 -w0)"',
    'o=$(stat -c %U "$d"); echo "HP_OWNER $(printf %s "$o" | base64 -w0)"',
    'case "$o" in ""|*[!A-Za-z0-9_.-]*) exit 0 ;; esac',
    'if [ "$o" = root ]; then bash -c "$reads" _ "$d"; else runuser -u "$o" -- bash -c "$reads" _ "$d"; fi',
  ].join('\n')
}

export function parseNpmFacts(output: string): { exists: boolean; owner: string | null; real: string | null; files: Record<string, string | null> } {
  const files: Record<string, string | null> = {}
  let owner: string | null = null, real: string | null = null
  for (const line of output.split('\n')) {
    const t = line.trim()
    if (t === 'HP_NO_DIR') return { exists: false, owner: null, real: null, files }
    let m = /^HP_REAL (\S+)$/.exec(t)
    if (m) { real = b64(m[1]).trim() || null; continue }
    m = /^HP_OWNER (\S+)$/.exec(t)
    if (m) { owner = b64(m[1]).trim() || null; continue }
    m = /^HP_FILE ([a-z][a-z0-9_-]*) (\S+)$/.exec(t)
    if (m) files[m[1]] = m[2] === '-' ? null : b64(m[2])
  }
  return { exists: true, owner, real, files }
}

function readJson(text: string | null | undefined): any {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function sectionOf(pkgJson: any, pkg: string): NpmInstall['section'] {
  for (const k of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
    if (typeof pkgJson?.[k]?.[pkg] === 'string') return k
  }
  return null
}

/** The package's dependency spec in package.json, looked up in every dependency section. */
function specOf(pkgJson: any, pkg: string): string | null {
  for (const k of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const v = pkgJson?.[k]?.[pkg]
    if (typeof v === 'string') return v
  }
  return null
}

/**
 * Every install of `pkg` in the guest. `extraFiles` are read relative to each install
 * directory and handed back decoded (a provider's config file, say).
 */
export async function detectNpmInstalls(ctx: AppContext, pkg: string, extraFiles: Record<string, string> = {}): Promise<NpmInstall[]> {
  const found = await ctx.run(npmDiscoverScript(pkg), { timeoutMs: 60_000 })
  if (found.code !== 0 || !found.output.includes('HP_DISCOVER_DONE')) {
    throw new Error(`looking for ${pkg} failed: ${found.output.slice(-300).trim()}`)
  }
  const out: NpmInstall[] = []
  for (const c of parseNpmDiscover(found.output, pkg)) {
    const r = await ctx.run(npmFactsScript(c.dir, pkg, extraFiles), { timeoutMs: 60_000 })
    if (r.code !== 0) continue
    const facts = parseNpmFacts(r.output)
    if (!facts.exists) continue
    // Keyed and updated by its real path, never by a path that runs through a symlink.
    if (!facts.real || !isSafeAbsPath(facts.real)) continue
    const dir = facts.real
    const installed = readJson(facts.files.installed)?.version
    if (!isVersion(installed)) continue
    const owner = facts.owner && isUserName(facts.owner) ? facts.owner : null
    if (!owner) continue
    const pj = readJson(facts.files.package)
    const spec = specOf(pj, pkg)
    out.push({
      dir, pkg, installed, spec, exact: spec !== null && isVersion(spec.replace(/^=/, '')),
      section: sectionOf(pj, pkg),
      owner, unit: c.unit, unitUser: c.unitUser ?? c.procUser, active: c.active, mainPid: c.mainPid,
      nodeBin: c.nodeBin, command: c.command,
      files: Object.fromEntries(Object.keys(extraFiles).map(k => [k, facts.files[k] ?? null])),
    })
  }
  return out
}

/** One line for people: how it is installed and run. */
export function describeNpmInstall(i: NpmInstall): string {
  const pin = i.spec === null ? 'not listed in package.json' : i.exact ? `pinned to ${i.spec}` : `package.json asks for ${i.spec}`
  const run = i.unit ? `systemd unit ${i.unit}${i.unitUser ? ` as ${i.unitUser}` : ''}` : 'no system unit (started by hand or a user service)'
  return `npm install in ${i.dir} (owner ${i.owner}, ${pin}); ${run}`
}

/** Why HyperProx will not update this install, or null when it can. */
export function npmUpdateBlocker(i: NpmInstall): string | null {
  if (!i.unit) return 'it is not run by a system service, so it cannot be stopped before updating — run it from a systemd unit'
  // Also when root owns the directory: an app user that can write node_modules at run time could plant
  // install scripts that a root npm would then run.
  if ((i.unitUser ?? 'root') !== i.owner) {
    return `the unit runs as ${i.unitUser ?? 'root'} but ${i.dir} is owned by ${i.owner}; npm would install as a different user than runs the app`
  }
  return null
}

// --- The registry, release notes and advisories --------------------------------------

export interface NpmReleaseOptions {
  /** `owner/repo` on GitHub, for release notes and security advisories. */
  github?: string
  /** Most versions to fetch notes for. */
  maxNotes?: number
}

const SECURITY_WORDS = /\b(security|vulnerabilit(?:y|ies)|vulnerable|CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3}|exploit(?:s|ed)?|XSS|CSRF|SSRF|RCE|remote code execution|auth(?:entication)? bypass|privilege escalation|hijack(?:ing)?)\b/i
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const NOTE_MAX = 4000

/** The line of release notes that makes it a security update, or null. */
export function securityLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (SECURITY_WORDS.test(line)) return line.replace(/^[\s*#>-]+|[\s*]+$/g, '').slice(0, 300)
  }
  return null
}

function registryUrl(pkg: string): string {
  return `https://registry.npmjs.org/${pkg.startsWith('@') ? '@' + encodeURIComponent(pkg.slice(1)) : encodeURIComponent(pkg)}`
}

/**
 * Latest stable version from the npm registry, notes for every version after `installed`
 * (from GitHub releases, when configured), and whether the update is a security one: an
 * advisory (npm's bulk endpoint, GitHub's repository advisories) that affects the installed
 * version but not the latest, or security wording in the notes.
 */
export async function npmRelease(ctx: AppContext, pkg: string, installed: string, opts: NpmReleaseOptions = {}): Promise<AppRelease> {
  if (!isNpmName(pkg)) throw new Error(`not an npm package name: ${pkg}`)
  const doc = await ctx.fetchJson(registryUrl(pkg))
  const latest = doc?.['dist-tags']?.latest
  if (!isStableVersion(latest) || !doc?.versions?.[latest]) return { latest: null, notes: [], isSecurity: false }
  if (!isVersion(installed) || compareVersions(latest, installed) <= 0) return { latest, notes: [], isSecurity: false }

  const newer = Object.keys(doc.versions ?? {})
    .filter(v => isStableVersion(v) && compareVersions(v, installed) > 0 && compareVersions(v, latest) <= 0)
    .sort((a, b) => compareVersions(b, a))

  const notes: AppReleaseNote[] = []
  const reasons: string[] = []
  const repo = opts.github && GITHUB_REPO.test(opts.github) ? opts.github : null

  if (repo) {
    try {
      const rels = await ctx.fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=100`)
      const byVersion = new Map<string, any>()
      for (const r of Array.isArray(rels) ? rels : []) {
        const v = String(r?.tag_name ?? '').replace(/^v/, '')
        if (isVersion(v) && !r.draft) byVersion.set(v, r)
      }
      for (const v of newer.slice(0, opts.maxNotes ?? 15)) {
        const r = byVersion.get(v)
        if (!r) continue
        const text = String(r.body ?? '').slice(0, NOTE_MAX)
        notes.push({ version: v, url: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : undefined, text })
      }
    } catch (e: any) { ctx.log(`release notes for ${pkg}: ${e.message}`) }
  }

  for (const n of notes) {
    const line = securityLine(n.text)
    if (line) { reasons.push(`${n.version} release notes: ${line}`); break }
  }

  // Advisories that affect what is installed and not what would be installed.
  const affects = (range: unknown) => typeof range === 'string' && inRange(installed, range) === true && inRange(latest, range) === false
  try {
    const bulk = await ctx.fetchJson('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', { [pkg]: [installed] })
    for (const a of Array.isArray(bulk?.[pkg]) ? bulk[pkg] : []) {
      if (affects(a?.vulnerable_versions)) { reasons.unshift(`advisory: ${String(a.title ?? a.id).slice(0, 200)} (${a.severity ?? 'unrated'}, affects ${a.vulnerable_versions})`); break }
    }
  } catch (e: any) { ctx.log(`npm advisories for ${pkg}: ${e.message}`) }
  if (repo && !reasons.some(r => r.startsWith('advisory'))) {
    try {
      const advs = await ctx.fetchJson(`https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`)
      outer: for (const a of Array.isArray(advs) ? advs : []) {
        for (const v of a?.vulnerabilities ?? []) {
          if (v?.package?.ecosystem === 'npm' && v?.package?.name === pkg && affects(v.vulnerable_version_range)) {
            reasons.unshift(`advisory ${a.ghsa_id}: ${String(a.summary ?? '').slice(0, 200)} (${a.severity ?? 'unrated'}, affects ${v.vulnerable_version_range})`)
            break outer
          }
        }
      }
    } catch (e: any) { ctx.log(`GitHub advisories for ${repo}: ${e.message}`) }
  }

  return { latest, notes, isSecurity: reasons.length > 0, ...(reasons.length ? { securityNote: reasons[0] } : {}) }
}

// --- Applying ---------------------------------------------------------------------------

// Reads `npm ls --json` on stdin. Exit 0 only when <pkg> resolves at exactly <version> and
// nothing is missing or invalid (extraneous modules are tolerated: some apps install
// optional modules at run time without saving them).
const NPM_LS_JUDGE = [
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{',
  'let j;try{j=JSON.parse(s)}catch(e){console.log("HP_LS_UNREADABLE");process.exit(1)}',
  'const [pkg,ver]=process.argv.slice(1);const d=(j.dependencies||{})[pkg];',
  'const bad=(j.problems||[]).filter(p=>!/^extraneous/.test(String(p)));',
  'console.log("HP_LS_VERSION "+((d&&d.version)||"-"));',
  'bad.slice(0,20).forEach(p=>console.log("HP_LS_PROBLEM "+String(p).replace(/\\s+/g," ")));',
  'process.exit(d&&d.version===ver&&!bad.length?0:1)})',
].join('')

/**
 * Stop the unit, install exactly `version` as the owner, wait for npm, check `npm ls`, start
 * the unit. On any failure after the stop, the unit is LEFT STOPPED: a half-installed app
 * is not started, and nothing is rolled back behind anyone's back.
 */
export function npmApplyScript(i: NpmInstall, version: string): string {
  if (!isNpmName(i.pkg)) throw new Error(`not an npm package name: ${i.pkg}`)
  if (!isVersion(version)) throw new Error(`not a version: ${version}`)
  if (!isSafeAbsPath(i.dir)) throw new Error(`unsafe directory: ${i.dir}`)
  if (!isUserName(i.owner)) throw new Error(`unsafe user name: ${i.owner}`)
  if (!i.unit || !isUnitName(i.unit)) throw new Error('no system unit to stop first')
  if (i.nodeBin !== null && !(isSafeAbsPath(i.nodeBin) || /^node(js)?$/.test(i.nodeBin))) throw new Error(`unsafe node path: ${i.nodeBin}`)
  // package.json keeps its shape: the same section and pin style; an unlisted package stays unlisted.
  const save = i.section === null ? '--no-save'
    : `${i.section === 'devDependencies' ? '--save-dev' : i.section === 'optionalDependencies' ? '--save-optional' : '--save'}${i.exact ? ' --save-exact' : ''}`
  const omitDev = i.section === 'devDependencies' ? '' : ' --omit=dev'
  return [
    'set -u',
    `dir=${shq(i.dir)}; pkg=${shq(i.pkg)}; ver=${shq(version)}; unit=${shq(i.unit)}; owner=${shq(i.owner)}; nodebin=${shq(i.nodeBin ?? 'node')}`,
    'fail() { echo "HP_FAIL $*"; exit 1; }',
    '[ -d "$dir" ] || fail "$dir is gone"',
    '[ "$(stat -c %U "$dir")" = "$owner" ] || fail "$dir is no longer owned by $owner"',
    'home=$(getent passwd "$owner" | cut -d: -f6); [ -n "$home" ] || home=/nonexistent',
    'SYS=/usr/local/bin:/usr/bin:/bin',
    'case "$nodebin" in /*) ;; *) nodebin=$(PATH=$SYS command -v node || true) ;; esac',
    '[ -n "$nodebin" ] || fail "no node binary found"',
    // Resolve every link once, then run the resolved files: nothing can be swapped in between.
    'nodebin=$(readlink -f -- "$nodebin"); [ -n "$nodebin" ] && [ -f "$nodebin" ] && [ -x "$nodebin" ] || fail "no node binary found"',
    'nodedir=$(dirname -- "$nodebin")',
    'npmbin="$nodedir/npm"; [ -e "$npmbin" ] || npmbin=$(PATH=$SYS command -v npm || true)',
    '[ -n "$npmbin" ] || fail "no npm next to $nodebin or on PATH"',
    'npmcli=$(readlink -f -- "$npmbin"); [ -n "$npmcli" ] && [ -f "$npmcli" ] || fail "npm could not be resolved"',
    // Root runs a file only when it and every directory above it are root-owned and not writable by others.
    'trusted() { p=$1; while :; do m=$(stat -c %a -- "$p") && [ "$(stat -c %u -- "$p")" = 0 ] && [ $(( 8#$m & 8#022 )) -eq 0 ] || return 1; [ "$p" = / ] && return 0; p=$(dirname -- "$p"); done; }',
    'if [ "$owner" = root ]; then for b in "$nodebin" "$npmcli"; do trusted "$b" || fail "$b is not root-owned and protected (with every directory above it); not running it as root"; done; fi',
    'P="$nodedir:$SYS"',
    'as_owner() { if [ "$owner" = root ]; then env -i HOME="$home" PATH="$P" LANG=C.UTF-8 "$@"; else runuser -u "$owner" -- env -i HOME="$home" PATH="$P" LANG=C.UTF-8 "$@"; fi; }',
    'echo "HP_STEP stopping $unit"',
    'systemctl stop "$unit" || fail "could not stop $unit"',
    'for i in $(seq 1 60); do st=$(systemctl is-active "$unit" 2>/dev/null); case "$st" in inactive|failed) break ;; esac; sleep 1; done',
    'case "$(systemctl is-active "$unit" 2>/dev/null)" in inactive|failed) ;; *) fail "$unit did not stop" ;; esac',
    'cd "$dir" || fail "cannot enter $dir"',
    'echo "HP_STEP npm install $pkg@$ver as $owner"',
    `as_owner "$nodebin" "$npmcli" install --no-audit --no-fund --no-update-notifier ${save} "$pkg@$ver" 2>&1 | tail -n 40`,
    'rc=${PIPESTATUS[0]}',
    '[ "$rc" -eq 0 ] || fail "npm install exited $rc; $unit is left STOPPED"',
    'echo "HP_STEP npm ls"',
    `as_owner "$nodebin" "$npmcli" ls --all${omitDev} --json 2>/dev/null | as_owner "$nodebin" -e ${shq(NPM_LS_JUDGE)} "$pkg" "$ver"`,
    '[ "${PIPESTATUS[1]}" -eq 0 ] || fail "npm ls does not resolve cleanly at $pkg@$ver; $unit is left STOPPED"',
    'echo "HP_STEP starting $unit"',
    'systemctl start "$unit" || fail "npm install succeeded but $unit did not start"',
    'echo "HP_APPLIED $ver"',
  ].join('\n')
}

export async function npmApply(ctx: AppContext, i: NpmInstall, version: string): Promise<AppStepResult> {
  const blocker = npmUpdateBlocker(i)
  if (blocker) return { ok: false, message: `not updated: ${blocker}` }
  const r = await ctx.run(npmApplyScript(i, version), { timeoutMs: 30 * 60_000 })
  const failLine = /^HP_FAIL (.*)$/m.exec(r.output)?.[1]
  if (r.code === 0 && new RegExp(`^HP_APPLIED ${version.replace(/[.+]/g, '\\$&')}$`, 'm').test(r.output)) {
    return { ok: true, message: `installed ${i.pkg}@${version} and started ${i.unit}`, output: r.output }
  }
  return {
    ok: false,
    message: failLine ?? (r.timedOut ? `the update did not finish in time; check ${i.unit} by hand` : `the update script exited ${r.code}`),
    output: r.output,
  }
}

// --- Settling after a start -----------------------------------------------------------------

/** One read: the unit's state and main pid, and how many npm processes the owner is running. */
export function serviceStateScript(unit: string, owner: string): string {
  if (!isUnitName(unit) || !isUserName(owner)) throw new Error('unsafe unit or user')
  return [
    `u=${shq(unit)}; o=${shq(owner)}`,
    'st=$(systemctl is-active "$u" 2>/dev/null); pid=$(systemctl show -p MainPID --value "$u" 2>/dev/null)',
    'n=$(pgrep -u "$o" -fc "(^|/)npm(-cli\\.js)?( |$)" 2>/dev/null || true)',
    'echo "HP_STATE ${st:-unknown} ${pid:-0} ${n:-0}"',
  ].join('\n')
}

export function parseServiceState(output: string): { state: string; pid: number; npm: number } | null {
  const m = /^HP_STATE (\S+) (\d+) (\d+)$/m.exec(output)
  return m ? { state: m[1], pid: Number(m[2]), npm: Number(m[3]) } : null
}

/**
 * Wait until the unit has been active on the same main pid, with no npm running as its owner,
 * for `steadyMs` — an app that installs its own optional modules on first start (and restarts
 * when they land) has then finished doing so.
 */
export async function waitForSteadyService(ctx: AppContext, unit: string, owner: string, opts: { steadyMs?: number; maxMs?: number; pollMs?: number } = {}): Promise<{ ok: boolean; pid: number; detail: string }> {
  const steady = opts.steadyMs ?? 20_000, max = opts.maxMs ?? 5 * 60_000, poll = opts.pollMs ?? 5_000
  const deadline = ctx.now() + max
  let since: number | null = null, pid = 0, last = 'no answer'
  for (;;) {
    const r = await ctx.run(serviceStateScript(unit, owner), { timeoutMs: 30_000 }).catch(e => ({ code: -1, output: String(e.message), timedOut: false }))
    const s = parseServiceState(r.output)
    if (s) {
      last = `${unit} ${s.state}, main pid ${s.pid}${s.npm ? `, npm running (${s.npm})` : ''}`
      if (s.state === 'active' && s.pid > 0 && s.npm === 0) {
        if (since === null || s.pid !== pid) { since = ctx.now(); pid = s.pid }
        if (ctx.now() - since >= steady) return { ok: true, pid, detail: last }
      } else since = null
      if (s.state === 'failed') return { ok: false, pid: s.pid, detail: last }
    }
    if (ctx.now() >= deadline) return { ok: false, pid, detail: `${last} — not steady within ${Math.round(max / 1000)} s` }
    await ctx.sleep(poll)
  }
}
