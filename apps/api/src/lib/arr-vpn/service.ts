// =============================================================================
//  HyperProx — Arr Stack VPN (Gluetun) panel: reading, fixing, and the alert
//
//   status   the reading (lib/arr-vpn/parse.ts), shared for 10 s so several open pages cost one look inside the guest.
//   act      the fixes, each audited before it runs (no entry, nothing done) and read back after:
//              set-port      put Gluetun's forwarded port into qBittorrent (its listen_port), the same call Gluetun's
//                            own port-forwarding hook makes;
//              reconnect     ask Gluetun's control server to stop and start the tunnel (PUT /v1/vpn/status), which keeps
//                            qBittorrent's network. If the control server refuses (a later Gluetun wants a key), the
//                            container is restarted instead, then qBittorrent (it shares Gluetun's network and loses it
//                            when Gluetun restarts): downloads pause for about a minute;
//              restart-qbit  restart qBittorrent alone (it was left on a network that no longer exists, or stopped).
//   watch    every two minutes while HyperProx is unlocked: a tunnel that is down, or a port problem, that lasts more
//            than ten minutes raises one alert (the notification bus, type arr.vpn.*), and one all-clear when it ends.
//
//  The VPN's login is never read: the reading filters Gluetun's settings inside the guest. Switching region is not
//  offered: the region lives in the same file as the login (/opt/arr/.env), and changing it means recreating both
//  containers; that is left to a person.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import type { NotifyEventInput } from '../notify/types'
import type { GuestRef } from '../guest-id'
import { READ_SCRIPT, absent, alertStep, emptyAlertState, parseReading, vpnStatus, type AlertState, type FixName, type VpnStatus } from './parse'

export class VpnRefusal extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'VpnRefusal' }
}

export interface ExecOut { code: number; output: string; timedOut: boolean }

export interface VpnDeps {
  /** Which guest runs the Arr Stack. Null: HyperProx cannot tell. */
  locate(): Promise<{ guest: GuestRef; name: string } | null>
  /** Runs a script in that guest (the guest guard applies). */
  exec(g: GuestRef, script: string, timeoutMs: number): Promise<ExecOut>
  /** The plug-in's qBittorrent connection, when it has one. */
  qbit(): Promise<CoreEndpointClient | null>
  /** Throws when the entry cannot be written: the fix then does not run. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
  publish(e: NotifyEventInput): Promise<void>
  now(): number
  unlocked(): boolean
  log?(m: string): void
}

const CACHE_MS = 10_000
const msg = (e: any) => String(e?.message ?? e).slice(0, 200)

/** Reconnect: the control server first; a container restart only if it refuses. Prints @@via and @@after. */
export const RECONNECT_SCRIPT = String.raw`set -u
ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' gluetun 2>/dev/null | awk '{print $1}')
put() {
  if command -v curl >/dev/null 2>&1 && [ -n "$ip" ]; then
    curl -s -m 15 -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' --data "{\"status\":\"$1\"}" "http://$ip:8000/v1/vpn/status"
  else echo none; fi
}
b=none
a=$(put stopped)
if [ "$a" = 200 ]; then sleep 3; b=$(put running); fi
if [ "$a" = 200 ] && [ "$b" = 200 ]; then
  echo "@@via control"
else
  echo "@@via restart $a $b"
  docker restart gluetun >/dev/null
  for i in $(seq 1 36); do [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' gluetun 2>/dev/null)" = healthy ] && break; sleep 5; done
  docker restart qbittorrent >/dev/null 2>&1
fi
for i in $(seq 1 24); do
  s=$(docker exec gluetun wget -qO- -T 5 http://127.0.0.1:8000/v1/vpn/status 2>/dev/null)
  case "$s" in *running*) break;; esac
  sleep 5
done
echo "@@after $(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' gluetun 2>/dev/null)"
`

export const RESTART_QBIT_SCRIPT = String.raw`set -u
docker restart qbittorrent >/dev/null && echo '@@restarted' || echo '@@failed'
`

/** Gluetun's own port-forwarding hook, run by hand: qBittorrent answers it from inside Gluetun's network. */
export function setPortScript(p: number): string {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('bad port')
  return `docker exec gluetun wget -qO- -T 10 --post-data 'json={"listen_port":${p}}' http://127.0.0.1:8080/api/v2/app/setPreferences >/dev/null 2>&1 && echo '@@set' || echo '@@failed'\n`
}

export interface ActResult { action: FixName; done: boolean; summary: string; notes: string[]; status: VpnStatus }

export class VpnService {
  private memo: { at: number; p: Promise<VpnStatus> } | null = null
  private alerts: AlertState = emptyAlertState()
  private busy = false

