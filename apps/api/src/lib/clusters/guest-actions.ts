// =============================================================================
//  HyperProx — guest actions on any cluster, each one read back
//
//  Power, snapshot, back up now and delete, through the Proxmox client of the cluster this runs for. Each
//  action is checked afterwards against what Proxmox then reports, and the answer says what was found, not
//  what was hoped for. Delete needs the guest's name typed exactly and the guest stopped.
// =============================================================================

import type { ProxmoxClient } from '../proxmox-client'

export type GuestType = 'lxc' | 'qemu'
export type PowerAction = 'start' | 'stop' | 'shutdown' | 'reboot'

export class GuestActionRefusal extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not-found' | 'confirm' | 'state' = 'invalid') { super(message) }
}

import { NODE_RE } from '../route-params'
export function checkGuest(node: string, type: string, vmid: string | number): { node: string; type: GuestType; vmid: number } {
  const id = Number(vmid)
  if (!NODE_RE.test(node)) throw new GuestActionRefusal('That is not a node name.', 'not-found')
  if (type !== 'lxc' && type !== 'qemu') throw new GuestActionRefusal('No such guest type.', 'not-found')
  if (!Number.isInteger(id) || id < 100 || id > 999_999_999) throw new GuestActionRefusal('That is not a guest ID.', 'not-found')
  return { node, type, vmid: id }
}

const form = (p: Record<string, string | number>) => new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)] as [string, string])).toString()
const base = (g: { node: string; type: GuestType; vmid: number }) => `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`

export interface ActionDeps {
  pve: ProxmoxClient; sleep?: (ms: number) => Promise<void>; waitMs?: number; pollMs?: number
  /**
   * After a container is deleted: undo what HyperProx set up on its node for it (a backup server's NAS mount and
   * fstab line, lib/pbs/nfs.ts). Returns a sentence to append, or ''. It never fails the delete.
   */
  afterDestroy?: (g: { node: string; type: GuestType; vmid: number }) => Promise<string>
}

async function statusOf(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }): Promise<{ status: string; name: string; ha: boolean }> {
  const st = await pve.fetchStrict<any>(`${base(g)}/status/current`)
  if (!st) throw new GuestActionRefusal('No such guest on that node.', 'not-found')
  return { status: String(st.status ?? 'unknown'), name: String(st.name ?? g.vmid), ha: !!(st.ha && st.ha.managed) }
}

/** The display name Proxmox keeps for a guest (hostname for a container, name for a VM). */
export async function guestName(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }): Promise<string> {
  const cfg = await pve.fetchStrict<any>(`${base(g)}/config`)
  if (!cfg) throw new GuestActionRefusal('No such guest on that node.', 'not-found')
  return String(cfg.hostname ?? cfg.name ?? g.vmid)
}

export async function power(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }, action: PowerAction) {
  if (!['start', 'stop', 'shutdown', 'reboot'].includes(action)) throw new GuestActionRefusal(`No such action: ${action}`)
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const before = await statusOf(d.pve, g)
  const upid = await d.pve.fetchStrict<string>(`${base(g)}/status/${action}`, 'POST', '')
  if (typeof upid === 'string' && upid.startsWith('UPID:')) await d.pve.waitForTask(g.node, upid, { timeoutMs: d.waitMs ?? 180_000, intervalMs: d.pollMs ?? 2000, sleep })
  // HA-managed guests are started and stopped by HA after the request task ends, so wait for the state itself.
  const want = action === 'stop' || action === 'shutdown' ? 'stopped' : 'running'
  const deadline = Date.now() + (before.ha ? (d.waitMs ?? 180_000) : 20_000)
  let after = await statusOf(d.pve, g)
  while (after.status !== want && Date.now() < deadline) { await sleep(d.pollMs ?? 2000); after = await statusOf(d.pve, g) }
  const ok = after.status === want
  return {
    ok, status: after.status, name: after.name,
    words: ok ? `${after.name} is ${after.status} now (read back from Proxmox).`
      : `${after.name} was asked to ${action}, but Proxmox reports it as ${after.status}.`,
  }
}

const SNAP_RE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/

export async function snapshot(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }, name: string, description = '') {
  if (!SNAP_RE.test(name)) throw new GuestActionRefusal('A snapshot name starts with a letter and uses letters, digits, - and _ (2 to 40 characters).')
  const upid = await d.pve.fetchStrict<string>(`${base(g)}/snapshot`, 'POST', form({ snapname: name, description: String(description).slice(0, 200) }))
  if (typeof upid === 'string' && upid.startsWith('UPID:')) await d.pve.waitForTask(g.node, upid, { timeoutMs: d.waitMs ?? 600_000, intervalMs: d.pollMs ?? 2000, sleep: d.sleep })
  const list = await d.pve.fetchStrict<any[]>(`${base(g)}/snapshot`)
  const ok = (list ?? []).some(s => s?.name === name)
  return { ok, words: ok ? `Snapshot ${name} exists now (read back from Proxmox).` : `Proxmox finished, but no snapshot named ${name} is listed.` }
}

