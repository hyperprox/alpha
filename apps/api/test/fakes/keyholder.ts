// Starts the real keyholder (bin/hyperprox-keyholder, python3) on a socket in a fresh 0700 temp dir.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const KEYHOLDER_BIN = path.resolve(__dirname, '..', '..', '..', '..', 'bin', 'hyperprox-keyholder')

export interface RunningKeyholder {
  proc: ChildProcess
  dir: string
  socket: string
  /** Everything it wrote to stdout and stderr (its journal, in production). */
  output(): string
  exited: Promise<number | null>
  stop(signal?: NodeJS.Signals): Promise<number | null>
}

export function keyholderDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-'))
  fs.chmodSync(dir, 0o700)
  return dir
}

export async function startKeyholder(opts: { dir?: string; args?: string[]; expectFail?: boolean } = {}): Promise<RunningKeyholder> {
  const dir = opts.dir ?? keyholderDir()
  const socket = path.join(dir, 'keyholder.sock')
  const proc = spawn('python3', [KEYHOLDER_BIN, '--socket', socket, ...(opts.args ?? [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout!.on('data', d => { out += d })
  proc.stderr!.on('data', d => { out += d })
  const exited = new Promise<number | null>(r => proc.once('exit', code => r(code)))
  if (!opts.expectFail) {
    const t0 = Date.now()
    while (!/listening on/.test(out)) {
      if (proc.exitCode !== null) throw new Error(`keyholder exited: ${out}`)
      if (Date.now() - t0 > 10_000) throw new Error(`keyholder did not start: ${out}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  return {
    proc, dir, socket, exited,
    output: () => out,
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal)
      return exited
    },
  }
}

export async function waitFor(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}
