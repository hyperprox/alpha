// =============================================================================
//  HyperProx — Certificates: delivering a certificate to where it is used
//
//  A delivery is only finished when the endpoint serves the new certificate.
//  Files on disk prove nothing (the daemon may not have reloaded, may read
//  another path, or another tool may own the port), so every deploy ends with
//  a probe that must see the bundle's fingerprint, and anything else is a
//  failed deploy with the reason.
//
//  guest-files  files written inside a container or VM from its node (the same
//               node-exec path Updates uses: no SSH into the guest, no new
//               credential), then the target's reload command.
//  hyperprox    HyperProx's own front door: certs/cert.pem + certs/key.pem,
//               which the hyperprox-nginx container mounts, then an nginx reload.
// =============================================================================

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { IssuedBundle, ProbeResult, ProbeTarget, TargetSpec } from './modules'
import type { GuestRef, UpdatesExecutor } from '../updates/executor'

export interface GuestFile { path: string; content: string; mode: string; owner: string }
export interface ExecOutcome { code: number; output: string }

export interface DeployDeps {
  /** Write files into a guest. Implemented over guestExec by pushScript() in production. */
  guestPush(vmid: number, files: GuestFile[]): Promise<ExecOutcome>
  guestExec(vmid: number, script: string): Promise<ExecOutcome>
  hyperproxInstall(bundle: IssuedBundle): Promise<{ ok: boolean; detail: string }>
  probe(t: ProbeTarget): Promise<ProbeResult>
  /** Where this target serves the certificate. The service derives them from the policy. */
  endpoints: ProbeTarget[]
  /** A daemon can take a moment to pick up a reload; the probe is retried this many times. */
  probeAttempts?: number
  sleep?(ms: number): Promise<void>
}

export interface DeployResult { ok: boolean; detail: string; fingerprint: string | null }

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const PATH_RE  = /^\/[A-Za-z0-9._\/@+-]+$/
const OWNER_RE = /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?$/
const MODE_RE  = /^0?[0-7]{3}$/
const tail = (s: string, n = 300) => s.trim().slice(-n)

/** Single-quoted for bash. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * A bash script that writes `files` atomically: everything is staged next to its destination first, and
 * only when every file staged cleanly are the old ones kept as `<path>.hyperprox-prev` and the new ones
 * moved into place. A key and a certificate from different issuances never end up side by side.
 */
export function pushScript(files: GuestFile[]): string {
  for (const f of files) {
    if (!PATH_RE.test(f.path) || f.path.includes('/../') || f.path.endsWith('/..')) throw new Error(`refusing path ${JSON.stringify(f.path)}: use a plain absolute path`)
    if (!OWNER_RE.test(f.owner)) throw new Error(`refusing owner ${JSON.stringify(f.owner)}: use user or user:group`)
    if (!MODE_RE.test(f.mode)) throw new Error(`refusing mode ${JSON.stringify(f.mode)}: use octal such as 0600`)
  }
  const paths = files.map(f => f.path)
  const dup = paths.find((p, i) => paths.indexOf(p) !== i)
  // Staged then moved in order: a second file on the same path would silently replace the first.
  if (dup) throw new Error(`refusing to write ${JSON.stringify(dup)} twice in one delivery: every file needs its own path`)
  const lines = [
    'set -eu',
    'umask 077',
    'staged=()',
    // Must end with status 0: on a clean run an EXIT trap's last status would become the script's.
    "cleanup() { local t; for t in \"${staged[@]:-}\"; do if [ -n \"$t\" ]; then rm -f -- \"$t\"; fi; done; return 0; }",
    'trap cleanup EXIT',
    'stage() {',
    '  local dir; dir=$(dirname -- "$1"); mkdir -p -- "$dir"',
    '  local tmp; tmp=$(mktemp "$dir/.hyperprox-cert.XXXXXX")',
    '  staged+=("$tmp")',
    '  printf %s "$4" | base64 -d > "$tmp"',
    '  chown -- "$3" "$tmp"; chmod -- "$2" "$tmp"',
    '}',
  ]
  for (const f of files) lines.push(`stage ${q(f.path)} ${q(f.mode)} ${q(f.owner)} ${q(Buffer.from(f.content).toString('base64'))}`)
  files.forEach((f, i) => {
    lines.push(`if [ -e ${q(f.path)} ]; then cp -p -- ${q(f.path)} ${q(f.path + '.hyperprox-prev')}; fi`)
    lines.push(`mv -f -- "\${staged[${i}]}" ${q(f.path)}`)
  })
  lines.push('staged=()', `echo "wrote ${files.length} file(s)"`)
  return lines.join('\n') + '\n'
}