/** Storages on the node that take backups. */
export async function backupStorages(pve: ProxmoxClient, node: string): Promise<Array<{ storage: string; type: string; availBytes: number }>> {
  if (!NODE_RE.test(node)) throw new GuestActionRefusal('That is not a node name.', 'not-found')
  const rows = await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(node)}/storage?content=backup&enabled=1`)
  return (rows ?? []).filter(s => Number(s.active ?? 1) === 1).map(s => ({ storage: String(s.storage), type: String(s.type), availBytes: Number(s.avail ?? 0) }))
}

/** Start a backup now. It can take hours, so this returns the task; the caller reads it back with taskStatus. */
export async function backupNow(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }, storage: string) {
  const choices = await backupStorages(d.pve, g.node)
  if (!choices.some(c => c.storage === storage)) throw new GuestActionRefusal(`${storage} does not take backups on ${g.node}. Pick one of: ${choices.map(c => c.storage).join(', ') || 'none'}.`)
  const upid = await d.pve.fetchStrict<string>(`/nodes/${encodeURIComponent(g.node)}/vzdump`, 'POST', form({ vmid: g.vmid, storage, mode: 'snapshot', compress: 'zstd' }))
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error('Proxmox did not start a backup task.')
  return { upid, node: g.node }
}

export async function taskStatus(pve: ProxmoxClient, node: string, upid: string) {
  if (!NODE_RE.test(node) || !/^UPID:[A-Za-z0-9:._@!-]+$/.test(upid)) throw new GuestActionRefusal('That is not a task.', 'not-found')
  const b = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`
  const st = await pve.fetchStrict<any>(`${b}/status`)
  const log = await pve.fetchNode<Array<{ n: number; t: string }>>(`${b}/log?limit=500`).catch(() => null)
  const done = st?.status === 'stopped'
  return {
    running: !done, ok: done ? st?.exitstatus === 'OK' : null, exitstatus: st?.exitstatus ?? null, type: st?.type ?? null,
    tail: (Array.isArray(log) ? log : []).slice(-12).map(l => l.t),
  }
}

/**
 * Delete a guest: its name typed exactly, stopped, not under HA. Disks are destroyed with it (purge). Read back:
 * the guest must be gone from the cluster's list.
 */
export async function destroy(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }, confirmName: string, opts: { unreferencedDisks?: boolean } = {}) {
  const name = await guestName(d.pve, g)
  if (String(confirmName ?? '') !== name) throw new GuestActionRefusal(`Type the guest's name exactly (${name}) to delete it.`, 'confirm')
  const st = await statusOf(d.pve, g)
  if (st.status !== 'stopped') throw new GuestActionRefusal(`${name} is ${st.status}. Stop it first, then delete it.`, 'state')
  // Fail closed: a guest whose HA membership cannot be read is not deleted (HA would bring a managed one back).
  const ha = await d.pve.fetchStrict<any[]>('/cluster/ha/resources').catch(() => null)
  if (!Array.isArray(ha)) throw new GuestActionRefusal(`HyperProx could not read the HA list, so it did not delete ${name}. Try again in a moment.`, 'state')
  const sid = `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`
  if (ha.some(r => r?.sid === sid)) throw new GuestActionRefusal(`${name} is managed by HA. Take it out of HA first, so HA does not try to bring it back.`, 'state')
  // purge=1 also takes it out of backup jobs, replication and HA. destroy-unreferenced-disks also deletes any older
  // volume named for this ID, so a caller deleting a guest it made itself (a website's container) turns it off.
  const upid = await d.pve.fetchStrict<string>(`${base(g)}?purge=1${opts.unreferencedDisks === false ? '' : '&destroy-unreferenced-disks=1'}`, 'DELETE')
  if (typeof upid === 'string' && upid.startsWith('UPID:')) await d.pve.waitForTask(g.node, upid, { timeoutMs: d.waitMs ?? 600_000, intervalMs: d.pollMs ?? 2000, sleep: d.sleep })
  const left = await d.pve.fetchStrict<any[]>('/cluster/resources?type=vm')
  const gone = !(left ?? []).some(r => Number(r?.vmid) === g.vmid)
  const after = gone && g.type === 'lxc' && d.afterDestroy ? await d.afterDestroy(g).catch(() => ' HyperProx could not check its node for a leftover NAS mount.') : ''
  return { ok: gone, words: gone ? `${name} (${g.vmid}) is deleted: it is no longer listed.${after}` : `Proxmox finished, but ${g.vmid} is still listed.` }
}

// ── For a guest HyperProx made and is now removing whole (a website's container) ──────────────────────────

