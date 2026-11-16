// =============================================================================
//  HyperProx — K3s: the service behind the K3s page
//
//  Reads go through each cluster's read-only account (hyperprox-reader). The
//  actions a person confirms (restart, roll back, scale, delete a pod, cordon,
//  uncordon, drain) go through the separate action account
//  (hyperprox-operator), and through nothing else. Every action is admin only,
//  never an API token, checked against a fresh read of its target, and audited
//  before it is sent.
//
//  Connecting a cluster: the admin kubeconfig (read from the K3s server's own
//  guest, from the Catalogue install, or pasted by a person) is used once to
//  make those two accounts; it is then kept in the vault, for the person and
//  for removing the accounts again, and is never used for a read or an action.
// =============================================================================

import { hasRole, type Role } from '../roles'
import { auditBy } from '../http/request-actor'
import type { AdapterContext, Outcome } from '../auto-connect/core'
import { EXCLUSION_WORDS, IGNORE_TAG } from '../guest-guard'
import { exclusionOf } from '../auto-connect/core'
import { K3sTransport, K3sHttpError, K3sUnreachableError, type K3sTransportOptions, type Call } from './transport'
import { parseKubeconfig, rewriteServer, caFingerprint, KubeconfigError, type AdminLogin } from './kubeconfig'
import { ensureAccounts, removeAccounts, parseLoginOutput, NS } from './accounts'
import { K3sInstanceStore, K3sInputError, cleanName, type K3sMeta, type GuestRef } from './instances'
import { readingOf, NAME_RE, NAMESPACE_RE, CONTAINER_RE, type Reading, type RawLists, type FixAction } from './parse'

export interface Actor { email: string; role: Role; token?: string | null }

export class K3sRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly extra: Record<string, unknown> = {}) { super(message); this.name = 'K3sRefusal' }
}

export interface GuestRow { kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean; ignored: boolean; excludedBy: string | null }
export interface Sighting { guest: GuestRef; url: string | null; ip: string | null; via: string }

export interface K3sDeps {
  store: K3sInstanceStore
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  /** A transport to one cluster (tests stand in for the API). */
  transport?(o: K3sTransportOptions): Pick<K3sTransport, 'call'>
  /** The newest stable K3s release, or null when it cannot be read. */
  latestStable?(): Promise<string | null>
  /** The guests, each marked when HyperProx must leave it alone. */
  guests?(): Promise<GuestRow[]>
  /** Where a K3s API was seen (the shared scan, the Catalogue's installs). */
  sightings?(): Promise<Sighting[]>
  /** Run READ_LOGIN_SCRIPT in a guest, through the guarded executor. Its output is a secret. */
  readLogin?(g: GuestRef): Promise<string>
  /** Auto-connect's dismissal record (lib/auto-connect rememberDismissed). */
  dismissed?(key: string, label: string, by: string): Promise<void>
  wait?(ms: number): Promise<unknown>
  now?(): number
}

export interface ClusterView extends K3sMeta { url?: string; hasJoinToken?: boolean }
export interface TileRow { id: string; name: string; reading: Reading | null; error: string | null }

const READ_TTL_MS = 15_000
const LATEST_TTL_MS = 6 * 3600_000
const machineKey = (g: GuestRef) => `${g.kind}-${g.vmid}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Words for an API failure, with nothing token-shaped in them. */
export function plainK3s(e: any, what: string): string {
  if (e instanceof K3sUnreachableError || e instanceof K3sRefusal || e instanceof K3sInputError || e instanceof KubeconfigError) return e.message
  if (e instanceof K3sHttpError) {
    if (e.status === 401) return `${what}: the cluster no longer accepts HyperProx's token (was the cluster rebuilt, or the account deleted?). Remove it and connect it again.`
    if (e.status === 403) return `${what}: HyperProx's account is not allowed to do that${e.detail ? ` (${e.detail})` : ''}.`
    if (e.status === 404) return `${what}: it is not there any more.`
    if (e.status === 409) return `${what}: it changed while this ran. Try again.`
    if (e.status === 429) return `${what}: refused by a disruption budget${e.detail ? ` (${e.detail})` : ''}.`
    return `${what}: the cluster answered ${e.status}${e.detail ? ` (${e.detail})` : ''}.`
  }
  return `${what}: ${String(e?.message ?? e).slice(0, 200)}`
}

