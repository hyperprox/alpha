// K3s plug-in: the reading from recorded API answers (test/fixtures/k3s/cluster.json, captured from a throwaway test
// install with one bad image, one crashing app and one pod too big to schedule; every name and address replaced with
// made-up ones), the problem classification and its fix buttons, versions, the kubeconfig rules, HyperProx's two
// accounts, connecting (least privilege proven before anything is kept), every action's role, token, existence and
// audit checks, the drain plan, roll back, remove, auto-connect (excluded, found, no login) and the gallery card.
// Nothing real is contacted: a stand-in answers for the Kubernetes API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readingOf, podProblem, versionKey, newer, cpuMilli, memBytes, warningsOf, type RawLists } from '../src/lib/k3s/parse'
import { parseKubeconfig, buildKubeconfig, KubeconfigError } from '../src/lib/k3s/kubeconfig'
import { accountObjects, guardPolicies, READER_RULES, OPERATOR_RULES, OPERATOR_USER, removeAccounts } from '../src/lib/k3s/accounts'
import { K3sInstanceStore, parseIndex } from '../src/lib/k3s/instances'
import { K3sService, K3sRefusal, classifyDrain, cleanTarget } from '../src/lib/k3s/service'
import { K3sHttpError, type Call } from '../src/lib/k3s/transport'
import { tileOf } from '../src/plugins/k3s'
import { readingFor, viewOf, VIEWER_SENTENCE, VIEWER_NODE_NOT_READY } from '../src/routes/k3s'

const FX = path.join(__dirname, 'fixtures/k3s')
const raw = JSON.parse(fs.readFileSync(path.join(FX, 'cluster.json'), 'utf8'))
const KUBECONFIG = fs.readFileSync(path.join(FX, 'kubeconfig.yaml'), 'utf8')
const NOW = Date.parse('2026-11-16T03:42:40Z')
const lists = (o: Partial<RawLists> = {}): RawLists => ({ ...raw, latest: 'v1.37.2+k3s1', missing: [], ...o })

// ── reading ──────────────────────────────────────────────────────────────────

test('the recorded cluster reads as one Ready node with its CPU and memory, and the three planted problems', () => {
  const r = readingOf(lists(), NOW)
  assert.equal(r.nodes.length, 1)
  const n = r.nodes[0]
  assert.equal(n.name, 'k3s-a')
  assert.equal(n.ready, true)
  assert.deepEqual(n.roles, ['control-plane'])
  assert.equal(n.ip, '10.0.0.40')
  assert.equal(n.cpu.capMilli, 2000)
  assert.ok(n.mem.capBytes! > 3e9)
  assert.ok(n.cpu.usedMilli !== null && n.mem.usedBytes !== null, 'metrics-server answered')
  assert.deepEqual(n.fixes.map(f => f.action), ['cordon', 'drain'])
  const by = Object.fromEntries(r.problems.map(p => [p.name.split('-')[0], p]))
  assert.equal(by.web.state, 'image')
  assert.match(by.web.message, /nginx:9\.99-does-not-exist/)
  assert.deepEqual(by.web.owner, { kind: 'Deployment', name: 'web' })
  assert.deepEqual(by.web.fixes.map(f => f.action), ['rollback', 'delete-pod', 'logs'])
  assert.equal(by.big.state, 'pending')
  assert.equal(by.big.reason, 'Unschedulable')
  assert.match(by.big.message, /Insufficient cpu/)
  assert.deepEqual(by.big.fixes.map(f => f.action), ['add-agent', 'scale'])
  assert.equal(by.crasher.state, 'crashloop')
  assert.match(by.crasher.message, /exit code 3/)
  assert.deepEqual(by.crasher.fixes.map(f => f.action), ['restart', 'rollback', 'delete-pod', 'logs'])
  assert.equal(r.health.state, 'bad')
  assert.deepEqual(r.health.reasons, ['2 pods failing', '1 pod pending'])
})

test('workloads say desired against ready; services and the ingress carry their addresses', () => {
  const r = readingOf(lists(), NOW)
  const web = r.workloads.find(w => w.name === 'web')!
  assert.equal(web.kind, 'Deployment')
  assert.equal(web.desired, 2)
  assert.equal(web.ready, 2, 'the old pods keep serving while the new image fails')
  assert.equal(r.workloads.find(w => w.name === 'big')!.problem, '0 of 1 ready')
  assert.ok(r.workloads.some(w => w.kind === 'DaemonSet' && w.name.startsWith('svclb-traefik')))
  assert.deepEqual(r.workloads.find(w => w.kind === 'DaemonSet')!.fixes.map(f => f.action), ['restart'], 'a DaemonSet cannot be scaled')
  const traefik = r.services.find(s => s.name === 'traefik')!
  assert.equal(traefik.type, 'LoadBalancer')
  assert.deepEqual(traefik.external, ['10.0.0.40'])
  const ing = r.ingresses.find(i => i.name === 'web')!
  assert.deepEqual(ing.addresses, ['10.0.0.40'])
  assert.deepEqual(ing.paths, ['*/ → web:80'])
  assert.ok(r.namespaces.find(n => n.name === 'demo')!.problems >= 3)
})

