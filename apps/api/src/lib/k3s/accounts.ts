// =============================================================================
//  HyperProx — K3s: HyperProx's own two accounts in a cluster
//
//  The admin kubeconfig K3s writes (a client certificate in system:masters) is
//  kept in the vault for the person, and used by HyperProx only to make, and
//  later remove, two service accounts of its own in kube-system:
//
//    hyperprox-reader     get/list/watch on what the K3s page shows, and pod
//                         logs. Never secrets or config maps. Every read uses it.
//    hyperprox-operator   the rights restart, scale, delete pod, cordon, uncordon
//                         and drain need, narrowed by three admission policies
//                         (below): a workload's pod template cannot change
//                         except its restart time, a node nothing but cordoning.
//                         A roll back uses the admin login, after a confirmation.
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
  { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'delete'] },
  { apiGroups: [''], resources: ['pods/eviction'], verbs: ['create'] },
  { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] },
]

// ── the guard on the action account ──────────────────────────────────────────
//
// RBAC cannot say "patch a deployment, but only its restart annotation or its template's image". So two
// ValidatingAdmissionPolicies (admissionregistration.k8s.io/v1, Kubernetes 1.30 and later) watch every update the
// action account sends: a workload's pod template may not change at all except its restart time (so nothing it runs
// or may do can be widened); on a node, nothing may change but whether it takes new pods. A roll back, which does
// change the template, is sent with the admin login after the person confirms it. Made before any token exists,
// removed with the accounts.

export const OPERATOR_USER = `system:serviceaccount:${NS}:${OPERATOR}`
export const WORKLOAD_POLICY = 'hyperprox-operator-workloads'
export const NODE_POLICY = 'hyperprox-operator-nodes'
export const STATEFULSET_POLICY = 'hyperprox-operator-statefulsets'

/** The one pod-template annotation a restart sets; nothing else in the template may change through the action account. */
export const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'
const same = (path: string, empty: string) => `(has(object.${path}) ? object.${path} : ${empty}) == (has(oldObject.${path}) ? oldObject.${path} : ${empty})`
/** CEL: two annotation maps are equal once the restart annotation is left out of both. */
const sameButRestart = (a: string, b: string) =>
  `${a}.all(k, k == '${RESTARTED_AT}' || (k in ${b} && ${b}[k] == ${a}[k])) && ${b}.all(k, k == '${RESTARTED_AT}' || k in ${a})`

export function guardPolicies(): Array<{ path: string; body: Record<string, unknown> }> {
  const labels = { ...MANAGED_BY }
  const match = [{ name: 'is-hyperprox-operator', expression: `request.userInfo.username == '${OPERATOR_USER}'` }]
  // The action account only ever restarts (a new restart annotation) or scales (through the scale subresource, which
  // this policy does not match: it changes replicas and nothing else). So the pod template is frozen: its whole spec
  // (containers, images, commands, security contexts, volumes, service account, host namespaces, node selection,
  // runtime class, sysctls, everything), its labels, and its annotations (AppArmor and seccomp ones included) apart
  // from the restart time. A roll back is done with the admin login instead, after the person confirms it.
  const workloads = {
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: WORKLOAD_POLICY, labels },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: { resourceRules: [{ apiGroups: ['apps'], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['deployments', 'statefulsets', 'daemonsets'] }] },
      matchConditions: match,
      variables: [
        { name: 'newA', expression: "has(object.spec.template.metadata) && has(object.spec.template.metadata.annotations) ? object.spec.template.metadata.annotations : {}" },
        { name: 'oldA', expression: "has(oldObject.spec.template.metadata) && has(oldObject.spec.template.metadata.annotations) ? oldObject.spec.template.metadata.annotations : {}" },
        { name: 'newL', expression: "has(object.spec.template.metadata) && has(object.spec.template.metadata.labels) ? object.spec.template.metadata.labels : {}" },
        { name: 'oldL', expression: "has(oldObject.spec.template.metadata) && has(oldObject.spec.template.metadata.labels) ? oldObject.spec.template.metadata.labels : {}" },
      ],
      validations: [
        { expression: 'object.spec.template.spec == oldObject.spec.template.spec', message: 'HyperProx\'s action account may restart or scale a workload, never change what its pods run or are allowed to do.' },
        { expression: 'variables.newL == variables.oldL', message: 'HyperProx\'s action account may not change a workload\'s pod labels.' },
        { expression: sameButRestart('variables.newA', 'variables.oldA'), message: 'HyperProx\'s action account may change only the restart time in a pod template\'s annotations.' },
        // Who owns the workload and what must happen before it goes are not the action account's to change either.
        { expression: `${same('metadata.ownerReferences', '[]')} && ${same('metadata.finalizers', '[]')}`, message: 'HyperProx\'s action account may not change a workload\'s owners or finalizers.' },
      ],
    },
  }
  // A StatefulSet's volume claims: whether they are deleted with it or on scale-down. Its own policy, because the
  // field exists only on StatefulSets and each policy is type-checked against every kind it matches.
  const statefulsets = {
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: STATEFULSET_POLICY, labels },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: { resourceRules: [{ apiGroups: ['apps'], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['statefulsets'] }] },
      matchConditions: match,
      validations: [
        { expression: 'has(object.spec.persistentVolumeClaimRetentionPolicy) == has(oldObject.spec.persistentVolumeClaimRetentionPolicy) && (!has(object.spec.persistentVolumeClaimRetentionPolicy) || object.spec.persistentVolumeClaimRetentionPolicy == oldObject.spec.persistentVolumeClaimRetentionPolicy)', message: 'HyperProx\'s action account may not change what happens to a StatefulSet\'s volumes.' },
      ],
    },
  }
  const nodes = {
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: NODE_POLICY, labels },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: { resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['nodes'] }] },
      matchConditions: match,
      validations: [
        { expression: [same('metadata.labels', '{}'), same('metadata.annotations', '{}'), same('metadata.finalizers', '[]'), same('metadata.ownerReferences', '[]'),
          same('spec.taints', '[]'), same('spec.podCIDR', "''"), same('spec.podCIDRs', '[]'), same('spec.providerID', "''")].join(' && '),
          message: 'HyperProx may change only whether a node takes new pods.' },
      ],
    },
  }
  const binding = (name: string) => ({
    apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding', metadata: { name, labels },
    spec: { policyName: name, validationActions: ['Deny'] },
  })
  const base = '/apis/admissionregistration.k8s.io/v1'
  return [
    { path: `${base}/validatingadmissionpolicies/${WORKLOAD_POLICY}`, body: workloads },
    { path: `${base}/validatingadmissionpolicybindings/${WORKLOAD_POLICY}`, body: binding(WORKLOAD_POLICY) },
    { path: `${base}/validatingadmissionpolicies/${NODE_POLICY}`, body: nodes },
    { path: `${base}/validatingadmissionpolicybindings/${NODE_POLICY}`, body: binding(NODE_POLICY) },
    { path: `${base}/validatingadmissionpolicies/${STATEFULSET_POLICY}`, body: statefulsets },
    { path: `${base}/validatingadmissionpolicybindings/${STATEFULSET_POLICY}`, body: binding(STATEFULSET_POLICY) },
  ]
}

/** Every object HyperProx makes, as server-side-apply bodies with their API paths: the guard first, so no action token ever exists without it. */
export function accountObjects(): Array<{ path: string; body: Record<string, unknown> }> {
  const out: Array<{ path: string; body: Record<string, unknown> }> = [...guardPolicies()]
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