export class K3sService {
  private cache = new Map<string, { at: number; reading: Reading }>()
  private latest: { at: number; v: string | null } | null = null
  private busy = new Set<string>()
  private now: () => number
  private wait: (ms: number) => Promise<unknown>
  constructor(readonly d: K3sDeps) { this.now = d.now ?? Date.now; this.wait = d.wait ?? sleep }

  get instances() { return this.d.store }

  private transport(o: K3sTransportOptions) { return this.d.transport ? this.d.transport(o) : new K3sTransport(o) }

  private async reader(id: string) {
    const s = await this.d.store.secrets(id)
    if (!s) throw new K3sRefusal('no_credential', 'This cluster\'s read-only token is not in the vault. Remove it and connect it again.')
    return { url: s.url, t: this.transport({ url: s.url, ca: s.ca, token: s.readerToken }) }
  }

  private async operator(id: string) {
    const s = await this.d.store.secrets(id)
    const a = await this.d.store.adminSecrets(id)
    if (!s || !a) throw new K3sRefusal('no_credential', 'This cluster\'s action token is not in the vault. Remove it and connect it again.')
    return this.transport({ url: s.url, ca: s.ca, token: a.operatorToken })
  }

  private mustAdmin(actor: Actor) {
    if (actor.token) throw new K3sRefusal('token_forbidden', 'API tokens cannot change a K3s cluster; sign in as an admin.', 403)
    if (!hasRole(actor.role, 'admin')) throw new K3sRefusal('forbidden', 'Only an admin can change a K3s cluster.', 403)
  }

  async views(): Promise<ClusterView[]> {
    const list = await this.d.store.list()
    return Promise.all(list.map(async m => {
      const s = await this.d.store.secrets(m.id).catch(() => null)
      const a = await this.d.store.adminSecrets(m.id).catch(() => null)
      return { ...m, url: s?.url, hasJoinToken: !!a?.nodeToken }
    }))
  }

  private async meta(id: string): Promise<K3sMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new K3sRefusal('no_instance', 'No such K3s cluster.', 404)
    return m
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async latestStable(): Promise<string | null> {
    if (this.latest && this.now() - this.latest.at < LATEST_TTL_MS) return this.latest.v
    const v = await (this.d.latestStable?.() ?? Promise.resolve(null)).catch(() => null)
    this.latest = { at: this.now(), v }
    return v
  }

  async reading(id: string, o: { fresh?: boolean } = {}): Promise<Reading> {
    await this.meta(id)
    const c = this.cache.get(id)
    if (c && !o.fresh && this.now() - c.at < READ_TTL_MS) return c.reading
    const { t } = await this.reader(id)
    const missing: string[] = []
    const get = (path: string, name: string, optional = false, query?: Call['query']) => t.call({ path, query }).catch((e: any) => {
      if (!optional) throw e
      missing.push(name)
      return null
    })
    const [version, nodes, nodeMetrics, namespaces, pods, replicaSets, deployments, statefulSets, daemonSets, events, services, ingresses] = await Promise.all([
      get('/version', 'version'),
      get('/api/v1/nodes', 'nodes'),
      get('/apis/metrics.k8s.io/v1beta1/nodes', 'node metrics', true),
      get('/api/v1/namespaces', 'namespaces'),
      get('/api/v1/pods', 'pods', false, { limit: 2000 }),
      get('/apis/apps/v1/replicasets', 'replica sets', true, { limit: 2000 }),
      get('/apis/apps/v1/deployments', 'deployments'),
      get('/apis/apps/v1/statefulsets', 'stateful sets', true),
      get('/apis/apps/v1/daemonsets', 'daemon sets', true),
      get('/api/v1/events', 'events', true, { fieldSelector: 'type=Warning', limit: 500 }),
      get('/api/v1/services', 'services', true),
      get('/apis/networking.k8s.io/v1/ingresses', 'ingresses', true),
    ])
    const raw: RawLists = { version, nodes, nodeMetrics, namespaces, pods, replicaSets: replicaSets ?? { items: [] }, deployments, statefulSets, daemonSets, events, services, ingresses, latest: await this.latestStable(), missing }
    const r = readingOf(raw, this.now())
    // The last lines of the first few failing pods' logs (the previous run's for a crash loop).
    await Promise.all(r.problems.filter(p => p.container && p.state !== 'pending').slice(0, 6).map(async p => {
      p.lastLines = await this.tail(t, p.namespace, p.name, p.container!, p.state === 'crashloop' || p.state === 'oom' || p.state === 'restarting', 12).catch(() => undefined)
    }))
    this.cache.set(id, { at: this.now(), reading: r })
    return r
  }