/** The files a guest-files target asks for, from the bundle. Only the key gets keyMode. */
export function guestFiles(t: Extract<TargetSpec, { kind: 'guest-files' }>, b: IssuedBundle): GuestFile[] {
  // Checked here as well as in the policy: a target can reach deploy without going through the parser.
  if (!MODE_RE.test(t.keyMode) || (parseInt(t.keyMode, 8) & 0o007) !== 0) {
    throw new Error(`refusing key mode ${JSON.stringify(t.keyMode)}: a private key must give other users no access (use 0600 or 0640)`)
  }
  const out: GuestFile[] = [
    { path: t.files.fullchain, content: b.fullchainPem, mode: '0644', owner: t.owner },
    { path: t.files.key, content: b.keyPem, mode: t.keyMode, owner: t.owner },
  ]
  if (t.files.cert)  out.push({ path: t.files.cert,  content: b.certPem,  mode: '0644', owner: t.owner })
  if (t.files.chain) out.push({ path: t.files.chain, content: b.chainPem, mode: '0644', owner: t.owner })
  return out
}

/** Probe every endpoint until it serves `want`, or the attempts run out. */
async function verify(want: string, deps: DeployDeps): Promise<DeployResult> {
  if (!deps.endpoints.length) {
    return { ok: false, fingerprint: null, detail: 'delivered, but unverified: no probe endpoint covers this certificate\'s names (add one under probes:)' }
  }
  const attempts = Math.max(1, deps.probeAttempts ?? 3)
  const wait = deps.sleep ?? sleep
  let seen: string | null = null
  const ok: string[] = []
  for (const ep of deps.endpoints) {
    const where = `${ep.host}:${ep.port}`
    let last = ''
    let match = false
    for (let i = 0; i < attempts && !match; i++) {
      if (i) await wait(2000 * i)
      const r = await deps.probe(ep).catch((e: any) => ({ ok: false, error: e?.message ?? String(e), trusted: null, namesMatch: null }) as ProbeResult)
      if (!r.ok || !r.leaf) { last = `${where} did not answer: ${r.error ?? 'no certificate'}`; continue }
      seen = r.leaf.fingerprint256
      if (sameFingerprint(r.leaf.fingerprint256, want)) match = true
      else last = `${where} still serves another certificate (${short(r.leaf.fingerprint256)}, expected ${short(want)})`
    }
    if (!match) return { ok: false, fingerprint: seen, detail: last }
    ok.push(where)
  }
  return { ok: true, fingerprint: want, detail: `serving the new certificate on ${ok.join(', ')}` }
}

export function sameFingerprint(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return n(a) === n(b) && n(a) !== ''
}

const short = (fp: string) => fp.replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase()

export async function deployBundle(target: TargetSpec, bundle: IssuedBundle, deps: DeployDeps): Promise<DeployResult> {
  try {
    if (target.kind === 'hyperprox') {
      const r = await deps.hyperproxInstall(bundle)
      if (!r.ok) return { ok: false, fingerprint: null, detail: r.detail }
      return await verify(bundle.fingerprint256, deps)
    }
    if (target.kind === 'guest-files') {
      const push = await deps.guestPush(target.vmid, guestFiles(target, bundle))
      if (push.code !== 0) return { ok: false, fingerprint: null, detail: `writing the files in guest ${target.vmid} failed (exit ${push.code}): ${tail(push.output)}` }
      if (target.reload) {
        const rl = await deps.guestExec(target.vmid, target.reload)
        if (rl.code !== 0) return { ok: false, fingerprint: null, detail: `files written, but the reload failed (exit ${rl.code}): ${tail(rl.output)}` }
      }
      return await verify(bundle.fingerprint256, deps)
    }
    return { ok: false, fingerprint: null, detail: `unknown target kind ${(target as any).kind}` }
  } catch (e: any) {
    return { ok: false, fingerprint: null, detail: e?.message ?? String(e) }
  }
}

