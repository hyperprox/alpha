// =============================================================================
//  HyperProx — long jobs that a restart must not cut short
//
//  Some plug-in work outlives a request: a Nextcloud update, a database repair
//  that runs for an hour. Restarting the API in the middle (deploy.sh, the
//  in-app updater) would cut the ones that run inside this process, and leave
//  the ones that run detached in a guest without anyone watching them.
//
//  So such work registers here while it runs. Each one is a small JSON file in
//  /run/hyperprox-busy (HYPERPROX_BUSY_DIR), which deploy.sh reads before it
//  restarts anything and the in-app updater checks before it starts:
//    { "id", "owner", "label", "pid", "detached", "at" }
//  `detached` work runs outside this process (in a guest) and stays busy across
//  an API restart until its owner sees it finish. Work that runs in this
//  process is busy only while that process (`pid`) is alive, so a crash never
//  leaves a stale marker behind for long.
//
//  Any plug-in can register: the registry knows nothing about Nextcloud.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'

export interface LongJob { id: string; owner: string; label: string; pid: number; detached: boolean; at: string }

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/

export const busyDir = () => process.env.HYPERPROX_BUSY_DIR || '/run/hyperprox-busy'

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Mark work as running. Throws when the marker cannot be written: a long job must not run unguarded. */
export function registerLongJob(j: { id: string; owner: string; label: string; detached: boolean }): void {
  if (!ID_RE.test(j.id) || !ID_RE.test(j.owner)) throw new Error('Bad long-job id.')
  const dir = busyDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const rec: LongJob = { id: j.id, owner: j.owner, label: j.label.replace(/[\u0000-\u001f"\\]/g, ' ').slice(0, 200), pid: process.pid, detached: j.detached, at: new Date().toISOString() }
  const file = path.join(dir, `${j.id}.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o644 })
  fs.renameSync(`${file}.tmp`, file)
}

export function endLongJob(id: string): void {
  if (!ID_RE.test(id)) return
  try { fs.unlinkSync(path.join(busyDir(), `${id}.json`)) } catch { /* already gone */ }
}

/** Every job still running. Markers of in-process work whose process is gone are removed on the way. */
export function busyJobs(owner?: string): LongJob[] {
  let names: string[]
  try { names = fs.readdirSync(busyDir()).filter(n => n.endsWith('.json')) } catch { return [] }
  const out: LongJob[] = []
  for (const n of names) {
    const file = path.join(busyDir(), n)
    let j: LongJob
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!j || typeof j.id !== 'string') continue
    if (!j.detached && !alive(Number(j.pid))) { try { fs.unlinkSync(file) } catch { /* raced */ } continue }
    if (!owner || j.owner === owner) out.push(j)
  }
  return out
}

/** For the in-app updater's refusal and for anyone who asks: what is running, in words. */
export function busyWords(jobs: LongJob[]): string {
  return jobs.map(j => j.label).join('; ')
}