  /**
   * The last lines of a container's log. A crash loop's last run is usually the current log (the container shows as
   * stopped, waiting to restart), so that is read first; the previous run's only when the current one has nothing.
   */
  private async tail(t: Pick<K3sTransport, 'call'>, ns: string, pod: string, container: string, previous: boolean, lines: number): Promise<string[]> {
    const read = (prev: boolean) => t.call<string>({ path: `/api/v1/namespaces/${ns}/pods/${pod}/log`, query: { container, tailLines: lines, limitBytes: 256 * 1024, previous: prev || undefined }, text: true, timeoutMs: 10_000 })
      .then(text => String(text).split('\n').filter(l => l.length && !/^unable to retrieve container logs for /.test(l)), (e: any) => {
        if (e instanceof K3sHttpError && e.status === 400) return [] as string[]
        throw e
      })
    let out = await read(false)
    if (!out.length && previous) out = await read(true)
    return out.slice(-lines).map(l => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 500))
  }

  async allTiles(): Promise<TileRow[]> {
    const list = await this.d.store.list()
    return Promise.all(list.map(async m => {
      try { return { id: m.id, name: m.name, reading: await this.reading(m.id), error: null } }
      catch (e: any) { return { id: m.id, name: m.name, reading: null, error: plainK3s(e, 'Could not be read') } }
    }))
  }

  /** Pod logs, through the read-only account. Admin only: logs can hold anything an app printed. */
  async logs(id: string, ns: string, pod: string, container: string | undefined, previous: boolean, actor: Actor): Promise<{ container: string; lines: string[] }> {
    this.mustAdmin(actor)
    if (!NAMESPACE_RE.test(ns) || !NAME_RE.test(pod)) throw new K3sInputError('That is not a pod.')
    if (container !== undefined && container !== '' && !CONTAINER_RE.test(container)) throw new K3sInputError('That is not a container name.')
    const { t } = await this.reader(id)
    const p = await t.call<any>({ path: `/api/v1/namespaces/${ns}/pods/${pod}` }).catch(e => { throw new K3sRefusal('not_found', plainK3s(e, `Pod ${pod}`), 404) })
    const names: string[] = (p?.spec?.containers ?? []).map((c: any) => String(c?.name ?? ''))
    const c = container || names[0]
    if (!c || !names.includes(c)) throw new K3sInputError(`${pod} has no container called ${container}.`)
    await this.d.audit('k3s.logs.read', `k3s:${id}`, { ...auditBy(actor), namespace: ns, pod, container: c, previous })
    return { container: c, lines: await this.tail(t, ns, pod, c, previous, 200) }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  /** Drain, first: which pods move, which stay (DaemonSets) and which would be gone for good (no controller). */
  async drainPreview(id: string, node: string, actor: Actor): Promise<{ node: string; move: string[]; stay: string[]; lost: string[]; localData: string[] }> {
    this.mustAdmin(actor)
    if (!NAME_RE.test(node)) throw new K3sInputError('That is not a node name.')
    const { t } = await this.reader(id)
    await t.call({ path: `/api/v1/nodes/${node}` }).catch(e => { throw new K3sRefusal('not_found', plainK3s(e, `Node ${node}`), 404) })
    const pods = (await t.call<any>({ path: '/api/v1/pods', query: { fieldSelector: `spec.nodeName=${node}` } }))?.items ?? []
    return { node, ...classifyDrain(pods) }
  }

  async act(id: string, action: FixAction, body: Record<string, unknown>, actor: Actor): Promise<{ done: string }> {
    this.mustAdmin(actor)
    const m = await this.meta(id)
    const target = cleanTarget(action, body)
    const key = `${id}:${target.kind}:${target.namespace ?? ''}/${target.name}`
    if (this.busy.has(key)) throw new K3sRefusal('busy', 'An action on this is still running.', 409)
    this.busy.add(key)
    try {
      // Checked against a fresh read: the button may be minutes old.
      const reading = await this.reading(id, { fresh: true })
      if (target.kind === 'Pod') {
        const { t } = await this.reader(id)
        await t.call({ path: `/api/v1/namespaces/${target.namespace}/pods/${target.name}` }).catch(e => {
          if (e instanceof K3sHttpError && e.status === 404) throw new K3sRefusal('not_found', `Pod ${target.namespace}/${target.name} is not in the cluster any more.`, 404)
          throw e
        })
      } else checkTargetExists(reading, action, target)
      const scale = action === 'scale' ? cleanReplicas(body.replicas) : undefined
      if (action === 'drain' && body.confirmLost !== true) {
        const pre = await this.drainPreview(id, target.name, actor)
        if (pre.lost.length) throw new K3sRefusal('would_lose_pods', `Draining ${target.name} would delete ${pre.lost.length} pod${pre.lost.length === 1 ? '' : 's'} that nothing makes again (${pre.lost.slice(0, 5).join(', ')}). Confirm that to go ahead.`, 409, { lost: pre.lost })
      }
      await this.d.audit(`k3s.action.${action}`, `k3s:${id}`, { ...auditBy(actor), cluster: m.name, kind: target.kind, namespace: target.namespace ?? null, name: target.name, ...(scale !== undefined ? { replicas: scale } : {}) })
      const op = await this.operator(id)
      const done = await this.run(op, action, target, scale)
      this.cache.delete(id)
      return { done }
    } catch (e: any) {
      if (e instanceof K3sRefusal || e instanceof K3sInputError) throw e
      throw new K3sRefusal('action_failed', plainK3s(e, `${actionWords(action)} ${target.name}`), 502)
    } finally { this.busy.delete(key) }
  }

  private async run(op: Pick<K3sTransport, 'call'>, action: FixAction, t: Target, replicas?: number): Promise<string> {
    const wpath = (k: Target['kind']) => `/apis/apps/v1/namespaces/${t.namespace}/${k === 'Deployment' ? 'deployments' : k === 'StatefulSet' ? 'statefulsets' : 'daemonsets'}/${t.name}`
    switch (action) {
      case 'restart':
        await op.call({ method: 'PATCH', path: wpath(t.kind), contentType: 'application/merge-patch+json',
          body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date(this.now()).toISOString() } } } } } })
        return `${t.name} is restarting: its pods are being replaced.`
      case 'scale':
        await op.call({ method: 'PATCH', path: `${wpath(t.kind)}/scale`, contentType: 'application/merge-patch+json', body: { spec: { replicas } } })
        return `${t.name} is scaled to ${replicas}.`
      case 'rollback': return this.rollback(op, t)
      case 'delete-pod':
        await op.call({ method: 'DELETE', path: `/api/v1/namespaces/${t.namespace}/pods/${t.name}` })
        return `${t.name} was deleted.`
      case 'cordon':
      case 'uncordon':
        await op.call({ method: 'PATCH', path: `/api/v1/nodes/${t.name}`, contentType: 'application/merge-patch+json', body: { spec: { unschedulable: action === 'cordon' ? true : null } } })
        return action === 'cordon' ? `${t.name} is cordoned: no new pods go there.` : `${t.name} takes new pods again.`
      case 'drain': return this.drain(op, t.name)
      default: throw new K3sInputError('That is not an action.')
    }
  }

  /** What `kubectl rollout undo` does: the deployment's template becomes its previous ReplicaSet's. */
  private async rollback(op: Pick<K3sTransport, 'call'>, t: Target): Promise<string> {
    const dep = await op.call<any>({ path: `/apis/apps/v1/namespaces/${t.namespace}/deployments/${t.name}` })
    const rev = Number(dep?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
    const rsl = await op.call<any>({ path: `/apis/apps/v1/namespaces/${t.namespace}/replicasets` })
    const mine = (rsl?.items ?? []).filter((r: any) => (r?.metadata?.ownerReferences ?? []).some((o: any) => o?.controller && o?.uid === dep?.metadata?.uid))
      .map((r: any) => ({ r, rev: Number(r?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0) }))
      .filter((x: any) => x.rev > 0 && x.rev < rev).sort((a: any, b: any) => b.rev - a.rev)
    const prev = mine[0]
    if (!prev) throw new K3sRefusal('no_previous', `${t.name} has no earlier version to go back to.`, 409)
    const template = structuredClone(prev.r.spec.template)
    if (template?.metadata?.labels) delete template.metadata.labels['pod-template-hash']
    await op.call({ method: 'PATCH', path: `/apis/apps/v1/namespaces/${t.namespace}/deployments/${t.name}`, contentType: 'application/json-patch+json',
      body: [{ op: 'test', path: '/metadata/uid', value: dep.metadata.uid }, { op: 'replace', path: '/spec/template', value: template }] })
    const img = (template?.spec?.containers ?? []).map((c: any) => c?.image).filter(Boolean).join(', ')
    return `${t.name} is going back to revision ${prev.rev}${img ? ` (${img})` : ''}.`
  }

  private async drain(op: Pick<K3sTransport, 'call'>, node: string): Promise<string> {
    await op.call({ method: 'PATCH', path: `/api/v1/nodes/${node}`, contentType: 'application/merge-patch+json', body: { spec: { unschedulable: true } } })
    const pods = (await op.call<any>({ path: '/api/v1/pods', query: { fieldSelector: `spec.nodeName=${node}` } }))?.items ?? []
    const plan = classifyDrain(pods)
    const evict = pods.filter((p: any) => { const n = `${p?.metadata?.namespace}/${p?.metadata?.name}`; return plan.move.includes(n) || plan.lost.includes(n) })
    const blocked: string[] = []
    for (const p of evict) {
      const ns = String(p.metadata.namespace), name = String(p.metadata.name)
      if (!NAMESPACE_RE.test(ns) || !NAME_RE.test(name)) continue
      try {
        await op.call({ method: 'POST', path: `/api/v1/namespaces/${ns}/pods/${name}/eviction`, body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace: ns } } })
      } catch (e: any) {
        if (e instanceof K3sHttpError && e.status === 404) continue
        blocked.push(`${ns}/${name}${e instanceof K3sHttpError && e.status === 429 ? ' (a disruption budget)' : ''}`)
      }
    }
    return `${node} is cordoned and ${evict.length - blocked.length} pod${evict.length - blocked.length === 1 ? '' : 's'} were asked to move${plan.stay.length ? `; ${plan.stay.length} DaemonSet pod${plan.stay.length === 1 ? '' : 's'} stay` : ''}${blocked.length ? `. Not moved yet: ${blocked.slice(0, 5).join(', ')}; drain again in a minute` : ''}.`
  }

  // ── connecting ───────────────────────────────────────────────────────────

  /**
   * Make HyperProx's accounts with an admin login and keep the cluster. The address is the server's LAN address
   * (`address`, else the kubeconfig's own when it is not the server's loopback).
   */
  async connect(o: { kubeconfig: string; address?: string | null; nodeToken?: string | null; name: string; guest: GuestRef | null; via: K3sMeta['via'] }, actor: Actor | string): Promise<K3sMeta> {
    const login: AdminLogin = parseKubeconfig(o.kubeconfig)
    const local = /^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(login.server)
    const url = o.address ? o.address.replace(/\/$/, '') : local ? null : login.server
    if (!url) throw new K3sInputError('This kubeconfig points at the server itself (127.0.0.1). Give the server\'s address on your network, such as https://10.0.0.40:6443.')
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^https:\/\/\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(url)) throw new K3sInputError('The server address is https://host:port, such as https://10.0.0.40:6443.')
    const fp = caFingerprint(login.ca)
    const dup = (await this.d.store.list()).find(m => m.caFingerprint === fp)
    if (dup) throw new K3sRefusal('present', `This cluster is already connected as ${dup.name}.`, 409, { id: dup.id })
    const admin = this.transport({ url, ca: login.ca, cert: login.cert, key: login.key, token: login.token })
    const ver = await admin.call<any>({ path: '/version' }).catch(e => { throw new K3sRefusal('unreachable', plainK3s(e, 'The admin login did not work'), 502) })
    // Recorded before HyperProx makes anything in the cluster.
    await this.d.audit('k3s.cluster.connect', `k3s:${fp.slice(0, 23)}`, { ...auditBy(typeof actor === 'string' ? actor : { email: actor.email, token: actor.token }), name: o.name, via: o.via, guest: o.guest ? machineKey(o.guest) : null, version: String(ver?.gitVersion ?? '').slice(0, 40), accounts: ['hyperprox-reader', 'hyperprox-operator'] })
    const tokens = await ensureAccounts(admin, this.wait).catch(e => { throw new K3sRefusal('accounts_failed', plainK3s(e, 'HyperProx could not make its accounts'), 502) })
    // Proven before it is kept: the read-only account reads, and cannot read a secret.
    const reader = this.transport({ url, ca: login.ca, token: tokens.reader })
    await reader.call({ path: '/api/v1/nodes', query: { limit: 1 } }).catch(e => { throw new K3sRefusal('reader_failed', plainK3s(e, 'The read-only account could not read'), 502) })
    const leak = await reader.call({ path: `/api/v1/namespaces/${NS}/secrets`, query: { limit: 1 } }).then(() => true, (e: any) => !(e instanceof K3sHttpError && e.status === 403))
    if (leak) throw new K3sRefusal('reader_too_wide', 'HyperProx\'s read-only account can read secrets in this cluster, so it was not kept. Check for a binding that grants more to every service account.', 409)
    return this.d.store.create(
      { name: cleanName(o.name), guest: o.guest, agents: [], caFingerprint: fp, via: o.via },
      { url, ca: login.ca, readerToken: tokens.reader },
      { operatorToken: tokens.operator, kubeconfig: rewriteServer(o.kubeconfig, url), nodeToken: o.nodeToken ?? null },
    )
  }

  /** A person pastes a kubeconfig (the only thing HyperProx could not find itself). */
  async add(body: Record<string, unknown>, actor: Actor): Promise<K3sMeta> {
    this.mustAdmin(actor)
    const nodeToken = typeof body.nodeToken === 'string' && body.nodeToken.trim() ? body.nodeToken.trim() : null
    if (nodeToken && !/^[A-Za-z0-9:._-]{16,512}$/.test(nodeToken)) throw new K3sInputError('The join token is the line in /var/lib/rancher/k3s/server/node-token on the server.')
    const address = typeof body.address === 'string' && body.address.trim() ? cleanAddress(body.address) : null
    return this.connect({ kubeconfig: String(body.kubeconfig ?? ''), address, nodeToken, name: cleanName(body.name), guest: null, via: 'person' }, actor)
  }

  async rename(id: string, name: unknown, actor: Actor): Promise<K3sMeta> {
    this.mustAdmin(actor)
    await this.meta(id)
    const m = await this.d.store.update(id, { name: cleanName(name) })
    await this.d.audit('k3s.cluster.rename', `k3s:${id}`, { ...auditBy(actor), name: m.name })
    return m
  }

  /**
   * Remove: HyperProx's two accounts are deleted in the cluster first (with the kept admin login); when the cluster
   * cannot be reached that is refused unless `force`, and the answer says what is left there. Remembered as
   * dismissed, so auto-connect never adds it back by itself.
   */
  async remove(id: string, actor: Actor, force = false): Promise<{ left: string[] }> {
    this.mustAdmin(actor)
    const m = await this.meta(id)
    const s = await this.d.store.secrets(id)
    const a = await this.d.store.adminSecrets(id)
    let left: string[] = []
    try {
      if (!s || !a) throw new Error('its admin login is not in the vault')
      const l = parseKubeconfig(a.kubeconfig)
      left = await removeAccounts(this.transport({ url: s.url, ca: l.ca, cert: l.cert, key: l.key, token: l.token }))
      if (left.length) throw new Error(`${left.length} of its objects could not be deleted`)
    } catch (e: any) {
      if (!force) throw new K3sRefusal('revoke_failed', `HyperProx could not remove its accounts from ${m.name} (${plainK3s(e, 'the cluster')}). Try again when it answers, or remove anyway and delete the hyperprox-reader and hyperprox-operator service accounts in kube-system yourself.`, 409)
      if (!left.length) left = ['hyperprox-reader', 'hyperprox-operator']
    }
    await this.d.audit('k3s.cluster.remove', `k3s:${id}`, { ...auditBy(actor), name: m.name, force, left })
    if (m.guest) await this.d.dismissed?.(machineKey(m.guest), m.name, actor.email)
    await this.d.store.remove(id)
    this.cache.delete(id)
    return { left }
  }

  /** The cluster whose server answers at `url` (https://host:port), for an agent install. */
  async byServerUrl(url: string): Promise<{ meta: K3sMeta; nodeToken: string | null } | null> {
    for (const m of await this.d.store.list()) {
      const s = await this.d.store.secrets(m.id)
      if (s?.url === url) return { meta: m, nodeToken: (await this.d.store.adminSecrets(m.id))?.nodeToken ?? null }
    }
    return null
  }

  /** Wait for a node to join and report Ready (an agent the Catalogue just installed). */
  async waitNodeReady(id: string, node: string, timeoutMs = 4 * 60_000): Promise<boolean> {
    const until = this.now() + timeoutMs
    while (this.now() < until) {
      const r = await this.reading(id, { fresh: true }).catch(() => null)
      if (r?.nodes.some(n => n.name === node && n.ready)) return true
      await this.wait(5000)
    }
    return false
  }

  async addAgent(id: string, g: GuestRef): Promise<void> {
    const m = await this.meta(id)
    if (!m.agents.some(x => x.kind === g.kind && x.vmid === g.vmid)) await this.d.store.update(id, { agents: [...m.agents, g] })
  }

  // ── auto-connect (lib/auto-connect) ──────────────────────────────────────

  private autoMiss = new Map<string, { at: number; outcome: Outcome }>()

  /** Kubernetes APIs the last passes found but could not read a K3s login for: the K3s page asks for a kubeconfig. */
  waiting(): Array<{ key: string; label: string; message: string; at: number }> {
    return [...this.autoMiss.entries()].filter(([, v]) => v.outcome.did === 'needs_credential')
      .map(([key, v]) => ({ key, label: v.outcome.label, message: v.outcome.message ?? '', at: v.at }))
  }

  /**
   * One pass: every guest where a Kubernetes API answered (the shared scan) or the Catalogue installed K3s, and that
   * is not connected yet, is looked inside (read-only, through the guarded executor) for K3s's admin login. Found:
   * connected with HyperProx's own two accounts. Not found (another Kubernetes, or an agent): left as "needs a
   * kubeconfig", which the K3s page asks for. Never a guest that is excluded, stopped, or that a person removed.
   */
  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    if (!this.d.sightings || !this.d.guests || !this.d.readLogin) return out
    const [sightings, rows, list] = await Promise.all([this.d.sightings(), this.d.guests(), this.d.store.list()])
    const seen = new Map<string, Sighting[]>()
    for (const s of sightings) { const k = machineKey(s.guest); seen.set(k, [...(seen.get(k) ?? []), s]) }
    for (const [key, ss] of seen) {
      const g = ss[0].guest
      const row = rows.find(r => r.kind === g.kind && r.vmid === g.vmid)
      const label = row?.name ?? key
      const ips = [...new Set(ss.map(s => s.ip).filter((x): x is string => !!x))]
      // lib/guest-guard.ts: the tag, Remote access's list and the excluded subnets, as for every adapter.
      const why = exclusionOf(ctx, { machineId: key, tags: row?.ignored && (!row.excludedBy || row.excludedBy === EXCLUSION_WORDS.tag) ? [IGNORE_TAG] : [], addresses: [...ss.map(s => s.url), ...ips] })
        ?? (row?.ignored ? row.excludedBy ?? EXCLUSION_WORDS.tag : null)
      if (why) { out.push({ key, label, did: 'excluded', message: why }); continue }
      if (list.some(m => (m.guest && machineKey(m.guest) === key) || m.agents.some(a => machineKey(a) === key))) { out.push({ key, label, did: 'present' }); continue }
      if (!row) { out.push({ key, label, did: 'skipped', message: 'not on the cluster' }); continue }
      if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
      if (!row.running) { out.push({ key, label, did: 'skipped', message: 'not running' }); continue }
      const ip = ips[0]
      if (!ip) { out.push({ key, label, did: 'skipped', message: 'no address seen' }); continue }
      const miss = this.autoMiss.get(key)
      if (miss && this.now() - miss.at < 60 * 60_000) { out.push(miss.outcome); continue }
      try {
        const res = await this.d.readLogin(g)
        const p = parseLoginOutput(res)
        if (!p.found) {
          const o: Outcome = { key, label, did: 'needs_credential', message: `A Kubernetes API answers on ${label}, but it has no K3s admin login HyperProx can read. Paste its kubeconfig on the K3s page.` }
          this.autoMiss.set(key, { at: this.now(), outcome: o })
          out.push(o); continue
        }
        // A person may have removed it while the guest was read.
        if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
        const evidence = [...new Set(ss.map(s => `found by ${s.via}`)), 'K3s admin login in /etc/rancher/k3s/k3s.yaml']
        await ctx.audit('k3s.cluster.auto_connect', `guest:${key}`, { guest: key, evidence })
        const meta = await this.connect({ kubeconfig: p.kubeconfig, address: `https://${ip.includes(':') ? `[${ip}]` : ip}:6443`, nodeToken: p.nodeToken, name: (row.name || p.hostname || 'K3s').slice(0, 40), guest: g, via: 'auto-connect' }, 'system (auto-connect)')
        out.push({ key, label: meta.name, did: 'connected', evidence })
      } catch (e: any) {
        if (e instanceof K3sRefusal && e.code === 'present') { out.push({ key, label, did: 'present' }); continue }
        out.push({ key, label, did: 'failed', message: plainK3s(e, 'Could not connect').slice(0, 300) })
      }
    }
    return out
  }
}