// =============================================================================
//  Production bindings
// =============================================================================

/** guestPush/guestExec by VMID over the Updates executor (node login from the vault, pct / guest agent). */
export function guestRunner(exec: Pick<UpdatesExecutor, 'listGuests' | 'guestExec'>, timeoutMs = 120_000):
  Pick<DeployDeps, 'guestPush' | 'guestExec'> {
  async function find(vmid: number): Promise<GuestRef> {
    const g = (await exec.listGuests()).find(x => x.vmid === vmid)
    if (!g) throw new Error(`guest ${vmid} was not found in the cluster`)
    if (!g.running) throw new Error(`guest ${vmid} is not running`)
    return { vmid: g.vmid, type: g.type, node: g.node, name: g.name }
  }
  const run = async (vmid: number, script: string) => {
    const r = await exec.guestExec(await find(vmid), script, undefined, timeoutMs)
    return { code: r.timedOut ? -1 : r.code, output: r.timedOut ? `${r.output}\n(timed out)` : r.output }
  }
  return {
    guestPush: (vmid, files) => run(vmid, pushScript(files)),
    guestExec: run,
  }
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<ExecOutcome>

const runCommand: CommandRunner = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 60_000 }, (err: any, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}` })
  })
})

export function hyperproxDir(): string {
  return process.env.HYPERPROX_DIR || '/opt/hyperprox'
}

/**
 * Install a bundle as HyperProx's own certificate (install.sh and deploy.sh: certs/cert.pem holds the
 * full chain, certs/key.pem the key). The old pair is kept as cert.prev.pem / key.prev.pem (named *.pem
 * so the repo's ignore rule covers them), and put back if nginx refuses the new one, so a bad
 * certificate never takes the front door down. Reload, not restart: open connections are not cut.
 */
export async function installHyperproxCert(bundle: IssuedBundle, opts: { dir?: string; run?: CommandRunner; container?: string } = {}):
  Promise<{ ok: boolean; detail: string }> {
  const dir = path.join(opts.dir ?? hyperproxDir(), 'certs')
  const run = opts.run ?? runCommand
  const container = opts.container ?? 'hyperprox-nginx'
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem')
  const certPrev = path.join(dir, 'cert.prev.pem'), keyPrev = path.join(dir, 'key.prev.pem')
  const certNew = path.join(dir, '.cert.new.pem'), keyNew = path.join(dir, '.key.new.pem')

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(keyNew, bundle.keyPem, { mode: 0o600 })
  fs.chmodSync(keyNew, 0o600)
  fs.writeFileSync(certNew, bundle.fullchainPem, { mode: 0o644 })
  fs.chmodSync(certNew, 0o644)
  const hadOld = fs.existsSync(cert) && fs.existsSync(key)
  if (hadOld) {
    fs.copyFileSync(cert, certPrev)
    fs.copyFileSync(key, keyPrev)
    fs.chmodSync(keyPrev, 0o600)
  }
  fs.renameSync(keyNew, key)
  fs.renameSync(certNew, cert)

  const test = await run('docker', ['exec', container, 'nginx', '-t'])
  if (test.code !== 0) {
    if (hadOld) {
      fs.copyFileSync(certPrev, cert)
      fs.copyFileSync(keyPrev, key)
      fs.chmodSync(key, 0o600)
    }
    return { ok: false, detail: `nginx refused the new certificate${hadOld ? '; the previous one was put back' : ''}: ${tail(test.output)}` }
  }
  const reload = await run('docker', ['exec', container, 'nginx', '-s', 'reload'])
  if (reload.code !== 0) return { ok: false, detail: `certificate installed, but the nginx reload failed: ${tail(reload.output)}` }
  return { ok: true, detail: 'installed in certs/ and nginx reloaded' }
}
