// =============================================================================
//  HyperProx — the transcoders' setup chores
//
//  After the apps start, what a person would otherwise click through:
//
//  Unmanic   wait until it answers; point its first library at /data/media (the
//            library path is the Arr Stack's, so both see the same files) with
//            no plug-in enabled, so nothing is changed until the person chooses
//            what to do to their files; set the worker count; (a worker) link it
//            to the Unmanic it works for, from both sides; and connect
//            HyperProx's own Unmanic plug-in.
//  Tdarr     wait until the server answers, and until its node has registered.
//
//  Every change is read back from the app itself and a step is "done" only when
//  the read-back agrees. Neither app takes a login in this version, so nothing
//  secret is made, logged or kept; both sit on the container's LAN address only.
// =============================================================================

import type { Http } from '../arr/setup'
import type { StepRef } from '../arr/setup'
import { LIBRARY_DIR } from './media'
import { UNMANIC_PORT, TDARR_WEB_PORT } from './compose'

export interface TcSetupDeps {
  http: Http
  wait(ms: number): Promise<unknown>
  pluginSettings(id: string): Promise<Record<string, string>>
  savePluginSettings(id: string, values: Record<string, string>): Promise<void>
}

export const unmanicUrl = (ip: string) => `http://${ip}:${UNMANIC_PORT}`
export const tdarrUrl = (ip: string) => `http://${ip}:${TDARR_WEB_PORT}`
const API = '/unmanic/api/v2'

class SetupError extends Error {}
const fail = (m: string): never => { throw new SetupError(m) }

async function json(d: TcSetupDeps, method: 'GET' | 'POST' | 'DELETE', base: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<any> {
  const r = await d.http({ method, url: `${base}${API}${path}`, ...(body !== undefined ? { json: body } : {}), timeoutMs })
  if (r.status < 200 || r.status >= 300) fail(`${path} answered ${r.status}.`)
  try { return r.body ? JSON.parse(r.body) : {} } catch { return fail(`${path} did not answer with JSON.`) }
}

/** Wait until Unmanic's API answers, up to about two minutes (it builds its database on first start). */
export async function waitForUnmanic(d: TcSetupDeps, base: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await d.http({ method: 'GET', url: `${base}${API}/settings/read`, timeoutMs: 5000 }).catch(() => null)
    if (r && r.status === 200 && /"settings"/.test(r.body)) return
    await d.wait(3000)
  }
  fail('Unmanic did not answer after two minutes. The container may still be starting; open it and check, then run the install again if it never comes up.')
}

/** Point the first library at /data/media, named Media, scanner as chosen, every plug-in setting left as it was. */
export async function setUnmanicLibrary(d: TcSetupDeps, base: string, scan: boolean): Promise<string> {
  const list = await json(d, 'GET', base, '/settings/libraries')
  const first = Array.isArray(list?.libraries) ? list.libraries[0] : null
  if (!first || !Number.isInteger(first.id)) return fail('Unmanic has no library to set up.')
  const cur = await json(d, 'POST', base, '/settings/library/read', { id: first.id })
  const cfg = { ...(cur.library_config ?? {}), name: 'Media', path: LIBRARY_DIR, enable_scanner: scan, enable_inotify: false }
  await json(d, 'POST', base, '/settings/library/write', { library_config: cfg, plugins: cur.plugins ?? { enabled_plugins: [] } })
  const back = await json(d, 'POST', base, '/settings/library/read', { id: first.id })
  const c = back.library_config ?? {}
  if (c.path !== LIBRARY_DIR || Boolean(c.enable_scanner) !== scan) fail(`Unmanic did not keep the library (it reads back ${c.path ?? 'nothing'}).`)
  const n = (back.plugins?.enabled_plugins ?? []).length
  return `Library "Media" is ${LIBRARY_DIR}${scan ? ', scanned on a schedule' : ''}. ${n ? `${n} plug-in(s) already enabled.` : 'No plug-in is enabled, so nothing is changed until you choose one.'}`
}

