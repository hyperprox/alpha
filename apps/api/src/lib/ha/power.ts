// =============================================================================
//  HyperProx — power actions on HA guests go through HA state
//
//  An HA guest's on/off is owned by the HA manager. Stopping one with a direct
//  `pct stop` / `qm stop` sets HA's requested state to "stopped" behind the
//  person's back, and the next direct start is refused while the guest sits
//  down. So for an HA guest, start and stop are a change of HA state:
//
//    start            → state started
//    stop, shutdown   → state stopped (HA shuts it down, and forces it off if
//                       it does not stop within its timeout)
//    reboot           → not handled: HA leaves a reboot to Proxmox, and the
//                       guest stays "started" throughout
//
//  This is the hook the power routes call first. It returns { handled: false }
//  for a guest HA does not manage (or ignores), and the route carries on with
//  its direct call. Integrator: call it at the top of both power handlers,
//    POST /api/infra/vms/:node/:vmid/:type/:action    (routes/infrastructure.ts)
//    POST /api/proxmox/vms/:node/:vmid/:type/:action  (routes/proxmox.ts)
//  as
//    const ha = await haPowerHook({ node, vmid: Number(vmid), type, action }, actor)
//    if (ha.handled) return ha.ok ? { success: true, data: ha } : r.status(ha.status).send({ success: false, error: ha.message })
// =============================================================================

import { sidOf, formBody, buildSnapshot } from './parse'
import type { HaPve } from './read'
import { redactText } from './redact'
import type { Actor, GuestType } from './types'

export type PowerAction = 'start' | 'stop' | 'shutdown' | 'reboot'

export type HaPowerResult =
  | { handled: false }
  | { handled: true; ok: boolean; status: number; sid: string; state: 'started' | 'stopped'; message: string }

export interface HaPowerDeps {
  pve:   () => HaPve
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  isLocked?: () => boolean
}

let deps: HaPowerDeps | null = null
/** Wired once in routes/ha.ts (production) or by a test. */
export function setHaPowerDeps(d: HaPowerDeps | null) { deps = d }

const TARGET: Record<string, 'started' | 'stopped' | undefined> = { start: 'started', stop: 'stopped', shutdown: 'stopped' }

export async function haPowerHook(req: { node: string; vmid: number; type: GuestType | string; action: PowerAction | string }, actor: Actor, d: HaPowerDeps | null = deps): Promise<HaPowerResult> {
  if (!d) return { handled: false }
  if (req.type !== 'lxc' && req.type !== 'qemu') return { handled: false }
  const target = TARGET[req.action]
  if (!target) return { handled: false }
  const sid = sidOf(req.type, req.vmid)
  if (d.isLocked?.()) return { handled: true, ok: false, status: 423, sid, state: target, message: 'HyperProx is locked — sign in to start or stop guests. Nothing was changed.' }
  const pve = d.pve()
  const resources = await pve.fetchStrict<any[]>('/cluster/ha/resources')
  const res = (resources ?? []).find(r => String(r.sid) === sid)
  // Not HA-managed, or HA is told to ignore it: the direct call is the right one.
  if (!res || res.state === 'ignored') return { handled: false }
  const status = await pve.fetchStrict<any[]>('/cluster/ha/status/current')
  const snap = buildSnapshot({ resources, rules: [], status, nodes: [], vms: [], storage: [] })
  const label = `${req.type === 'lxc' ? 'Container' : 'VM'} ${req.vmid}`
  if (!snap.quorate) {
    await d.audit(`ha.power.${req.action}`, sid, { by: actor.email, ok: false, refused: 'not quorate' })
    return { handled: true, ok: false, status: 409, sid, state: target, message: `${label} is an HA guest and the cluster is not quorate, so HA cannot ${req.action} it now. Nothing was changed.` }
  }
  const svc = snap.services.find(s => s.sid === sid)
  // Disarmed in ignore mode: HA has let go of every guest, so Proxmox's own start/stop is the right call.
  if (snap.disarmMode === 'ignore' || svc?.state === 'ignore') return { handled: false }
  if (svc?.state === 'error') {
    return { handled: true, ok: false, status: 409, sid, state: target, message: `HA has ${label} in an error state. Turn HA off for it (or set it to disabled), fix it, then turn HA on again.` }
  }
  if (res.state === target) {
    return { handled: true, ok: true, status: 200, sid, state: target, message: `${label} is an HA guest and HA already has it ${target}.` }
  }
  try {
    await pve.fetchStrict(`/cluster/ha/resources/${encodeURIComponent(sid)}`, 'PUT', formBody({ state: target, ...(res.digest ? { digest: String(res.digest) } : {}) }))
  } catch (e: any) {
    const why = redactText(String(e?.message ?? e))
    await d.audit(`ha.power.${req.action}`, sid, { by: actor.email, ok: false, error: why })
    return { handled: true, ok: false, status: 502, sid, state: target, message: `${label} is an HA guest; Proxmox refused the HA state change: ${why}` }
  }
  // Outcome, not self-report: read the requested state back.
  const back = await pve.fetchStrict<any[]>('/cluster/ha/resources').catch(() => [])
  const now = (back ?? []).find(r => String(r.sid) === sid)
  const ok = now?.state === target
  await d.audit(`ha.power.${req.action}`, sid, { by: actor.email, ok, from: res.state, to: target, node: req.node })
  const what = target === 'started' ? 'start it' : 'shut it down (forced off if it does not stop in time) and keep it off'
  return ok
    ? { handled: true, ok, status: 200, sid, state: target, message: `${label} is an HA guest, so this went through HA: HA will ${what}.` }
    : { handled: true, ok, status: 502, sid, state: target, message: `${label}: the HA state change was sent, but Proxmox still shows "${now?.state ?? 'nothing'}".` }
}
