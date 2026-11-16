// =============================================================================
//  HyperProx — the web proxies (NGINX, Caddy, Envoy): connect, read, act
//
//  One service for the three plug-ins. An instance is a container that runs
//  one of them. HyperProx finds it by itself (a Catalogue install, the
//  Catalogue's detection, the install marker in the container's notes) and
//  connects it: a read-only look inside proves the proxy is there. A person is
//  asked only when one is found that a look cannot confirm.
//
//  Everything inside the guest goes through the remote executor, which refuses
//  a guest HyperProx must leave alone (the hyperprox-ignore tag, Remote
//  access's "never look inside" list) before any login is used; this service
//  asks the same rule first, so a refusal is said in words.
//
//  Every problem a reading shows carries the action that fixes it, when one
//  exists. An action is run only when the current reading offers it (a fix is
//  never run from a stale page), only for an admin (routes and lib/roles.ts),
//  only when confirmed, and always audited.
// =============================================================================

import { randomUUID } from 'node:crypto'
import { shq } from '../shell'
import { SYSTEM_ACTOR, exclusionOf, type AdapterContext, type Outcome } from '../auto-connect/core'
import { IGNORE_TAG, exclusionReason } from '../guest-guard'
import { auditBy } from '../http/request-actor'
import type { Machine } from '../remote/types'
import type { ExecResult } from '../node-exec'
import { KIND_NAME, PROBES, type Cert, parseCaddy, parseEnvoy, parseNginx, type CaddyReading, type EnvoyReading, type NginxReading, type WebProxyKind } from './probes'

export class WebProxyRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'WebProxyRefusal' }
}

export interface Actor { email: string; token: string | null }
export const actorLabel = (a: Actor) => (a.token ? `${a.email} (API token ${a.token})` : a.email)

export interface WebProxyInstance {
  id:        string
  kind:      WebProxyKind
  machineId: string
  vmid:      number
  node:      string
  name:      string
  addedBy:   string
  addedAt:   number
  autoConnected: { at: number; evidence: string[] } | null
}

export interface RecordStore {
  get(id: string): Promise<WebProxyInstance | null>
  put(i: WebProxyInstance): Promise<void>
  list(): Promise<WebProxyInstance[]>
  delete(id: string): Promise<void>
}

export interface Sighting { kind: WebProxyKind; vmid: number; via: 'catalogue' | 'detect' | 'marker' }