/** Set the first worker group's size. */
export async function setUnmanicWorkers(d: TcSetupDeps, base: string, workers: number): Promise<string> {
  const list = await json(d, 'GET', base, '/settings/worker_groups')
  const g = Array.isArray(list?.worker_groups) ? list.worker_groups[0] : null
  if (!g || !Number.isInteger(g.id)) return fail('Unmanic has no worker group to set up.')
  await json(d, 'POST', base, '/settings/worker_group/write', { ...g, number_of_workers: workers })
  const back = await json(d, 'POST', base, '/settings/worker_group/read', { id: g.id })
  if (Number(back.number_of_workers) !== workers) fail(`Unmanic did not keep the worker count (it reads back ${back.number_of_workers}).`)
  return `${workers} worker${workers === 1 ? '' : 's'}.`
}

export interface LinkRecord { mainUrl: string; uuid: string }

/** The remote installations an Unmanic has, by address. */
async function links(d: TcSetupDeps, base: string): Promise<Array<{ address: string; uuid: string }>> {
  const s = (await json(d, 'GET', base, '/settings/read')).settings ?? {}
  return Array.isArray(s.remote_installations) ? s.remote_installations.map((x: any) => ({ address: String(x?.address ?? ''), uuid: String(x?.uuid ?? '') })) : []
}

async function linkTo(d: TcSetupDeps, base: string, address: string, mode: { send: boolean; receive: boolean }): Promise<string> {
  const v = await json(d, 'POST', base, '/settings/link/validate', { address, auth: 'None', username: '', password: '' })
  const inst = v.installation ?? {}
  if (!inst.uuid) fail(`${address} did not identify itself as an Unmanic.`)
  const cfg = {
    ...inst, address, auth: 'None', username: '', password: '',
    enable_receiving_tasks: mode.receive, enable_sending_tasks: mode.send,
    enable_task_preloading: true, preloading_count: 2, enable_checksum_validation: false,
    enable_config_missing_libraries: false, enable_update_library_config: false,
  }
  await json(d, 'POST', base, '/settings/link/write', { link_config: cfg })
  return String(inst.uuid)
}

/**
 * Link a worker to the Unmanic it works for, from both sides: the main one sends tasks to the worker, and the
 * worker accepts tasks from the main one. A link the main Unmanic already had is left exactly as it was and not
 * recorded, so a clean-up can only ever remove one this install made.
 */
export async function linkWorker(d: TcSetupDeps, o: { main: string; mainAddress: string; worker: string; workerAddress: string }, onMade: (r: LinkRecord) => void = () => {}): Promise<{ detail: string; made: LinkRecord | null }> {
  const had = (await links(d, o.main)).find(x => x.address === o.workerAddress)
  let made: LinkRecord | null = null
  if (!had) {
    const uuid = await linkTo(d, o.main, o.workerAddress, { send: true, receive: false })
    made = { mainUrl: o.main, uuid }
    // Recorded the moment it exists: a failure on the worker's side must still be able to undo it.
    onMade(made)
  }
  await linkTo(d, o.worker, o.mainAddress, { send: false, receive: true })
  const back = await links(d, o.main)
  if (!back.some(x => x.address === o.workerAddress)) fail('The main Unmanic did not keep the link.')
  return {
    detail: had ? `${o.main} already linked to this worker; it was left as it was, and the worker now accepts its tasks.`
      : `${o.main} sends tasks to this worker and the worker accepts them. Files travel over the network to it and back.`,
    made,
  }
}

/** Remove one link this install made, by its id. Returns a sentence for the clean-up message. */
export async function unlinkWorker(d: TcSetupDeps, r: LinkRecord): Promise<string> {
  try {
    await json(d, 'DELETE', r.mainUrl, '/settings/link/remove', { uuid: r.uuid })
    return `The link on ${r.mainUrl} to the removed worker was undone.`
  } catch (e: any) {
    return `The link on ${r.mainUrl} to the removed worker could not be undone (${e.message}); remove it under Settings, Link remote installation.`
  }
}