  constructor(private d: VpnDeps) {}

  /** The panel's reading, shared for a few seconds. `fresh` skips the shared one. */
  status(fresh = false): Promise<VpnStatus> {
    const now = this.d.now()
    if (!fresh && this.memo && now - this.memo.at < CACHE_MS) return this.memo.p
    const p = this.read()
    const mine = { at: now, p }
    this.memo = mine
    p.catch(() => { if (this.memo === mine) this.memo = null })
    return p
  }

  private async read(): Promise<VpnStatus> {
    const now = this.d.now()
    const where = await this.d.locate().catch(() => null)
    if (!where) return absent(now, 'HyperProx could not tell which container runs your Arr Stack, so the VPN cannot be checked.')
    let out: ExecOut
    try { out = await this.d.exec(where.guest, READ_SCRIPT, 45_000) } catch (e) { return absent(now, `The Arr Stack's container could not be read: ${msg(e)}`) }
    const r = parseReading(out.output)
    if (!r.complete && r.docker && !out.output.includes('@@nogluetun')) return absent(now, out.timedOut ? 'Reading the VPN took too long.' : 'The VPN could not be read.', r.present)
    // qBittorrent through the plug-in's own connection, when there is one; the in-guest reading otherwise.
    const qb = r.present ? await this.d.qbit().catch(() => null) : null
    const [prefs, transfer] = qb ? await Promise.all([qb.get('/api/v2/app/preferences', 10_000).catch(() => null), qb.get('/api/v2/transfer/info', 10_000).catch(() => null)]) : [null, null]
    return vpnStatus(r, this.d.now(), { guest: where.name, prefs, transfer })
  }

  async act(action: FixName, by: string): Promise<ActResult> {
    if (this.busy) throw new VpnRefusal(409, 'busy', 'A VPN fix is already running. Wait for it to finish.')
    this.busy = true
    try {
      const where = await this.d.locate().catch(() => null)
      if (!where) throw new VpnRefusal(409, 'no_guest', 'HyperProx could not tell which container runs your Arr Stack.')
      const before = await this.status(true)
      if (!before.present) throw new VpnRefusal(409, 'no_vpn', 'This Arr Stack has no VPN container.')
      const notes: string[] = []
      const audit = async (d: Record<string, unknown>) => {
        try { await this.d.audit('arrstack.vpn.fix', { action, by, guest: where.name, ...d }) } catch { throw new VpnRefusal(503, 'audit_unavailable', 'The audit log could not be written, so nothing was changed.') }
      }
      let done = false
      let summary = ''
      if (action === 'set-port') {
        const p = before.forwardedPort
        if (p === null) throw new VpnRefusal(409, 'no_port', 'The VPN has not handed out a port yet, so there is nothing to put into qBittorrent. Try "Reconnect the tunnel".')
        if (before.listenPort === p) throw new VpnRefusal(409, 'already', `qBittorrent already listens on ${p}.`)
        await audit({ port: p, was: before.listenPort })
        const qb = await this.d.qbit().catch(() => null)
        let set = false
        if (qb?.postForm) set = await qb.postForm('/api/v2/app/setPreferences', { json: JSON.stringify({ listen_port: p }) }, 15_000).then(() => true, () => false)
        if (!set) set = /@@set/.test((await this.d.exec(where.guest, setPortScript(p), 30_000)).output)
        const after = await this.status(true)
        done = after.listenPort === p
        summary = done ? `qBittorrent now listens on ${p}, the port the VPN forwards.` : set ? `qBittorrent was told to listen on ${p}, but still reports ${after.listenPort ?? 'no port'}.` : 'qBittorrent did not accept the new port.'
        await this.d.audit('arrstack.vpn.fix.done', { action, by, ok: done }).catch(e => this.d.log?.(`[arr-vpn] audit failed: ${msg(e)}`))
        return { action, done, summary, notes, status: after }
      }
      if (action === 'reconnect') {
        await audit({ tunnel: before.tunnel })
        const out = await this.d.exec(where.guest, RECONNECT_SCRIPT, 5 * 60_000)
        const via = /@@via (\w+)/.exec(out.output)?.[1]
        if (via === 'restart') notes.push('Gluetun\'s control server did not accept the request, so the VPN container was restarted, then qBittorrent.')
        const after = await this.status(true)
        done = after.tunnel === 'up'
        summary = done ? `The tunnel is up again${after.location ? ` (${after.location})` : ''}.` : 'The tunnel did not come back up. Check the VPN provider\'s status and the Gluetun log.'
        if (after.problems.some(p => p.code === 'mismatch')) notes.push('The forwarded port changed and qBittorrent has not caught up: use "Put the forwarded port into qBittorrent".')
        await this.d.audit('arrstack.vpn.fix.done', { action, by, ok: done, via: via ?? 'unknown' }).catch(e => this.d.log?.(`[arr-vpn] audit failed: ${msg(e)}`))
        return { action, done, summary, notes, status: after }
      }
      if (action === 'restart-qbit') {
        await audit({})
        const out = await this.d.exec(where.guest, RESTART_QBIT_SCRIPT, 2 * 60_000)
        const after = await this.status(true)
        done = /@@restarted/.test(out.output) && !after.problems.some(p => p.code === 'qbit-stale' || p.code === 'qbit-down')
        summary = done ? 'qBittorrent restarted on the VPN\'s network.' : 'qBittorrent did not come back cleanly. Check its log in the container.'
        await this.d.audit('arrstack.vpn.fix.done', { action, by, ok: done }).catch(e => this.d.log?.(`[arr-vpn] audit failed: ${msg(e)}`))
        return { action, done, summary, notes, status: after }
      }
      throw new VpnRefusal(400, 'bad_request', 'Unknown fix.')
    } finally {
      this.busy = false
    }
  }