const sidOf = (g: { type: GuestType; vmid: number }) => `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`

/** Is the guest an HA resource? Fails closed: a list that cannot be read throws. */
export async function inHa(pve: Pick<ProxmoxClient, 'fetchStrict'>, g: { type: GuestType; vmid: number }): Promise<boolean> {
  const ha = await pve.fetchStrict<any[]>('/cluster/ha/resources')
  if (!Array.isArray(ha)) throw new GuestActionRefusal('Proxmox did not return the HA list.', 'state')
  return ha.some(r => r?.sid === sidOf(g))
}

/**
 * Take the guest out of HA (what `ha-manager remove` does), then read the list back. The guest keeps running;
 * HA simply stops managing it. purge=1 also drops it from HA rules.
 */
export async function removeFromHa(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }): Promise<{ ok: boolean; words: string }> {
  if (!(await inHa(d.pve, g))) return { ok: true, words: `${sidOf(g)} was not under HA.` }
  await d.pve.fetchStrict(`/cluster/ha/resources/${encodeURIComponent(sidOf(g))}?purge=1`, 'DELETE')
  const still = await inHa(d.pve, g)
  return { ok: !still, words: still ? `${sidOf(g)} is still listed under HA after the removal.` : `${sidOf(g)} was taken out of HA (read back).` }
}

export interface BackupJobUse { id: string; vmids: number[]; only: boolean }

/** The backup jobs that list this ID by number (/cluster/backup). An "all guests" or pool job does not list it. */
export async function backupJobsWith(pve: Pick<ProxmoxClient, 'fetchStrict'>, vmid: number): Promise<BackupJobUse[]> {
  const jobs = await pve.fetchStrict<any[]>('/cluster/backup')
  if (!Array.isArray(jobs)) throw new GuestActionRefusal('Proxmox did not return the backup jobs.', 'state')
  return jobs.flatMap(j => {
    const vmids = String(j?.vmid ?? '').split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0)
    if (!vmids.includes(vmid) || typeof j?.id !== 'string') return []
    return [{ id: j.id, vmids, only: vmids.every(v => v === vmid) }]
  })
}

/**
 * Take an ID out of every backup job that lists it, then read the jobs back. A dead ID left in a job fails that job
 * on every node while every live guest still backs up, so this runs after a delete even though purge=1 should have
 * done it. A job that lists only this ID backs up nothing else and is deleted. Safe to run again.
 */
export async function removeFromBackupJobs(pve: Pick<ProxmoxClient, 'fetchStrict'>, vmid: number): Promise<{ ok: boolean; words: string; jobs: string[] }> {
  const uses = await backupJobsWith(pve, vmid)
  if (!uses.length) return { ok: true, words: `No backup job lists ${vmid}.`, jobs: [] }
  const done: string[] = []
  for (const u of uses) {
    const path = `/cluster/backup/${encodeURIComponent(u.id)}`
    if (u.only) await pve.fetchStrict(path, 'DELETE')
    else await pve.fetchStrict(path, 'PUT', form({ vmid: u.vmids.filter(v => v !== vmid).join(',') }))
    done.push(u.only ? `deleted job ${u.id} (it listed only ${vmid})` : `took ${vmid} out of job ${u.id}`)
  }
  const left = await backupJobsWith(pve, vmid)
  return left.length
    ? { ok: false, words: `${vmid} is still listed in backup job(s) ${left.map(l => l.id).join(', ')} after the change.`, jobs: uses.map(u => u.id) }
    : { ok: true, words: `Backup jobs: ${done.join('; ')} (read back).`, jobs: uses.map(u => u.id) }
}

/**
 * Remove a container HyperProx made, completely: out of HA, stopped, deleted with its disks (purge, never
 * destroy-unreferenced-disks), out of every backup job, and the PBS NAS mount hook run. Each step is read back;
 * the first one that does not hold stops the rest and says where it stopped. Running it again picks up from there.
 */
export async function destroyOwned(d: ActionDeps, g: { node: string; type: GuestType; vmid: number }, confirmName: string): Promise<{ ok: boolean; words: string; steps: string[] }> {
  const steps: string[] = []
  const ha = await removeFromHa(d, g)
  steps.push(ha.words)
  if (!ha.ok) return { ok: false, words: ha.words, steps }
  const st = await statusOf(d.pve, g)
  if (st.status !== 'stopped') {
    const p = await power(d, g, 'stop')
    steps.push(p.words)
    if (!p.ok) return { ok: false, words: p.words, steps }
  }
  const del = await destroy(d, g, confirmName, { unreferencedDisks: false })
  steps.push(del.words)
  if (!del.ok) return { ok: false, words: del.words, steps }
  const jobs = await removeFromBackupJobs(d.pve, g.vmid)
  steps.push(jobs.words)
  return { ok: jobs.ok, words: steps.join(' '), steps }
}