export interface WebProxyDeps {
  store: RecordStore
  exec:  { listMachines(): Promise<Machine[]>; run(m: Machine, script: string, o?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult> }
  /** Where each kind was seen without looking inside a guest. */
  sightings(): Promise<Sighting[]>
  /** Remote access's "never look inside" list; throws when it cannot be read. */
  excluded(): Promise<string[]>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  /** Auto-connect's memory of a person's disconnect, so it is not added back by itself. */
  dismissed?(kind: WebProxyKind, machineId: string, label: string, by: string): Promise<void>
  now(): number
}

/** A button: what it does, in words, and what the person confirms. */
export interface Action { id: string; label: string; confirm: string; danger?: boolean }
export interface Problem { id: string; severity: 'error' | 'warning'; title: string; detail: string; fix?: Action }

export type Detail = NginxReading | CaddyReading | EnvoyReading
export interface Reading {
  id: string; kind: WebProxyKind; name: string; vmid: number; node: string; at: number
  ok: boolean
  error?: string
  detail: Detail | null
  problems: Problem[]
  /** Everything the person may do now (the problems' fixes among them). */
  actions: Action[]
}

const READ_TTL_MS = 15_000

// ── the actions ─────────────────────────────────────────────────────────────

const A = {
  nginxReload: { id: 'reload', label: 'Reload NGINX', confirm: 'NGINX checks its configuration with nginx -t first; if it is refused, nothing is reloaded. Open connections finish on the old workers.' },
  nginxTest:   { id: 'test', label: 'Test the configuration', confirm: 'Runs nginx -t and shows what it says. Nothing changes.' },
  nginxStart:  { id: 'start', label: 'Start NGINX', confirm: 'Checks the configuration with nginx -t, then starts NGINX.' },
  nginxStatus: { id: 'status-page', label: 'Turn on the status page', confirm: 'Adds /etc/nginx/conf.d/hyperprox-status.conf: a status page on 127.0.0.1:8081 inside the container only. Checked with nginx -t; if refused, the file is removed again.' },
  nginxRenew:  { id: 'renew', label: 'Renew certificates', confirm: 'Runs certbot renew (it renews only certificates near their end), then reloads NGINX.' },
  caddyReload: { id: 'reload', label: 'Reload Caddy', confirm: 'Caddy reloads its current configuration through its admin API. Connections are kept.' },
  caddyRetry:  { id: 'retry-certs', label: 'Retry certificates', confirm: 'Caddy reloads its configuration, which starts certificate management again: names without a certificate are tried now, not after Caddy’s back-off. Ports 80 and 443 must reach this container.' },
  caddyStart:  { id: 'start', label: 'Start Caddy', confirm: 'Starts Caddy’s service in the container.' },
  envoyReload: { id: 'reload', label: 'Reload configuration', confirm: 'Envoy picks its listener and cluster files up again. A file Envoy refuses is not used; it keeps the configuration it has.' },
  envoyRestart: { id: 'restart', label: 'Restart Envoy', danger: true, confirm: 'Envoy’s configuration is in its startup file, so it is checked first and then Envoy restarts: open connections are dropped.' },
  envoyDrain:  { id: 'drain', label: 'Drain (fail health checks)', danger: true, confirm: 'Envoy answers its health check as failed, so a load balancer in front stops sending it new traffic. It keeps serving what still arrives. Undo with Undrain.' },
  envoyUndrain: { id: 'undrain', label: 'Undrain', confirm: 'Envoy answers its health check as healthy again, so it is sent traffic again.' },
  envoyStart:  { id: 'start', label: 'Start Envoy', confirm: 'Starts Envoy’s service in the container.' },
} satisfies Record<string, Action>

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What a reading says is wrong, each with its fix when there is one, and every action open now. */
export function assess(d: Detail | null): { problems: Problem[]; actions: Action[] } {
  const problems: Problem[] = [], actions: Action[] = []
  if (!d) return { problems, actions }
  const certProblems = (certs: Cert[], fix?: Action) => {
    for (const c of certs) {
      const when = c.daysLeft === null ? '' : c.daysLeft < 1 ? 'within a day' : `in ${plural(c.daysLeft, 'day')}`
      if (c.expired) problems.push({ id: `cert:${c.name}`, severity: 'error', title: `The certificate for ${c.name} has expired`, detail: 'Browsers refuse the site until it is renewed.', ...(fix ? { fix } : {}) })
      else if (c.ending) problems.push({ id: `cert:${c.name}`, severity: 'warning', title: `The certificate for ${c.name} ends ${when}`, detail: fix ? 'It should have been renewed by now. Renew it before it ends.' : 'It was not issued by anything HyperProx can renew here; replace the file and reload.', ...(fix ? { fix } : {}) })
    }
  }
  if (d.kind === 'nginx') {
    if (d.running === false) {
      problems.push({ id: 'stopped', severity: 'error', title: 'NGINX is not running', detail: 'Nothing is served from this container.', fix: A.nginxStart })
      actions.push(A.nginxStart)
    }
    if (!d.configOk) problems.push({ id: 'config', severity: 'error', title: 'nginx -t refuses the configuration', detail: `${d.configMessage || 'nginx -t failed.'} NGINX keeps running the configuration it loaded, but will not reload or restart until this is fixed.`, fix: A.nginxTest })
    if (!d.status) {
      problems.push({ id: 'status-page', severity: 'warning', title: 'No status page', detail: 'Connections and requests cannot be shown without NGINX’s status page on the container’s loopback.', fix: A.nginxStatus })
      actions.push(A.nginxStatus)
    }
    const renew = d.certbot ? A.nginxRenew : undefined
    certProblems(d.certs, renew)
    if (renew) actions.push(renew)
    if (d.running !== false) actions.push(A.nginxReload)
    actions.push(A.nginxTest)
  }
  if (d.kind === 'caddy') {
    if (d.running === false) {
      problems.push({ id: 'stopped', severity: 'error', title: 'Caddy is not running', detail: 'Nothing is served from this container.', fix: A.caddyStart })
      actions.push(A.caddyStart)
    } else if (!d.adminOk) {
      problems.push({ id: 'admin', severity: 'error', title: 'Caddy’s admin API does not answer', detail: 'HyperProx reads and changes Caddy through its admin API on 127.0.0.1:2019 inside the container. Starting the service again usually brings it back.', fix: A.caddyStart })
      actions.push(A.caddyStart)
    }
    if (d.adminOk) {
      for (const h of d.missingCerts) problems.push({ id: `nocert:${h}`, severity: 'warning', title: `No certificate yet for ${h}`, detail: 'Caddy has not got one. Ports 80 and 443 from the internet must reach this container, and the name must point at your address.', fix: A.caddyRetry })
      certProblems(d.certs, A.caddyRetry)
      if (!d.persist) problems.push({ id: 'persist', severity: 'warning', title: 'Changes are not saved', detail: 'admin.config.persist is off: a restart loses every route HyperProx or anyone added through the API.' })
      actions.push(A.caddyReload, A.caddyRetry)
    }
  }
  if (d.kind === 'envoy') {
    if (d.running === false) {
      problems.push({ id: 'stopped', severity: 'error', title: 'Envoy is not running', detail: 'Nothing is served from this container.', fix: A.envoyStart })
      actions.push(A.envoyStart)
    } else if (!d.adminOk) {
      problems.push({ id: 'admin', severity: 'error', title: 'Envoy’s admin does not answer', detail: 'HyperProx reads Envoy through its admin on the container’s loopback. Starting the service again usually brings it back.', ...(d.unit ? { fix: A.envoyStart } : {}) })
      if (d.unit) actions.push(A.envoyStart)
    }
    if (d.adminOk) {
      if (d.draining) problems.push({ id: 'draining', severity: 'warning', title: 'Envoy is drained', detail: 'Its health check answers failed, so a load balancer in front sends it no new traffic.', fix: A.envoyUndrain })
      actions.push(d.draining ? A.envoyUndrain : A.envoyDrain)
      if (d.dynamicFiles.length) actions.push(A.envoyReload)
      else if (d.unit) actions.push(A.envoyRestart)
    }
  }
  return { problems, actions: actions.filter((a, i) => actions.findIndex(b => b.id === a.id) === i) }
}

// ── the scripts behind each action (fixed text; the only value in them is checked first) ─────────────────────

function actionScript(kind: WebProxyKind, action: string, d: Detail | null): string {
  if (kind === 'nginx') switch (action) {
    case 'test': return 'out=$(nginx -t 2>&1); rc=$?; printf "%s\\n" "$out" | tail -n 3; echo "HPX_RC=$rc"\n'
    case 'reload': return 'if ! out=$(nginx -t 2>&1); then echo HPX_REFUSED; printf "%s\\n" "$out" | tail -n 3; exit 0; fi\nif systemctl is-active --quiet nginx; then systemctl reload nginx; else nginx -s reload; fi && echo HPX_DONE\n'
    case 'start': return 'if ! out=$(nginx -t 2>&1); then echo HPX_REFUSED; printf "%s\\n" "$out" | tail -n 3; exit 0; fi\nsystemctl start nginx && systemctl is-active --quiet nginx && echo HPX_DONE\n'
    case 'status-page': return [
      'f=/etc/nginx/conf.d/hyperprox-status.conf', '[ -e "$f" ] && { echo HPX_EXISTS; exit 0; }',
      "cat > \"$f\" <<'NGINX'", 'server {', '  listen 127.0.0.1:8081;', '  server_name localhost;', '  access_log off;',
      '  location = /nginx_status { stub_status; allow 127.0.0.1; deny all; }', '  location / { return 404; }', '}', 'NGINX',
      'if ! out=$(nginx -t 2>&1); then rm -f "$f"; echo HPX_REFUSED; printf "%s\\n" "$out" | tail -n 3; exit 0; fi',
      'if systemctl is-active --quiet nginx; then systemctl reload nginx; else nginx -s reload; fi && echo HPX_DONE',
    ].join('\n') + '\n'
    case 'renew': return 'certbot renew --no-random-sleep-on-renew 2>&1 | tail -n 6; rc=${PIPESTATUS[0]}\nif nginx -t >/dev/null 2>&1; then systemctl reload nginx 2>/dev/null || nginx -s reload; fi\n[ "$rc" = 0 ] && echo HPX_DONE || echo "HPX_RC=$rc"\n'
  }
  if (kind === 'caddy') switch (action) {
    case 'reload': case 'retry-certs': return [
      'cfg=$(curl -fsS --max-time 10 http://127.0.0.1:2019/config/) || { echo HPX_NOADMIN; exit 0; }',
      // must-revalidate: Caddy reloads even an unchanged configuration (and so starts certificate management again).
      'out=$(printf %s "$cfg" | curl -sS --max-time 60 -X POST -H "Content-Type: application/json" -H "Cache-Control: must-revalidate" --data-binary @- -w "\\nHPX_HTTP=%{http_code}" http://127.0.0.1:2019/load)',
      'printf "%s\\n" "$out" | tail -n 4', 'printf "%s" "$out" | grep -q "HPX_HTTP=200" && echo HPX_DONE',
    ].join('\n') + '\n'
    case 'start': {
      const unit = d?.kind === 'caddy' && d.unit === 'caddy' ? 'caddy' : 'caddy-api'
      return `systemctl start ${unit} && for i in $(seq 1 15); do curl -fsS -o /dev/null http://127.0.0.1:2019/config/ && { echo HPX_DONE; exit 0; }; sleep 1; done; echo HPX_NOADMIN\n`
    }
  }
  if (kind === 'envoy') {
    const admin = d?.kind === 'envoy' && /^(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(d.admin) ? d.admin : '127.0.0.1:9901'
    switch (action) {
      case 'drain': return `curl -fsS --max-time 10 -X POST ${shq(`http://${admin}/healthcheck/fail`)} >/dev/null && echo HPX_DONE\n`
      case 'undrain': return `curl -fsS --max-time 10 -X POST ${shq(`http://${admin}/healthcheck/ok`)} >/dev/null && echo HPX_DONE\n`
      case 'reload': return [
        `rej() { curl -fsS --max-time 5 -G --data-urlencode 'filter=(lds|cds)\\.update_(rejected|failure)$' ${shq(`http://${admin}/stats`)} | awk -F': ' '{s+=$2} END {print s+0}'; }`,
        'before=$(rej)', 'n=0',
        'for f in /etc/envoy/dynamic/*.yaml; do [ -e "$f" ] || continue; cp -p "$f" "$f.hpx-reload" && mv -f "$f.hpx-reload" "$f" && n=$((n+1)); done',
        '[ "$n" -gt 0 ] || { echo HPX_NOFILES; exit 0; }', 'sleep 3', 'after=$(rej)',
        '[ "$after" -gt "$before" ] && { echo HPX_REJECTED; exit 0; }', 'echo "HPX_DONE $n"',
      ].join('\n') + '\n'
      case 'restart': return [
        "cmd=$(systemctl show -p ExecStart --value envoy | grep -o 'path=[^ ;]*' | head -n1 | cut -d= -f2)",
        "args=$(systemctl show -p ExecStart --value envoy | sed -n 's/.*argv\\[\\]=\\([^;]*\\);.*/\\1/p' | head -n1)",
        'cfg=$(printf "%s" "$args" | grep -oE "(-c|--config-path)[ =][^ ]+" | head -n1 | sed -E "s/^(-c|--config-path)[ =]//")',
        '[ -n "$cmd" ] && [ -n "$cfg" ] || { echo HPX_NOCONFIG; exit 0; }',
        'if ! out=$("$cmd" --mode validate -c "$cfg" --log-level error 2>&1); then echo HPX_REFUSED; printf "%s\\n" "$out" | tail -n 3; exit 0; fi',
        'systemctl restart envoy && sleep 2 && systemctl is-active --quiet envoy && echo HPX_DONE',
      ].join('\n') + '\n'
      case 'start': return 'systemctl start envoy && sleep 2 && systemctl is-active --quiet envoy && echo HPX_DONE\n'
    }
  }
  throw new WebProxyRefusal('no_action', 'That is not something HyperProx can do here.', 400)
}

/** The person's answer, in words, from what the action printed. */
export function actionResult(kind: WebProxyKind, action: string, out: string): { ok: boolean; message: string } {
  const name = KIND_NAME[kind]
  const tail = (s: string) => {
    const lines = s.split('\n').map(l => l.trim()).filter(l => l && !/^HPX_/.test(l))
    // nginx's [emerg] line names the problem and the file; the lines after it only say that the test failed.
    const emerg = lines.find(l => /\[emerg\]/.test(l))
    return (emerg ?? lines.slice(-3).join(' ')).replace(/^nginx: /, '')
  }
  if (/HPX_REFUSED/.test(out)) return { ok: false, message: `${name} refused its configuration, so nothing was changed: ${tail(out.split('HPX_REFUSED')[1] ?? '')}` }
  if (/HPX_NOADMIN/.test(out)) return { ok: false, message: `${name}’s admin API did not answer, so nothing was changed.` }
  if (/HPX_EXISTS/.test(out)) return { ok: true, message: 'The status page file is already there.' }
  if (/HPX_NOFILES/.test(out)) return { ok: false, message: 'Envoy has no listener or cluster files to reload.' }
  if (/HPX_NOCONFIG/.test(out)) return { ok: false, message: 'Envoy’s startup file could not be found in its service, so it was not restarted.' }
  if (/HPX_REJECTED/.test(out)) return { ok: false, message: 'Envoy refused the files and keeps the configuration it had. Its log says why.' }
  if (action === 'test') {
    const ok = /HPX_RC=0/.test(out)
    return { ok, message: ok ? 'nginx -t accepts the configuration.' : `nginx -t refuses the configuration: ${tail(out)}` }
  }
  if (/HPX_DONE/.test(out)) {
    const said: Record<string, string> = {
      reload: kind === 'envoy' ? 'Envoy picked its files up again.' : `${name} reloaded.`,
      start: `${name} is running.`, restart: 'Envoy restarted.', drain: 'Envoy now fails its health check: it is drained.',
      undrain: 'Envoy answers its health check as healthy again.', 'status-page': 'The status page is on.',
      'retry-certs': 'Caddy reloaded and is trying for the missing certificates now. Give it a minute, then refresh.',
      renew: 'certbot renewed what was near its end, and NGINX reloaded.',
    }
    return { ok: true, message: said[action] ?? 'Done.' }
  }
  return { ok: false, message: `${name} did not confirm it worked: ${tail(out) || 'no answer'}` }
}

// ── the service ────────────────────────────────────────────────────────────

export class WebProxyService {
  private cache = new Map<string, { at: number; r: Reading }>()
  private busy = new Set<string>()
  /** Guests whose look found no proxy of that kind: not looked in again for an hour. */
  private missing = new Map<string, number>()

  constructor(private d: WebProxyDeps) {}

  private async excludedIds(): Promise<Set<string>> {
    try { return new Set(await this.d.excluded()) }
    catch { throw new WebProxyRefusal('exclusions_unknown', 'Remote access\'s exclusion list could not be read, so HyperProx contacts no guest until it can.', 503) }
  }

  async instances(kind?: WebProxyKind): Promise<WebProxyInstance[]> {
    return (await this.d.store.list()).filter(i => !kind || i.kind === kind).sort((a, b) => a.vmid - b.vmid)
  }

  async instance(id: string): Promise<WebProxyInstance> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new WebProxyRefusal('no_instance', 'No such proxy.', 404)
    const i = await this.d.store.get(id)
    if (!i) throw new WebProxyRefusal('no_instance', 'No such proxy.', 404)
    return i
  }

  /** The guest, when it may be contacted: there, running, not tagged, not on the exclusion list (read every time). */
  private async machine(machineId: string, label: string): Promise<Machine> {
    const [machines, excluded] = await Promise.all([this.d.exec.listMachines(), this.excludedIds()])
    const m = machines.find(x => x.id === machineId)
    if (!m) throw new WebProxyRefusal('gone', `${label} is not on the cluster any more.`, 409)
    const why = exclusionReason(m, { excludedMachines: excluded })
    if (why === 'tag') throw new WebProxyRefusal('excluded', `${m.name} carries the ${IGNORE_TAG} tag, so HyperProx does not look inside it.`, 409)
    if (why) throw new WebProxyRefusal('excluded', `${m.name} is on Remote access's "never look inside" list, so HyperProx does not contact it.`, 409)
    if (!m.running) throw new WebProxyRefusal('stopped', `${m.name} is not running.`, 409)
    return m
  }

  private async look(kind: WebProxyKind, m: Machine): Promise<Detail | null> {
    const r = await this.d.exec.run(m, PROBES[kind], { timeoutMs: 45_000, maxOutputBytes: 8 * 1024 * 1024 })
    if (r.timedOut) throw new WebProxyRefusal('timeout', `${m.name} did not answer in time.`, 504)
    if (r.code !== 0) throw new WebProxyRefusal('exec_failed', `Could not look inside ${m.name} (exit ${r.code}).`, 502)
    const now = this.d.now()
    return kind === 'nginx' ? parseNginx(r.output, now) : kind === 'caddy' ? parseCaddy(r.output, now) : parseEnvoy(r.output)
  }

  /** Where each kind was seen, matched to a guest that may be contacted, with what is connected already. */
  async detected(kind: WebProxyKind): Promise<Array<{ machineId: string; vmid: number; node: string; name: string; running: boolean; via: string[]; connected: string | null }>> {
    const [machines, sightings, instances, excluded] = await Promise.all([
      this.d.exec.listMachines().catch(() => [] as Machine[]), this.d.sightings().catch(() => [] as Sighting[]), this.d.store.list(), this.excludedIds(),
    ])
    const out = new Map<number, { machineId: string; vmid: number; node: string; name: string; running: boolean; via: string[]; connected: string | null }>()
    for (const s of sightings.filter(x => x.kind === kind)) {
      const m = machines.find(x => (x.kind === 'lxc' || x.kind === 'qemu') && x.vmid === s.vmid)
      if (!m || exclusionReason(m, { excludedMachines: excluded })) continue
      const d = out.get(s.vmid) ?? { machineId: m.id, vmid: s.vmid, node: m.node!, name: m.name, running: m.running, via: [], connected: null }
      if (!d.via.includes(s.via)) d.via.push(s.via)
      out.set(s.vmid, d)
    }
    for (const i of instances.filter(x => x.kind === kind)) { const d = out.get(i.vmid); if (d) d.connected = i.id }
    return [...out.values()].sort((a, b) => a.vmid - b.vmid)
  }

  /** Connect one: a look inside first proves the proxy is there. One at a time per guest and kind. */
  async connect(kind: WebProxyKind, machineId: string, actor: Actor, auto?: { evidence: string[] }): Promise<WebProxyInstance> {
    if (!/^(lxc|qemu)-\d{1,9}$/.test(machineId)) throw new WebProxyRefusal('bad_input', 'Pick a guest from the list.')
    return this.locked(`connect:${kind}:${machineId}`, async () => {
      const existing = (await this.d.store.list()).find(i => i.kind === kind && i.machineId === machineId)
      if (existing) return existing
      const m = await this.machine(machineId, machineId)
      if (auto) await this.d.audit(`webproxy.${kind}.auto_connect`, `webproxy:${kind}:${machineId}`, { by: SYSTEM_ACTOR, evidence: auto.evidence })
      else await this.d.audit(`webproxy.${kind}.connect`, `webproxy:${kind}:${machineId}`, { ...auditBy(actorLabel(actor)) })
      if (!await this.look(kind, m)) throw new WebProxyRefusal('not_found', `${KIND_NAME[kind]} is not installed in ${m.name}.`, 404)
      const i: WebProxyInstance = {
        id: randomUUID(), kind, machineId, vmid: m.vmid!, node: m.node!, name: m.name,
        addedBy: auto ? SYSTEM_ACTOR : actorLabel(actor), addedAt: this.d.now(),
        autoConnected: auto ? { at: this.d.now(), evidence: auto.evidence.slice(0, 10) } : null,
      }
      await this.d.store.put(i)
      return i
    })
  }

  async disconnect(id: string, actor: Actor): Promise<void> {
    const i = await this.instance(id)
    await this.d.audit(`webproxy.${i.kind}.disconnect`, `webproxy:${i.kind}:${i.machineId}`, { ...auditBy(actorLabel(actor)) })
    await this.d.store.delete(id)
    this.cache.delete(id)
    await this.d.dismissed?.(i.kind, i.machineId, i.name, actorLabel(actor))
  }

  /** One proxy, read now (or within the last 15 s, unless `fresh`). Never throws for an unreachable proxy: the reading says so. */
  async reading(id: string, fresh = false): Promise<Reading> {
    const i = await this.instance(id)
    const hit = this.cache.get(id)
    if (!fresh && hit && this.d.now() - hit.at < READ_TTL_MS) return hit.r
    const base = { id: i.id, kind: i.kind, name: i.name, vmid: i.vmid, node: i.node, at: this.d.now() }
    let r: Reading
    try {
      const m = await this.machine(i.machineId, i.name)
      const detail = await this.look(i.kind, m)
      if (!detail) r = { ...base, ok: false, error: `${KIND_NAME[i.kind]} is not installed in ${m.name} any more.`, detail: null, problems: [], actions: [] }
      else {
        const { problems, actions } = assess(detail)
        r = { ...base, ok: !problems.some(p => p.severity === 'error'), detail, problems, actions }
      }
    } catch (e: any) {
      if (e?.name === 'VaultLockedError') throw e
      r = { ...base, ok: false, error: String(e?.message ?? e).slice(0, 300), detail: null, problems: [], actions: [] }
    }
    this.cache.set(id, { at: this.d.now(), r })
    return r
  }

  async readings(kind: WebProxyKind): Promise<Reading[]> {
    return Promise.all((await this.instances(kind)).map(i => this.reading(i.id)))
  }

  /**
   * Run one action, by its id, when a reading taken NOW offers it: never one a stale page still shows. Confirmed
   * (the person saw the action's own words), audited before and after, one at a time per proxy.
   */
  async act(id: string, actionId: unknown, confirmed: unknown, actor: Actor): Promise<{ ok: boolean; message: string; reading: Reading }> {
    if (typeof actionId !== 'string' || !/^[a-z-]{1,24}$/.test(actionId)) throw new WebProxyRefusal('bad_input', 'Pick an action from the page.')
    if (confirmed !== true) throw new WebProxyRefusal('not_confirmed', 'Confirm the action first; nothing was done.', 409)
    const i = await this.instance(id)
    return this.locked(`act:${id}`, async () => {
      const now = await this.reading(id, true)
      const action = now.actions.find(a => a.id === actionId) ?? now.problems.find(p => p.fix?.id === actionId)?.fix
      if (!action) throw new WebProxyRefusal('not_offered', `“${actionId}” is not something ${i.name} needs or allows right now. Refresh the page.`, 409)
      const m = await this.machine(i.machineId, i.name)
      const resource = `webproxy:${i.kind}:${i.machineId}`
      await this.d.audit(`webproxy.${i.kind}.${action.id}`, resource, { ...auditBy(actorLabel(actor)), phase: 'start' })
      const r = await this.d.exec.run(m, actionScript(i.kind, action.id, now.detail), { timeoutMs: action.id === 'renew' ? 5 * 60_000 : 90_000, maxOutputBytes: 256 * 1024 })
      const res = r.timedOut ? { ok: false, message: `${m.name} did not finish in time; refresh to see where it got to.` } : actionResult(i.kind, action.id, r.output)
      await this.d.audit(`webproxy.${i.kind}.${action.id}`, resource, { ...auditBy(actorLabel(actor)), phase: 'done', ok: res.ok, message: res.message.slice(0, 300) })
      this.cache.delete(id)
      return { ...res, reading: await this.reading(id, true) }
    })
  }

  // ── auto-connect (lib/auto-connect) ───────────────────────────────────────

  /** One pass for one kind: everything found and not connected is connected, the same look a person's Connect does. */
  async autoConnect(kind: WebProxyKind, ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    const machines = await this.d.exec.listMachines()
    for (const d of await this.detected(kind)) {
      const label = d.name
      if (d.connected) { out.push({ key: d.machineId, label, did: 'present' }); continue }
      const m = machines.find(x => x.id === d.machineId)
      const why = exclusionOf(ctx, { machineId: d.machineId, tags: m?.tags, addresses: [m?.address] })
      if (why) { out.push({ key: d.machineId, label, did: 'excluded', message: why }); continue }
      if (ctx.dismissed(d.machineId)) { out.push({ key: d.machineId, label, did: 'dismissed' }); continue }
      if (!d.running) { out.push({ key: d.machineId, label, did: 'skipped', message: 'not running' }); continue }
      const miss = this.missing.get(`${kind}:${d.machineId}`)
      if (miss && this.d.now() - miss < 60 * 60_000) { out.push({ key: d.machineId, label, did: 'skipped', message: `no ${KIND_NAME[kind]} found inside` }); continue }
      const evidence = d.via.map(v => `found by ${v}`)
      try {
        // Read the dismissal again right before connecting: a person may have disconnected it meanwhile.
        if (ctx.dismissed(d.machineId)) { out.push({ key: d.machineId, label, did: 'dismissed' }); continue }
        await this.connect(kind, d.machineId, { email: SYSTEM_ACTOR, token: null }, { evidence })
        out.push({ key: d.machineId, label, did: 'connected', evidence })
      } catch (e: any) {
        if (e instanceof WebProxyRefusal && e.code === 'not_found') { this.missing.set(`${kind}:${d.machineId}`, this.d.now()); out.push({ key: d.machineId, label, did: 'skipped', message: e.message }); continue }
        out.push({ key: d.machineId, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) })
      }
    }
    return out
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new WebProxyRefusal('busy', 'Something is already being done to this proxy; try again in a moment.', 409)
    this.busy.add(key)
    try { return await fn() } finally { this.busy.delete(key) }
  }
}

/** For the gallery card: one line per proxy. */
export function tileRow(r: Reading): { label: string; value: string; tone: 'good' | 'warn' | 'bad' } {
  if (!r.detail) return { label: r.name, value: r.error ?? 'not reachable', tone: 'bad' }
  const err = r.problems.filter(p => p.severity === 'error'), warn = r.problems.filter(p => p.severity === 'warning')
  const d = r.detail
  const what = d.kind === 'nginx' ? `${plural(d.sites.filter(s => s.names.length).length, 'site')}${d.status ? `, ${plural(d.status.active, 'connection')}` : ''}`
    : d.kind === 'caddy' ? `${plural(d.routes.filter(x => x.hosts.length).length, 'route')}, ${plural(d.certs.length, 'certificate')}`
      : `${plural(d.clusters.length, 'cluster')}, ${plural(d.listeners.length, 'listener')}`
  if (err.length) return { label: r.name, value: err[0].title, tone: 'bad' }
  if (warn.length) return { label: r.name, value: warn.length === 1 ? warn[0].title : `${plural(warn.length, 'warning')}`, tone: 'warn' }
  return { label: r.name, value: `${d.version ? `${d.version} · ` : ''}${what}`, tone: 'good' }
}