  /** One look for the alert. Does nothing while locked (the node logins are in the vault). */
  async watchTick(): Promise<void> {
    if (!this.d.unlocked()) return
    const s = await this.status(true).catch(() => null)
    if (!s || !s.present || s.unavailable) return
    const { state, fire, clear } = alertStep(this.alerts, s.problems, this.d.now())
    this.alerts = state
    for (const p of fire) {
      await this.d.publish({
        type: `arr.vpn.${p.code}`, severity: 'warning', fingerprint: `arr-vpn:${p.code}`,
        title: p.code === 'down' ? 'Arr Stack: the VPN tunnel is down' : 'Arr Stack: the VPN port is not reaching qBittorrent',
        lines: [p.text, 'It has lasted more than ten minutes. The Arr Stack page has a button that fixes it.'],
        link: '/plugins/arrstack', linkLabel: 'Open the Arr Stack', where: 'Arr Stack page',
      }).catch(e => this.d.log?.(`[arr-vpn] the alert could not be sent: ${msg(e)}`))
    }
    for (const code of clear) {
      await this.d.publish({
        type: `arr.vpn.${code}`, severity: 'info', fingerprint: `arr-vpn:${code}`, resolved: true,
        title: code === 'down' ? 'Arr Stack: the VPN tunnel is back up' : 'Arr Stack: the VPN port reaches qBittorrent again',
        link: '/plugins/arrstack', linkLabel: 'Open the Arr Stack', where: 'Arr Stack page',
      }).catch(e => this.d.log?.(`[arr-vpn] the all-clear could not be sent: ${msg(e)}`))
    }
  }
}

/** The watch: a look every two minutes, the first three minutes after start. Returns the stop. */
export function startVpnWatch(svc: { watchTick(): Promise<unknown> }, log?: (m: string) => void, everyMs = 2 * 60_000, firstMs = 3 * 60_000): () => void {
  const go = () => { svc.watchTick().catch(e => log?.(`[arr-vpn] watch failed: ${msg(e)}`)) }
  const first = setTimeout(go, firstMs)
  const every = setInterval(go, everyMs)
  first.unref?.(); every.unref?.()
  return () => { clearTimeout(first); clearInterval(every) }
}