// ── targets ──────────────────────────────────────────────────────────────────

export interface Target { kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Pod' | 'Node'; namespace?: string; name: string }

const ACTION_KINDS: Record<string, Target['kind'][]> = {
  restart: ['Deployment', 'StatefulSet', 'DaemonSet'], rollback: ['Deployment'], scale: ['Deployment', 'StatefulSet'],
  'delete-pod': ['Pod'], cordon: ['Node'], uncordon: ['Node'], drain: ['Node'],
}

export function actionWords(a: FixAction): string {
  return ({ restart: 'Restarting', rollback: 'Rolling back', scale: 'Scaling', 'delete-pod': 'Deleting', cordon: 'Cordoning', uncordon: 'Uncordoning', drain: 'Draining', logs: 'Reading logs of', 'add-agent': 'Adding a node for' } as Record<string, string>)[a] ?? 'Changing'
}

export function cleanTarget(action: FixAction, body: Record<string, unknown>): Target {
  const kinds = ACTION_KINDS[action]
  if (!kinds) throw new K3sInputError('That is not an action HyperProx takes on a cluster.')
  const kind = body.kind as Target['kind']
  if (!kinds.includes(kind)) throw new K3sInputError(`${actionWords(action)} works on ${kinds.join(' or ')} only.`)
  const name = typeof body.name === 'string' ? body.name : ''
  if (!NAME_RE.test(name)) throw new K3sInputError('That is not a Kubernetes name.')
  if (kind === 'Node') return { kind, name }
  const namespace = typeof body.namespace === 'string' ? body.namespace : ''
  if (!NAMESPACE_RE.test(namespace)) throw new K3sInputError('That is not a namespace.')
  return { kind, namespace, name }
}

export function cleanReplicas(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : NaN
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new K3sInputError('Replicas is a whole number from 0 to 50.')
  return n
}

export function cleanAddress(v: string): string {
  const s = v.trim().replace(/\/+$/, '')
  const u = (() => { try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { return null } })()
  if (!u || u.protocol !== 'https:' || u.username || u.password || (u.pathname && u.pathname !== '/') || u.search) throw new K3sInputError('The server address is https://host:port, such as https://10.0.0.40:6443.')
  return `https://${u.hostname}:${u.port || 6443}`
}

/** A node or workload must be in the fresh reading: a button never acts on something that has gone. (Pods: read by name.) */
export function checkTargetExists(r: Reading, action: FixAction, t: Target): void {
  const found = t.kind === 'Node' ? r.nodes.some(n => n.name === t.name)
    : r.workloads.some(w => w.kind === t.kind && w.namespace === t.namespace && w.name === t.name)
  if (!found) throw new K3sRefusal('not_found', `${t.kind} ${t.namespace ? `${t.namespace}/` : ''}${t.name} is not in the cluster any more.`, 404)
  if (action === 'uncordon' && !r.nodes.find(n => n.name === t.name)?.unschedulable) throw new K3sRefusal('not_needed', `${t.name} is not cordoned.`, 409)
  if (action === 'cordon' && r.nodes.find(n => n.name === t.name)?.unschedulable) throw new K3sRefusal('not_needed', `${t.name} is cordoned already.`, 409)
}

/** Pods on a node, sorted for a drain: moved (a controller makes them again), staying (DaemonSet, mirror), lost. */
export function classifyDrain(pods: any[]): { move: string[]; stay: string[]; lost: string[]; localData: string[] } {
  const move: string[] = [], stay: string[] = [], lost: string[] = [], localData: string[] = []
  for (const p of pods) {
    if (p?.status?.phase === 'Succeeded' || p?.status?.phase === 'Failed') continue
    const n = `${p?.metadata?.namespace}/${p?.metadata?.name}`
    const owner = (p?.metadata?.ownerReferences ?? []).find((o: any) => o?.controller)
    if (p?.metadata?.annotations?.['kubernetes.io/config.mirror'] || owner?.kind === 'DaemonSet') { stay.push(n); continue }
    if (!owner) lost.push(n); else move.push(n)
    if ((p?.spec?.volumes ?? []).some((v: any) => v?.emptyDir)) localData.push(n)
  }
  return { move, stay, lost, localData }
}
