// =============================================================================
//  HyperProx — self-update: running commands
//
//  Every command the updater runs goes through a Shell, so the whole runner can
//  be tested with a fake one. No command is ever a shell string: a program and
//  its arguments, so nothing fetched can be spliced into a command line.
//
//  Builtins only (see state.ts).
// =============================================================================

import { spawn } from 'child_process'
import fs from 'fs'
import http from 'http'
import https from 'https'

export interface RunOptions {
  cwd?:       string
  env?:       Record<string, string>
  /** What the command reads on stdin, in order: literal text and whole files. */
  stdin?:     Array<{ text: string } | { file: string }>
  /** Send stdout to this file (created 0600) instead of collecting it. */
  stdoutFile?: string
  timeoutMs?: number
  /** Each output line as it arrives (stdout and stderr). */
  onLine?:    (line: string) => void
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
}

export interface HttpResult { status: number; body: string }
/** A GET with a short timeout; `insecure` is for the local nginx and its self-signed certificate. */
export type HttpGet = (url: string, opts?: { insecure?: boolean; timeoutMs?: number }) => Promise<HttpResult>

const OUT_MAX = 2_000_000

export class RealShell implements Shell {
  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      let pendingOut = '', pendingErr = ''
      const out = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null
      const lines = (chunk: string, which: 'out' | 'err') => {
        if (!opts.onLine) return
        let buf = (which === 'out' ? pendingOut : pendingErr) + chunk
        const parts = buf.split(/\r?\n|\r/)
        buf = parts.pop() ?? ''
        for (const p of parts) if (p.trim()) opts.onLine(p)
        if (which === 'out') pendingOut = buf; else pendingErr = buf
      }
      child.stdout!.on('data', (d: Buffer) => {
        if (out) { out.write(d); return }
        const s = d.toString()
        if (stdout.length < OUT_MAX) stdout += s
        lines(s, 'out')
      })
      child.stderr!.on('data', (d: Buffer) => {
        const s = d.toString()
        if (stderr.length < OUT_MAX) stderr += s
        lines(s, 'err')
      })
      let timer: NodeJS.Timeout | null = null
      if (opts.timeoutMs) timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* gone */ } }, opts.timeoutMs)
      const finish = (code: number) => {
        if (timer) clearTimeout(timer)
        if (opts.onLine) { if (pendingOut.trim()) opts.onLine(pendingOut); if (pendingErr.trim()) opts.onLine(pendingErr) }
        const done = () => resolve({ code, stdout, stderr })
        if (out) out.end(done); else done()
      }
      child.on('error', (e) => { stderr += String(e.message); finish(127) })
      child.on('close', (code) => finish(code ?? 1))
      if (opts.stdin && child.stdin) {
        const parts = [...opts.stdin]
        const next = () => {
          const p = parts.shift()
          if (!p) { child.stdin!.end(); return }
          if ('text' in p) { child.stdin!.write(p.text); next(); return }
          const r = fs.createReadStream(p.file)
          r.on('error', () => child.stdin!.end())
          r.on('end', next)
          r.pipe(child.stdin!, { end: false })
        }
        child.stdin.on('error', () => { /* the command exited early; its code says why */ })
        next()
      }
    })
  }
}

export const realHttpGet: HttpGet = (url, opts = {}) => new Promise((resolve) => {
  let u: URL
  try { u = new URL(url) } catch { resolve({ status: 0, body: 'bad url' }); return }
  const mod = u.protocol === 'https:' ? https : http
  const req = mod.get(u, { timeout: opts.timeoutMs ?? 5000, rejectUnauthorized: !opts.insecure }, (res) => {
    let body = ''
    res.on('data', (c: Buffer) => { if (body.length < 200_000) body += c.toString() })
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
  })
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }) })
  req.on('error', (e) => resolve({ status: 0, body: e.message }))
})