test('warning events of the last hour, newest first; the upgrade is offered only when newer', () => {
  const r = readingOf(lists(), NOW)
  assert.ok(r.events.length > 0 && r.events.every(e => e.reason))
  assert.ok(r.events.some(e => /ErrImagePull|ImagePullBackOff|Failed/.test(e.reason + e.message)))
  assert.equal(r.version.current, 'v1.37.1+k3s1')
  assert.equal(r.version.upgrade, 'v1.37.2+k3s1')
  assert.equal(readingOf(lists({ latest: 'v1.37.1+k3s1' }), NOW).version.upgrade, null)
  assert.equal(readingOf(lists({ latest: null }), NOW).version.upgrade, null)
  assert.equal(warningsOf(raw.events, NOW + 3 * 3600_000).length, 0, 'older than an hour: gone')
  assert.ok(newer('v1.38.0+k3s1', 'v1.37.9+k3s2'))
  assert.ok(!newer('v1.37.1+k3s1', 'v1.37.1+k3s1'))
  assert.ok(newer('v1.37.1+k3s2', 'v1.37.1+k3s1'))
  assert.equal(versionKey('nonsense'), null)
})

test('quantities, and the pod states: crash loop, out of memory, restarting, finished and young pending pods', () => {
  assert.equal(cpuMilli('250m'), 250); assert.equal(cpuMilli('2'), 2000); assert.equal(cpuMilli('56123456n'), 56); assert.equal(cpuMilli('x'), null)
  assert.equal(memBytes('3Gi'), 3 * 1024 ** 3); assert.equal(memBytes('893472Ki'), 893472 * 1024); assert.equal(memBytes('1G'), 1e9)
  const pod = (status: any, extra: any = {}) => ({ metadata: { namespace: 'demo', name: 'p', creationTimestamp: new Date(NOW - 60_000).toISOString(), ...extra }, spec: { nodeName: 'k3s-a' }, status })
  assert.equal(podProblem(pod({ phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }), NOW)!.state, 'oom')
  const r = podProblem(pod({ phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 5, state: { running: {} }, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: new Date(NOW - 600_000).toISOString() } } }] }), NOW)!
  assert.equal(r.state, 'restarting')
  assert.match(r.message, /Restarted 5 times/)
  assert.equal(podProblem(pod({ phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 5, state: { running: {} }, lastState: { terminated: { reason: 'Error', finishedAt: new Date(NOW - 3 * 3600_000).toISOString() } } }] }), NOW), null, 'restarts long ago are history')
  assert.equal(podProblem(pod({ phase: 'Succeeded' }), NOW), null)
  assert.equal(podProblem(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] }), NOW), null, 'a minute-old pod is still starting')
  assert.equal(podProblem(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] }), NOW + 10 * 60_000)!.state, 'pending')
})

test('a cordoned node adds an Uncordon fix to pending pods and to the health reasons', () => {
  const nodes = structuredClone(raw.nodes)
  nodes.items[0].spec.unschedulable = true
  const r = readingOf(lists({ nodes }), NOW)
  assert.deepEqual(r.nodes[0].fixes.map(f => f.action), ['uncordon'])
  assert.ok(r.problems.find(p => p.state === 'pending')!.fixes.some(f => f.action === 'uncordon' && f.target.name === 'k3s-a'))
  assert.ok(r.health.reasons.includes('node k3s-a is cordoned'))
})

// ── kubeconfig ───────────────────────────────────────────────────────────────

test('a kubeconfig gives its server, CA and client certificate; dangerous or incomplete ones are refused in words', () => {
  const l = parseKubeconfig(KUBECONFIG)
  assert.equal(l.server, 'https://127.0.0.1:6443')
  assert.match(l.ca, /BEGIN CERTIFICATE/)
  assert.match(l.cert!, /BEGIN CERTIFICATE/)
  assert.match(l.key!, /PRIVATE KEY/)
  const bad = (text: string, why: RegExp) => assert.throws(() => parseKubeconfig(text), (e: any) => e instanceof KubeconfigError && why.test(e.message))
  bad('', /Paste the kubeconfig/)
  bad('just: text', /no clusters and users/)
  bad(KUBECONFIG.replace(/client-certificate-data: \S+\n\s+client-key-data: \S+/, 'exec:\n      command: aws'), /running a program/)
  bad(KUBECONFIG.replace(/certificate-authority-data: \S+/, 'certificate-authority: /etc/ca.pem'), /uses certificate-authority/)
  bad(KUBECONFIG.replace(/certificate-authority-data: \S+/, 'insecure-skip-tls-verify: true'), /certificate checks off|no cluster CA/)
  bad(KUBECONFIG.replace(/server: \S+/, 'server: http://127.0.0.1:6443'), /not an https/)
})

/** The fixture with one more user (and a context for it) that is never the current one. */
const withOtherUser = (user: string) => KUBECONFIG.replace('users:\n', `users:\n- name: other\n  user:\n${user}\n`)

