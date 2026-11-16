// =============================================================================
//  HyperProx — K3s: HyperProx's own two accounts in a cluster
//
//  The admin kubeconfig K3s writes (a client certificate in system:masters) is
//  kept in the vault for the person, and used by HyperProx only to make, and
//  later remove, two service accounts of its own in kube-system:
//
//    hyperprox-reader     get/list/watch on what the K3s page shows, and pod
//                         logs. Never secrets or config maps. Every read uses it.
//    hyperprox-operator   exactly the confirmed actions: restart, roll back and
//                         scale a workload, delete a pod, cordon/uncordon a
//                         node and evict pods to drain it. Used by nothing else.
//
//  Each gets a long-lived token Secret (type service-account-token), which
//  Kubernetes fills in. Server-side apply makes all of it idempotent: running
//  it again (a reconnect) changes nothing that is already right.
// =============================================================================

import type { K3sTransport } from './transport'

export const NS = 'kube-system'
export const READER = 'hyperprox-reader'
export const OPERATOR = 'hyperprox-operator'
export const MANAGED_BY = { 'app.kubernetes.io/managed-by': 'hyperprox' }

export const READER_RULES = [
  { apiGroups: [''], resources: ['nodes', 'namespaces', 'pods', 'services', 'events', 'endpoints', 'persistentvolumeclaims'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
  { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['events.k8s.io'], resources: ['events'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['metrics.k8s.io'], resources: ['nodes', 'pods'], verbs: ['get', 'list'] },
]

export const OPERATOR_RULES = [
  { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['get', 'patch'] },
  { apiGroups: ['apps'], resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['get', 'patch'] },
  { apiGroups: ['apps'], resources: ['replicasets'], verbs: ['get', 'list'] },
  { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'delete'] },
  { apiGroups: [''], resources: ['pods/eviction'], verbs: ['create'] },
  { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] },
]

/** Every object HyperProx makes, as server-side-apply bodies with their API paths. */
export function accountObjects(): Array<{ path: string; body: Record<string, unknown> }> {
  const out: Array<{ path: string; body: Record<string, unknown> }> = []
  for (const [name, rules] of [[READER, READER_RULES], [OPERATOR, OPERATOR_RULES]] as const) {
    const labels = { ...MANAGED_BY }
    out.push({ path: `/api/v1/namespaces/${NS}/serviceaccounts/${name}`, body: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: NS, labels } } })
    out.push({ path: `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`, body: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name, labels }, rules } })
    out.push({ path: `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${name}`, body: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name, labels },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
      subjects: [{ kind: 'ServiceAccount', name, namespace: NS }],
    } })
    out.push({ path: `/api/v1/namespaces/${NS}/secrets/${name}-token`, body: {
      apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/service-account-token',
      metadata: { name: `${name}-token`, namespace: NS, labels, annotations: { 'kubernetes.io/service-account.name': name } },
    } })
  }
  return out
}

export interface Tokens { reader: string; operator: string }

/**
 * Make (or confirm) both accounts with the admin login and return their tokens. `wait` is the pause between reads
 * of a token Secret, which Kubernetes fills in a moment after it is made.
 */
export async function ensureAccounts(admin: Pick<K3sTransport, 'call'>, wait: (ms: number) => Promise<unknown>): Promise<Tokens> {
  for (const o of accountObjects()) {
    await admin.call({ method: 'PATCH', path: o.path, query: { fieldManager: 'hyperprox', force: true }, body: o.body, contentType: 'application/apply-patch+yaml' })
  }
  const token = async (name: string): Promise<string> => {
    for (let i = 0; i < 20; i++) {
      const s = await admin.call<any>({ path: `/api/v1/namespaces/${NS}/secrets/${name}-token` })
      const t = typeof s?.data?.token === 'string' ? Buffer.from(s.data.token, 'base64').toString('utf8') : ''
      if (/^[A-Za-z0-9._-]{20,4096}$/.test(t)) return t
      await wait(1000)
    }
    throw new Error(`Kubernetes did not fill in the token for ${name} within 20 seconds.`)
  }
  return { reader: await token(READER), operator: await token(OPERATOR) }
}

/** Remove everything accountObjects made (when a cluster is removed from HyperProx). Already gone counts as removed. */
export async function removeAccounts(admin: Pick<K3sTransport, 'call'>): Promise<string[]> {
  const left: string[] = []
  for (const o of accountObjects().reverse()) {
    try { await admin.call({ method: 'DELETE', path: o.path }) } catch (e: any) { if (e?.status !== 404) left.push(o.path.split('/').slice(-2).join('/')) }
  }
  return left
}

// ── reading the admin login from inside a server ─────────────────────────────

const LOGIN_FILE = '/etc/rancher/k3s/k3s.yaml'
const TOKEN_FILE = '/var/lib/rancher/k3s/server/node-token'

/**
 * Run in the server's guest (through the guarded executor, or the installer's own pct exec): prints the kubeconfig
 * and the node token base64-encoded between markers. Its output is a secret: never logged, never put in a job.
 */
export const READ_LOGIN_SCRIPT = [
  'set -e',
  `if [ ! -f ${LOGIN_FILE} ]; then echo "@@k3s none"; exit 0; fi`,
  'echo "@@k3s kubeconfig"',
  `base64 -w0 ${LOGIN_FILE}`,
  'echo',
  `if [ -f ${TOKEN_FILE} ]; then echo "@@k3s token"; base64 -w0 ${TOKEN_FILE}; echo; fi`,
  'echo "@@k3s hostname $(hostname)"',
  'echo "@@k3s end"',
].join('\n') + '\n'

export function parseLoginOutput(out: string): { found: false } | { found: true; kubeconfig: string; nodeToken: string | null; hostname: string | null } {
  if (/^@@k3s none$/m.test(out)) return { found: false }
  const take = (marker: string) => {
    const m = new RegExp(`^@@k3s ${marker}\\n([A-Za-z0-9+/=]+)$`, 'm').exec(out)
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : null
  }
  const kubeconfig = take('kubeconfig')
  if (!kubeconfig || !/^@@k3s end$/m.test(out)) return { found: false }
  const tok = take('token')?.trim() ?? null
  const host = /^@@k3s hostname ([A-Za-z0-9.-]{1,63})$/m.exec(out)?.[1] ?? null
  return { found: true, kubeconfig, nodeToken: tok && /^[A-Za-z0-9:._-]{16,512}$/.test(tok) ? tok : null, hostname: host }
}
