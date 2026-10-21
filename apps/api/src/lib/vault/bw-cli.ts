// =============================================================================
//  HyperProx — Bitwarden CLI runner
//
//  Every call runs `bw` with a minimal, explicit environment (never the API's
//  own process.env, which holds unrelated secrets) and one isolated data dir.
//  Secrets go in through the environment (BW_PASSWORD, BW_SESSION) or stdin
//  (item/Send JSON), never argv — argv is world-readable in /proc. The only
//  secret that must go on argv is the 6-digit TOTP code for `bw login --code`
//  (the CLI has no env/stdin option for it); it is single-use and expires in
//  seconds. Output is never logged: it may contain decrypted items.
// =============================================================================

import { spawn } from 'node:child_process'
import path from 'node:path'
import { bwBinary, vaultCaCertPath } from './config'

export interface BwResult { code: number; stdout: string; stderr: string }

export interface BwOptions {
  dir: string
  session?: string
  password?: string
  stdin?: string
  timeoutMs?: number
}

export function runBw(args: string[], opts: BwOptions): Promise<BwResult> {
  const env: Record<string, string> = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: opts.dir,
    BITWARDENCLI_APPDATA_DIR: opts.dir,
    BW_NOINTERACTION: 'true',
    NODE_NO_WARNINGS: '1',
    LANG: 'C.UTF-8',
  }
  const ca = vaultCaCertPath()
  if (ca) env.NODE_EXTRA_CA_CERTS = ca
  if (opts.session) env.BW_SESSION = opts.session
  if (opts.password !== undefined) env.BW_PASSWORD = opts.password

  return new Promise((resolve, reject) => {
    const child = spawn(bwBinary(), args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', e => { clearTimeout(timer); reject(e) })
    const started = Date.now()
    child.on('close', code => {
      clearTimeout(timer)
      // Debug timing: subcommand name and duration only, never arguments or output.
      if (process.env.VAULT_BW_TIMING === '1') process.stderr.write(`[bw] ${args[0]} ${code} ${Date.now() - started}ms\n`)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.end(opts.stdin ?? '')
  })
}

/** A short, log-safe description of a failed call (stderr first line / --response message only). */
export function bwErrorMessage(r: BwResult): string {
  try {
    const j = JSON.parse(r.stdout)
    if (j && typeof j.message === 'string') return j.message.slice(0, 300)
  } catch { /* not JSON */ }
  try {
    const j = JSON.parse(r.stderr)
    const m = j?.response?.error?.description ?? j?.message
    if (m) return `${String(m).slice(0, 280)} (${j?.statusCode ?? j?.response?.error?.code ?? '?'})`
  } catch { /* not JSON */ }
  const line = r.stderr.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? `exit ${r.code}`
  return line.slice(0, 300)
}

/** JSON payload for create/edit, base64-encoded as `bw encode` would, passed on stdin. */
export function encodeJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}