test('YAML anchors and aliases are refused before anything is walked: a billion-laughs kubeconfig is cheap to refuse', () => {
  const levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]']
  for (let i = 1; i < 10; i++) levels.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(9).fill('*' + String.fromCharCode(96 + i)).join(',')}]`)
  const bomb = `apiVersion: v1\n${levels.join('\n')}\nclusters: [*j]\nusers: [*j]\n`
  assert.ok(bomb.length < 64 * 1024)
  const t = Date.now()
  assert.throws(() => parseKubeconfig(bomb), /anchors or aliases/)
  assert.ok(Date.now() - t < 1000, 'refused at once, not after expanding it')
  assert.throws(() => parseKubeconfig(KUBECONFIG.replace('users:\n- name: default\n  user:', 'users:\n- name: default\n  user: &u')), /anchors or aliases/)
  assert.throws(() => parseKubeconfig(KUBECONFIG.replace('    cluster: default\n', '    cluster: *c\n')), /anchors or aliases/)
  // Hidden behind whitespace YAML does not count as whitespace, or any other non-ASCII character: refused outright.
  for (const ch of ['\u00a0', '\u000b', '\u000c', '\u3000', '\u2028']) {
    assert.throws(() => parseKubeconfig(KUBECONFIG.replace('users:\n- name: default\n  user:', `users:\n- name: default\n  user:${ch}&u`)), /outside plain ASCII/, JSON.stringify(ch))
  }
  assert.throws(() => parseKubeconfig(KUBECONFIG.replace('name: default\n', 'name: d\u00e9faut\n')), /outside plain ASCII/)
  // The real one, its base64 and its https address, never trip it.
  assert.ok(parseKubeconfig(KUBECONFIG).cert)
})

test('a document with more values than any kubeconfig is refused by the walk itself (the backstop)', () => {
  const many = KUBECONFIG.replace('current-context: default', `current-context: default\nextensions:\n${Array.from({ length: 10_500 }, (_, i) => `- ${i % 10}`).join('\n')}`)
  assert.throws(() => parseKubeconfig(many), /far larger than a real one|too long/)
})

test('every entry is checked, not only the one used: proxies, turned-off checks in any spelling, exec anywhere, merge keys', () => {
  const bad = (text: string, why: RegExp) => assert.throws(() => parseKubeconfig(text), (e: any) => e instanceof KubeconfigError && why.test(e.message), why.source)
  bad(KUBECONFIG.replace(/(server: \S+)/, '$1\n    proxy-url: http://10.0.0.9:3128'), /proxy-url/)
  bad(KUBECONFIG.replace('current-context: default', 'current-context: default\nextensions:\n- name: x\n  extension:\n    proxy-url: http://10.0.0.9:3128'), /proxy-url/)
  for (const v of ['True', 'true', 'TRUE', 'yes', '1', 'on', '"true"']) {
    bad(KUBECONFIG.replace(/(server: \S+)/, `$1\n    insecure-skip-tls-verify: ${v}`), /certificate checks off/)
  }
  // An explicit "false" is the default and harmless.
  assert.ok(parseKubeconfig(KUBECONFIG.replace(/(server: \S+)/, '$1\n    insecure-skip-tls-verify: false')))
  bad(withOtherUser('    exec:\n      command: /bin/sh\n      apiVersion: client.authentication.k8s.io/v1'), /user other signs in by running a program/)
  bad(withOtherUser('    auth-provider:\n      name: gcp'), /running a program or a cloud login/)
  bad(withOtherUser('    tokenFile: /var/run/token'), /tokenFile/)
  bad(withOtherUser('    client-key: /etc/key.pem'), /client-key/)
  bad(withOtherUser('    as: system:admin'), /another identity/)
  bad(KUBECONFIG.replace('clusters:\n', 'clusters:\n- name: spare\n  cluster:\n    server: https://10.0.0.9:6443\n    certificate-authority: /etc/ca.pem\n'), /cluster spare uses certificate-authority/)
  // Exec hidden behind a merge key: refused for the merge key itself, in block and flow form.
  bad(KUBECONFIG.replace('users:\n', 'x-base: &b\n  exec:\n    command: /bin/sh\nusers:\n- name: other\n  user:\n    <<: *b\n'), /merge key/)
  bad(KUBECONFIG.replace('users:\n', 'users:\n- name: other\n  user: {<<: {exec: {command: sh}}}\n'), /merge key/)
})

test('what is kept is a minimal kubeconfig rebuilt from the checked values, never the text that came in', () => {
  const extra = KUBECONFIG.replace('preferences: {}', 'preferences:\n  colors: true\n# a comment that must not survive')
  const l = parseKubeconfig(extra)
  const kept = buildKubeconfig(l, 'https://10.0.0.40:6443')
  assert.ok(!/preferences|colors|comment|127\.0\.0\.1|NOT A SECRET/.test(kept))
  assert.deepEqual(kept.split('\n').filter(x => /^[a-z]/.test(x)), ['apiVersion: v1', 'kind: Config', 'clusters:', 'users:', 'contexts:', 'current-context: k3s'])
  assert.match(kept, /server: https:\/\/10\.0\.0\.40:6443\n/)
  // It reads back as the same login.
  const again = parseKubeconfig(kept)
  assert.deepEqual({ ...again, server: l.server }, l)
  assert.equal(again.server, 'https://10.0.0.40:6443')
  assert.throws(() => buildKubeconfig(l, 'https://10.0.0.40:6443\n    proxy-url: x'), /https:\/\/host:port/)
})

// ── accounts ─────────────────────────────────────────────────────────────────

test('HyperProx\'s read-only account never reads secrets or config maps; the action account can do only the confirmed actions', () => {
  const all = (rules: typeof READER_RULES) => rules.flatMap(r => r.resources.map(res => ({ res, verbs: r.verbs })))
  assert.ok(!all(READER_RULES).some(x => /secret|configmap/.test(x.res)))
  assert.ok(all(READER_RULES).every(x => x.verbs.every(v => ['get', 'list', 'watch'].includes(v))))
  const op = all(OPERATOR_RULES)
  assert.ok(!op.some(x => /secret|configmap|namespace|serviceaccount|role/.test(x.res)))
  assert.ok(!op.some(x => x.verbs.some(v => ['create', 'update', '*'].includes(v)) && x.res !== 'pods/eviction'))
  assert.deepEqual(op.find(x => x.res === 'pods')!.verbs, ['get', 'list', 'delete'])
  const objs = accountObjects()
  assert.equal(objs.length, 14)
  assert.ok(objs.slice(0, 6).every(o => o.path.startsWith('/apis/admissionregistration.k8s.io/v1/')), 'the guard is made before any token exists')
  assert.ok(objs.every(o => (o.body.metadata as any).labels['app.kubernetes.io/managed-by'] === 'hyperprox'))
})

test('the admission guard on the action account: what each policy refuses, in Kubernetes\' own shape', () => {
  const [wp, wb, np, nb, sp, sb] = guardPolicies().map(o => o.body as any)
  for (const p of [wp, np, sp]) {
    assert.equal(p.apiVersion, 'admissionregistration.k8s.io/v1')
    assert.equal(p.kind, 'ValidatingAdmissionPolicy')
    assert.equal(p.spec.failurePolicy, 'Fail')
    assert.deepEqual(p.spec.matchConditions, [{ name: 'is-hyperprox-operator', expression: `request.userInfo.username == '${OPERATOR_USER}'` }])
  }
  assert.equal(OPERATOR_USER, 'system:serviceaccount:kube-system:hyperprox-operator')
  assert.deepEqual(wp.spec.matchConstraints.resourceRules, [{ apiGroups: ['apps'], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['deployments', 'statefulsets', 'daemonsets'] }])
  // The whole pod spec is frozen for the action account, for all three kinds: privileged, host paths and namespaces,
  // capabilities, privilege escalation, seccomp, sysctls, hostUsers, runtime class, node selection, tolerations,
  // service account and new volumes are all inside it. Labels too; annotations except the restart time.
  const ex = wp.spec.validations.map((v: any) => v.expression)
  assert.equal(ex[0], 'object.spec.template.spec == oldObject.spec.template.spec')
  assert.equal(ex[1], 'variables.newL == variables.oldL')
  assert.match(ex[2], /k == 'kubectl\.kubernetes\.io\/restartedAt' \|\| \(k in variables\.oldA && variables\.oldA\[k\] == variables\.newA\[k\]\)/)
  assert.match(ex[2], /variables\.oldA\.all\(k, k == 'kubectl\.kubernetes\.io\/restartedAt' \|\| k in variables\.newA\)/, 'an annotation cannot be removed either')
  assert.equal(ex[3], "(has(object.metadata.ownerReferences) ? object.metadata.ownerReferences : []) == (has(oldObject.metadata.ownerReferences) ? oldObject.metadata.ownerReferences : []) && (has(object.metadata.finalizers) ? object.metadata.finalizers : []) == (has(oldObject.metadata.finalizers) ? oldObject.metadata.finalizers : [])")
  assert.equal(wp.spec.validations.length, 4)
  // A StatefulSet's volume claim retention, in a policy of its own (the field exists on StatefulSets only).
  assert.deepEqual(sp.spec.matchConstraints.resourceRules, [{ apiGroups: ['apps'], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['statefulsets'] }])
  assert.match(sp.spec.validations[0].expression, /^has\(object\.spec\.persistentVolumeClaimRetentionPolicy\) == has\(oldObject\.spec\.persistentVolumeClaimRetentionPolicy\) && /)
  assert.deepEqual([sb.kind, sb.spec], ['ValidatingAdmissionPolicyBinding', { policyName: 'hyperprox-operator-statefulsets', validationActions: ['Deny'] }])
  assert.deepEqual(np.spec.matchConstraints.resourceRules, [{ apiGroups: [''], apiVersions: ['v1'], operations: ['UPDATE'], resources: ['nodes'] }])
  assert.ok(!np.spec.validations[0].expression.includes('unschedulable'), 'the one field it may change is not compared')
  for (const f of ['metadata.labels', 'metadata.annotations', 'spec.taints', 'spec.providerID']) assert.ok(np.spec.validations[0].expression.includes(`has(object.${f})`), f)
  assert.deepEqual([wb.kind, wb.spec], ['ValidatingAdmissionPolicyBinding', { policyName: 'hyperprox-operator-workloads', validationActions: ['Deny'] }])
  assert.deepEqual([nb.kind, nb.spec], ['ValidatingAdmissionPolicyBinding', { policyName: 'hyperprox-operator-nodes', validationActions: ['Deny'] }])
})

test('the K3s release HyperProx installs serves both admission kinds at v1 (recorded from it)', () => {
  const d = JSON.parse(fs.readFileSync(path.join(FX, 'admissionregistration-v1.json'), 'utf8'))
  assert.equal(d.groupVersion, 'admissionregistration.k8s.io/v1')
  for (const name of ['validatingadmissionpolicies', 'validatingadmissionpolicybindings']) {
    const r = d.resources.find((x: any) => x.name === name)
    assert.ok(r, name)
    for (const verb of ['get', 'patch', 'delete']) assert.ok(r.verbs.includes(verb), `${name} ${verb}`)
  }
  for (const o of guardPolicies()) assert.ok(d.resources.some((r: any) => o.path.endsWith(`/${r.name}/${(o.body as any).metadata.name}`)), o.path)
})

// ── the service, with a stand-in cluster ─────────────────────────────────────

function memStore() {
  const mem = new Map<string, string>()
  return { mem, store: new K3sInstanceStore({
    get: async (c, p, k) => mem.get(`${c}/${p}/${k}`) ?? null,
    set: async (c, p, k, v) => { mem.set(`${c}/${p}/${k}`, v) },
    remove: async (c, p) => { for (const k of [...mem.keys()]) if (k.startsWith(`${c}/${p}/`)) mem.delete(k) },
  }) }
}

/** A stand-in Kubernetes API: answers from the fixture, records every write and which credential sent it. */
function fakeCluster(o: { readerSeesSecrets?: boolean; failDelete?: boolean } = {}) {
  const writes: Array<{ who: string; method: string; path: string; body?: any; contentType?: string }> = []
  const answer = (who: string, c: Call): any => {
    const m = c.method ?? 'GET'
    if (m !== 'GET') {
      writes.push({ who, method: m, path: c.path, body: c.body, contentType: c.contentType })
      if (o.failDelete && m === 'DELETE') throw Object.assign(new K3sHttpError(500, '', 'down'), {})
      return {}
    }
    if (c.path === '/version') return raw.version
    if (/\/secrets\/hyperprox-(reader|operator)-token$/.test(c.path)) return { data: { token: Buffer.from(`${c.path.includes('reader') ? 'reader' : 'operator'}-made-up-token-0123456789`).toString('base64') } }
    if (c.path === '/api/v1/namespaces/kube-system/secrets') { if (who === 'reader' && o.readerSeesSecrets) return { items: [] }; throw new K3sHttpError(403, 'Forbidden', 'forbidden') }
    const map: Record<string, string> = { '/api/v1/nodes': 'nodes', '/apis/metrics.k8s.io/v1beta1/nodes': 'nodeMetrics', '/api/v1/namespaces': 'namespaces', '/api/v1/pods': 'pods',
      '/apis/apps/v1/replicasets': 'replicaSets', '/apis/apps/v1/deployments': 'deployments', '/apis/apps/v1/statefulsets': 'statefulSets', '/apis/apps/v1/daemonsets': 'daemonSets',
      '/api/v1/events': 'events', '/api/v1/services': 'services', '/apis/networking.k8s.io/v1/ingresses': 'ingresses' }
    if (map[c.path]) {
      if (c.path === '/api/v1/pods' && typeof c.query?.fieldSelector === 'string') return { items: raw.pods.items.filter((p: any) => `spec.nodeName=${p.spec.nodeName}` === c.query!.fieldSelector) }
      return raw[map[c.path]]
    }
    let m2 = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)(\/log)?$/.exec(c.path)
    if (m2) {
      if (m2[3]) return 'starting the demo app\nconfig file /etc/app.conf not found\n'
      const p = raw.pods.items.find((x: any) => x.metadata.namespace === m2![1] && x.metadata.name === m2![2])
      if (!p) throw new K3sHttpError(404, 'NotFound', 'not found')
      return p
    }
    if (/^\/api\/v1\/nodes\/[^/]+$/.test(c.path)) return raw.nodes.items[0]
    m2 = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments\/([^/]+)$/.exec(c.path)
    if (m2) return raw.deployments.items.find((x: any) => x.metadata.namespace === m2![1] && x.metadata.name === m2![2])
    m2 = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/replicasets$/.exec(c.path)
    if (m2) return { items: raw.replicaSets.items.filter((x: any) => x.metadata.namespace === m2![1]) }
    throw new K3sHttpError(404, 'NotFound', `no stand-in for ${c.path}`)
  }
  return { writes, transport: (t: any) => {
    const who = t.cert ? 'admin' : String(t.token).startsWith('reader') ? 'reader' : String(t.token).startsWith('operator') ? 'operator' : 'unknown'
    return { call: async (c: Call) => answer(who, c) }
  } }
}

const admin = { email: 'admin@example.com', role: 'admin' as const }
async function connected(o: Parameters<typeof fakeCluster>[0] = {}) {
  const { store, mem } = memStore()
  const fc = fakeCluster(o)
  const audits: Array<{ a: string; d: any }> = []
  const svc = new K3sService({ store, transport: fc.transport, audit: async (a, _r, d) => { audits.push({ a, d }) }, wait: async () => {}, latestStable: async () => 'v1.37.2+k3s1', now: () => NOW })
  const m = await svc.connect({ kubeconfig: KUBECONFIG, address: 'https://10.0.0.40:6443', nodeToken: 'K10made-up::server:abcdefabcdef', name: 'lab', guest: { kind: 'lxc', vmid: 240 }, via: 'catalogue' }, admin)
  fc.writes.length = 0; audits.length = 0
  return { svc, store, mem, fc, audits, m }
}

test('connecting makes both accounts with the admin login and keeps only tokens, the CA and the kubeconfig, in the vault', async () => {
  const { store, mem } = memStore()
  const fc = fakeCluster()
  const audits: string[] = []
  const svc = new K3sService({ store, transport: fc.transport, audit: async a => { audits.push(a) }, wait: async () => {}, now: () => NOW })
  const m = await svc.connect({ kubeconfig: KUBECONFIG, address: 'https://10.0.0.40:6443', nodeToken: 'K10made-up::server:abcdefabcdef', name: 'lab', guest: { kind: 'lxc', vmid: 240 }, via: 'catalogue' }, admin)
  assert.equal(fc.writes.length, 14)
  assert.ok(fc.writes.every(w => w.who === 'admin' && w.method === 'PATCH' && w.contentType === 'application/apply-patch+yaml'))
  assert.deepEqual(audits, ['k3s.cluster.connect'])
  assert.deepEqual([...mem.keys()].sort(), [
    `plugin/k3s.${m.id}.admin/kubeconfig`, `plugin/k3s.${m.id}.admin/node_token`, `plugin/k3s.${m.id}.operator/operator_token`,
    `plugin/k3s.${m.id}/ca`, `plugin/k3s.${m.id}/reader_token`, `plugin/k3s.${m.id}/url`, 'plugin/k3s/instances'])
  const kept = mem.get(`plugin/k3s.${m.id}.admin/kubeconfig`)!
  assert.equal(kept, buildKubeconfig(parseKubeconfig(KUBECONFIG), 'https://10.0.0.40:6443'), 'the rebuilt minimal form, not the text that came in')
  assert.ok(!/NOT A SECRET|preferences/.test(kept))
  const index = mem.get('plugin/k3s/instances')!
  assert.ok(!/token|BEGIN|10\.0\.0\.40/.test(index), 'the list holds no credential and no address')
  assert.deepEqual(parseIndex(index)[0].guest, { kind: 'lxc', vmid: 240 })
  await assert.rejects(svc.connect({ kubeconfig: KUBECONFIG, address: 'https://10.0.0.40:6443', name: 'again', guest: null, via: 'person' }, admin), (e: any) => e.code === 'present')
})

test('a cluster where every account can read secrets is not kept', async () => {
  const { store, mem } = memStore()
  const svc = new K3sService({ store, transport: fakeCluster({ readerSeesSecrets: true }).transport, audit: async () => {}, wait: async () => {} })
  await assert.rejects(svc.connect({ kubeconfig: KUBECONFIG, address: 'https://10.0.0.40:6443', name: 'lab', guest: null, via: 'person' }, admin), (e: any) => e.code === 'reader_too_wide')
  assert.equal(mem.size, 0)
  await assert.rejects(svc.add({ name: 'x', kubeconfig: KUBECONFIG }, admin), /127\.0\.0\.1/)
})

test('actions: admin only, never an API token, checked against the cluster, audited before they are sent, sent with the action account', async () => {
  const { svc, m, fc, audits } = await connected()
  await assert.rejects(svc.act(m.id, 'restart', { kind: 'Deployment', namespace: 'demo', name: 'web' }, { email: 'v@example.com', role: 'viewer' }), (e: any) => e.code === 'forbidden')
  await assert.rejects(svc.act(m.id, 'restart', { kind: 'Deployment', namespace: 'demo', name: 'web' }, { ...admin, token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(svc.act(m.id, 'restart', { kind: 'Deployment', namespace: 'demo', name: 'gone' }, admin), (e: any) => e.code === 'not_found')
  await assert.rejects(svc.act(m.id, 'delete-pod', { kind: 'Pod', namespace: 'demo', name: 'gone-pod' }, admin), (e: any) => e.code === 'not_found')
  await assert.rejects(svc.act(m.id, 'uncordon', { kind: 'Node', name: 'k3s-a' }, admin), (e: any) => e.code === 'not_needed')
  await assert.rejects(svc.act(m.id, 'scale', { kind: 'Deployment', namespace: 'demo', name: 'web', replicas: 51 }, admin), /0 to 50/)
  assert.throws(() => cleanTarget('restart', { kind: 'Pod', namespace: 'demo', name: 'x' }), /works on Deployment/)
  assert.throws(() => cleanTarget('delete-pod', { kind: 'Pod', namespace: 'demo', name: '../etc' }), /not a Kubernetes name/)
  assert.equal(fc.writes.length, 0, 'nothing refused reached the cluster')
  assert.equal(audits.length, 0)

  const r = await svc.act(m.id, 'restart', { kind: 'Deployment', namespace: 'demo', name: 'crasher' }, admin)
  assert.match(r.done, /crasher is restarting/)
  assert.equal(fc.writes[0].who, 'operator')
  assert.equal(fc.writes[0].path, '/apis/apps/v1/namespaces/demo/deployments/crasher')
  assert.ok(fc.writes[0].body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])
  assert.deepEqual(audits.map(a => [a.a, a.d.name, a.d.by]), [['k3s.action.restart', 'crasher', 'admin@example.com']])

  await svc.act(m.id, 'scale', { kind: 'Deployment', namespace: 'demo', name: 'big', replicas: 0 }, admin)
  assert.deepEqual(fc.writes[1], { who: 'operator', method: 'PATCH', path: '/apis/apps/v1/namespaces/demo/deployments/big/scale', body: { spec: { replicas: 0 } }, contentType: 'application/merge-patch+json' })
  const pod = raw.pods.items.find((p: any) => p.metadata.name.startsWith('crasher-')).metadata.name
  await svc.act(m.id, 'delete-pod', { kind: 'Pod', namespace: 'demo', name: pod }, admin)
  assert.equal(fc.writes[2].method, 'DELETE')
  await svc.act(m.id, 'cordon', { kind: 'Node', name: 'k3s-a' }, admin)
  assert.deepEqual(fc.writes[3].body, { spec: { unschedulable: true } })
})

test('roll back restores the previous ReplicaSet\'s template, with the admin login (the action account cannot change a template)', async () => {
  const { svc, m, fc, audits } = await connected()
  const r = await svc.act(m.id, 'rollback', { kind: 'Deployment', namespace: 'demo', name: 'web' }, admin)
  assert.match(r.done, /back to revision 1 \(nginx:1\.29-alpine\)/)
  const w = fc.writes[0]
  assert.equal(w.who, 'admin')
  assert.equal(audits[0].d.via, 'admin login')
  await svc.act(m.id, 'restart', { kind: 'Deployment', namespace: 'demo', name: 'web' }, admin)
  assert.equal(fc.writes[1].who, 'operator', 'everything else stays on the action account')
  assert.equal(w.contentType, 'application/json-patch+json')
  assert.equal(w.body[0].op, 'test')
  assert.equal(w.body[1].path, '/spec/template')
  assert.equal(w.body[1].value.spec.containers[0].image, 'nginx:1.29-alpine')
  assert.ok(!('pod-template-hash' in w.body[1].value.metadata.labels))
})

test('a drain is shown first; pods nothing would recreate are refused until confirmed; DaemonSet pods stay', async () => {
  const { svc, m } = await connected()
  const plan = await svc.drainPreview(m.id, 'k3s-a', admin)
  assert.ok(plan.move.some(p => p.startsWith('demo/web-')))
  assert.ok(plan.stay.some(p => p.startsWith('kube-system/svclb-traefik')))
  assert.deepEqual(plan.lost, [])
  const pods = [{ metadata: { namespace: 'demo', name: 'lonely' }, spec: {}, status: { phase: 'Running' } },
    { metadata: { namespace: 'demo', name: 'cache', ownerReferences: [{ controller: true, kind: 'ReplicaSet' }] }, spec: { volumes: [{ emptyDir: {} }] }, status: { phase: 'Running' } },
    { metadata: { namespace: 'demo', name: 'done', ownerReferences: [{ controller: true, kind: 'Job' }] }, spec: {}, status: { phase: 'Succeeded' } }]
  assert.deepEqual(classifyDrain(pods), { move: ['demo/cache'], stay: [], lost: ['demo/lonely'], localData: ['demo/cache'] })
  await assert.rejects(svc.drainPreview(m.id, 'k3s-a', { email: 'v', role: 'viewer' }), /Only an admin/)
})

test('logs are admin, read with the read-only account, and only from a container the pod has', async () => {
  const { svc, m, audits } = await connected()
  const pod = raw.pods.items.find((p: any) => p.metadata.name.startsWith('crasher-')).metadata.name
  const l = await svc.logs(m.id, 'demo', pod, undefined, true, admin)
  assert.equal(l.container, 'app')
  assert.deepEqual(l.lines, ['starting the demo app', 'config file /etc/app.conf not found'])
  assert.equal(audits[0].a, 'k3s.logs.read')
  await assert.rejects(svc.logs(m.id, 'demo', pod, 'other', false, admin), /no container called other/)
  await assert.rejects(svc.logs(m.id, 'demo', pod, undefined, false, { email: 'o', role: 'operator' }), /Only an admin/)
})

test('a reading carries the failing pods\' last lines for admins only; viewers lose the address too', async () => {
  const { svc, m } = await connected()
  const r = await svc.reading(m.id, { fresh: true })
  assert.ok(r.problems.find(p => p.state === 'crashloop')!.lastLines!.length > 0)
  const v = readingFor(r, false)
  assert.ok(v.problems.every(p => !('lastLines' in p)))
  assert.ok(v.nodes.every(n => n.ip === null))
  assert.ok(v.ingresses.every(i => !i.hosts.length && !i.addresses.length && !i.paths.length))
  assert.ok(v.services.every(x => x.clusterIP === null && !x.external.length))
  assert.ok(v.events.every(e => e.message === ''))
  assert.ok(!JSON.stringify(v).includes('10.0.0.40'), 'no address reaches a viewer')
  assert.ok(v.workloads.every(w => w.images.length === 0))
  // Every problem's message is the fixed sentence for its state; the reason (a Kubernetes word) stays.
  for (const p of v.problems) assert.equal(p.message, VIEWER_SENTENCE[p.state])
  assert.deepEqual(v.problems.map(p => p.reason), r.problems.map(p => p.reason))
  assert.ok(!/docker\.io|nginx:9/.test(JSON.stringify(v)), 'no registry or image name reaches a viewer')
  assert.ok(readingFor(r, true).problems.some(p => p.lastLines))
  assert.equal('url' in viewOf({ id: 'k1', url: 'https://10.0.0.40:6443' }, false), false)
  const tile = tileOf([{ id: m.id, name: 'lab', reading: r, error: null }])
  assert.equal(tile.tone, 'bad')
  assert.match(tile.headline, /2 pods failing, 1 pod pending/)
})

test('remove deletes HyperProx\'s accounts with the kept admin login, then the vault items, and remembers the dismissal', async () => {
  const { svc, m, fc, mem } = await connected()
  const dismissed: string[] = []
  ;(svc.d as any).dismissed = async (k: string) => { dismissed.push(k) }
  ;(svc.d as any).audit = async (a: string) => { fc.writes.push({ who: 'audit', method: a, path: '' }) }
  const r = await svc.remove(m.id, admin)
  assert.deepEqual(r.left, [])
  assert.deepEqual(fc.writes.map(w => w.who === 'audit' ? w.method : w.method).filter(x => x.startsWith('k3s.')), ['k3s.cluster.remove', 'k3s.cluster.removed'])
  assert.equal(fc.writes[0].method, 'k3s.cluster.remove', 'recorded before anything is deleted')
  const deletes = fc.writes.filter(w => w.method === 'DELETE')
  assert.equal(deletes.length, 14)
  fc.writes.splice(0, 1); fc.writes.pop()
  assert.ok(fc.writes.slice(-6).every(w => w.path.includes('admissionregistration')), 'the guard goes last, after every token')
  assert.ok(fc.writes.every(w => w.who === 'admin' && w.method === 'DELETE'))
  assert.equal([...mem.keys()].filter(k => k.includes(m.id)).length, 0)
  assert.deepEqual(dismissed, ['lxc-240'])
  const left = await removeAccounts({ call: async () => { throw new K3sHttpError(404, 'NotFound', '') } })
  assert.deepEqual(left, [], 'already gone counts as removed')
})

test('a viewer never reads the cluster\'s own words: IPv6, host:port, bare host names, URLs and credentials all stay out', () => {
  const nasty = [
    'dial tcp [fd00:10:42::9]:8080: connect: connection refused', 'peer 2001:db8::5 unreachable',
    'Get "http://[fe80::1%eth0]:10250/healthz": context deadline exceeded', 'registry.internal:5000 refused',
    'pull from registry.internal failed', 'see https://git.example.org', 'https://deploy:hunter2@registry.example.net/app',
    'node-a.lan said no', 'ftp://user:pw@10.1.2.3',
  ]
  const now = Date.parse('2026-11-16T03:42:40Z')
  const base = readingOf({ ...raw, latest: null, missing: [] }, now)
  const r = {
    ...base,
    problems: (Object.keys(VIEWER_SENTENCE) as Array<keyof typeof VIEWER_SENTENCE>).map((state, i) => ({
      namespace: 'demo', name: `p${i}`, node: 'k3s-a', state, reason: 'Whatever', message: nasty[i % nasty.length] + ' ' + nasty[(i + 3) % nasty.length],
      container: 'app', restarts: 1, since: null, owner: null, lastLines: [nasty[i % nasty.length]], fixes: [],
    })),
    nodes: base.nodes.map(n => ({ ...n, ready: false, reason: nasty.join(' | ') })),
  }
  const v = JSON.stringify(readingFor(r, false))
  for (const bit of ['fd00', '2001:db8', 'fe80', 'registry.internal', 'git.example.org', 'hunter2', 'deploy:', 'example.net', 'node-a.lan', 'user:pw', '10.1.2.3', '5000', '10250', '8080'])
    assert.ok(!v.includes(bit), bit)
  assert.ok(readingFor(r, false).nodes.every(n => n.reason === VIEWER_NODE_NOT_READY))
  assert.ok(readingFor(r, true).nodes.every(n => n.reason!.includes('fd00')), 'admins still read the real text')
})

test('rename is admin, recorded before it is saved', async () => {
  const { svc, m, store } = await connected()
  const seen: string[] = []
  ;(svc.d as any).audit = async (a: string) => { seen.push(`${a} (saved name: ${(await store.get(m.id))!.name})`) }
  await svc.rename(m.id, 'Lab cluster', admin)
  assert.deepEqual(seen, ['k3s.cluster.rename (saved name: lab)'])
  assert.equal((await store.get(m.id))!.name, 'Lab cluster')
  await assert.rejects(svc.rename(m.id, 'x', { email: 'v', role: 'viewer' }), /Only an admin/)
})

test('remove refuses when the cluster cannot be reached, unless forced', async () => {
  const { store } = memStore()
  const fc = fakeCluster({ failDelete: true })
  const svc = new K3sService({ store, transport: fc.transport, audit: async () => {}, wait: async () => {} })
  const m = await svc.connect({ kubeconfig: KUBECONFIG, address: 'https://10.0.0.40:6443', name: 'lab', guest: null, via: 'person' }, admin)
  await assert.rejects(svc.remove(m.id, admin), (e: any) => e.code === 'revoke_failed' && /hyperprox-reader/.test(e.message))
  assert.equal((await store.list()).length, 1, 'kept until it is removed anyway')
  const left = await svc.remove(m.id, admin, true)
  assert.ok(left.left.length > 0, 'the objects left in the cluster are named')
  assert.equal((await store.list()).length, 0)
})

// ── auto-connect ─────────────────────────────────────────────────────────────

const ctx = (o: { excluded?: string[]; dismissed?: string[] } = {}) => ({
  dismissed: (k: string) => (o.dismissed ?? []).includes(k), autoConnectedBefore: () => false,
  excludedMachines: new Set(o.excluded ?? []), excludedSubnets: [], vaultItems: () => [], audit: async () => {}, now: () => NOW,
})

test('auto-connect reads K3s\'s login in a found guest and connects it; excluded, dismissed and stopped guests are left alone', async () => {
  const { store } = memStore()
  const fc = fakeCluster()
  const reads: number[] = []
  const login = `@@k3s kubeconfig\n${Buffer.from(KUBECONFIG).toString('base64')}\n@@k3s hostname k3s-a\n@@k3s end\n`
  const svc = new K3sService({
    store, transport: fc.transport, audit: async () => {}, wait: async () => {}, now: () => NOW,
    sightings: async () => [240, 241, 242, 243].map(v => ({ guest: { kind: 'lxc' as const, vmid: v }, url: `https://10.0.0.${v - 200}:6443`, ip: `10.0.0.${v - 200}`, via: 'the service scan' })),
    guests: async () => [
      { kind: 'lxc', vmid: 240, name: 'k3s-a', node: 'pve1', running: true, ignored: false, excludedBy: null },
      { kind: 'lxc', vmid: 241, name: 'other-k8s', node: 'pve1', running: true, ignored: false, excludedBy: null },
      { kind: 'lxc', vmid: 242, name: 'private', node: 'pve1', running: true, ignored: true, excludedBy: 'the hyperprox-ignore tag' },
      { kind: 'lxc', vmid: 243, name: 'stopped', node: 'pve1', running: false, ignored: false, excludedBy: null },
    ],
    readLogin: async g => { reads.push(g.vmid); return g.vmid === 240 ? login : '@@k3s none\n' },
  })
  const out = await svc.autoConnect(ctx() as any)
  const did = Object.fromEntries(out.map(o => [o.key, o.did]))
  assert.deepEqual(did, { 'lxc-240': 'connected', 'lxc-241': 'needs_credential', 'lxc-242': 'excluded', 'lxc-243': 'skipped' })
  assert.deepEqual(reads.sort(), [240, 241], 'an excluded or stopped guest is never entered')
  assert.equal((await store.list())[0].via, 'auto-connect')
  assert.equal((await store.secrets((await store.list())[0].id))!.url, 'https://10.0.0.40:6443', 'the address the scan saw, not the kubeconfig\'s loopback')
  assert.deepEqual(svc.waiting().map(w => w.label), ['other-k8s'])
  const again = await svc.autoConnect(ctx({ excluded: ['lxc-241'] }) as any)
  assert.equal(again.find(o => o.key === 'lxc-240')!.did, 'present')
  assert.equal(again.find(o => o.key === 'lxc-241')!.did, 'excluded')
  const third = await svc.autoConnect(ctx({ dismissed: ['lxc-240'] }) as any)
  assert.equal(third.find(o => o.key === 'lxc-240')!.did, 'present', 'still connected: a dismissal only stops it being added back after a removal')
})

test('the gallery card asks for nothing when no cluster is connected', () => {
  assert.throws(() => tileOf([]), /install K3s from the Catalogue/)
  assert.ok(K3sRefusal)
})