const SLOTS: Array<[string, string]> = [['url', 'label'], ['url2', 'label2'], ['url3', 'label3']]

/**
 * Connect HyperProx's Unmanic plug-in: the first empty worker slot gets this address. Unmanic legitimately runs on
 * several nodes, so a slot that is taken is never replaced; an address already there is left alone.
 */
export async function wireUnmanicPlugin(d: TcSetupDeps, url: string, label: string): Promise<{ status: 'done' | 'skipped'; detail: string }> {
  const cur = await d.pluginSettings('unmanic').catch(() => ({} as Record<string, string>))
  const have = SLOTS.find(([u]) => cur[u] === url)
  if (have) return { status: 'skipped', detail: `The Unmanic plug-in already reads ${url}.` }
  const slot = SLOTS.find(([u]) => !cur[u])
  if (!slot) return { status: 'skipped', detail: 'The Unmanic plug-in already reads three workers, which is all it has room for; open this one by its address.' }
  const values = { ...cur, [slot[0]]: url, [slot[1]]: label }
  await d.savePluginSettings('unmanic', values)
  const back = await d.pluginSettings('unmanic')
  if (back[slot[0]] !== url) fail(`The Unmanic plug-in did not read back ${url}.`)
  return { status: 'done', detail: `The Unmanic plug-in reads ${url} as "${label}"; it shows on the Unmanic page now.` }
}

// ── Tdarr ───────────────────────────────────────────────────────────────────

/** Wait until the server's page answers with Tdarr in it. */
export async function waitForTdarr(d: TcSetupDeps, base: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await d.http({ method: 'GET', url: `${base}/`, timeoutMs: 5000 }).catch(() => null)
    if (r && r.status === 200 && /Tdarr/i.test(r.body)) return
    await d.wait(3000)
  }
  fail('Tdarr did not answer after two minutes. The container may still be starting; open it and check, then run the install again if it never comes up.')
}

export type NodeSeen = { seen: true } | { seen: false; readable: boolean }

/** Is a node with this name registered with the server? `readable` false means the node list itself could not be read. */
export async function tdarrNodeSeen(d: TcSetupDeps, base: string, name: string): Promise<NodeSeen> {
  const r = await d.http({ method: 'GET', url: `${base}/api/v2/get-nodes`, timeoutMs: 8000 }).catch(() => null)
  if (!r || r.status !== 200) return { seen: false, readable: false }
  let j: any
  try { j = JSON.parse(r.body) } catch { return { seen: false, readable: false } }
  if (!j || typeof j !== 'object') return { seen: false, readable: false }
  const rows = Array.isArray(j) ? j : Object.values(j)
  return rows.some((n: any) => n && typeof n === 'object' && (n.nodeName === name || n.name === name)) ? { seen: true } : { seen: false, readable: true }
}

/** Wait (about two minutes) for the node to register. Unreadable list: not a failure, said so. */
export async function waitForTdarrNode(d: TcSetupDeps, base: string, name: string, step: StepRef, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const s = await tdarrNodeSeen(d, base, name)
    if (s.seen) { step.status = 'done'; step.detail = `Node "${name}" has registered with the server.`; return }
    if (!s.readable) { step.status = 'skipped'; step.detail = `The server's node list could not be read, so HyperProx cannot confirm node "${name}". Open the Nodes tab in Tdarr to check.`; return }
    await d.wait(3000)
  }
  fail(`Node "${name}" did not register with the Tdarr server within two minutes. The usual causes are a different Tdarr version on the two sides, or the server not reaching the node's address back.`)
}

/** A server's version, when it says (its status answer), so a node can be given the same one. */
export async function tdarrServerVersion(d: Pick<TcSetupDeps, 'http'>, base: string): Promise<string | null> {
  const r = await d.http({ method: 'GET', url: `${base}/api/v2/status`, timeoutMs: 8000 }).catch(() => null)
  if (!r || r.status !== 200) return null
  try { const v = JSON.parse(r.body)?.version; return typeof v === 'string' && /^\d{1,2}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null } catch { return null }
}

export { SetupError }
