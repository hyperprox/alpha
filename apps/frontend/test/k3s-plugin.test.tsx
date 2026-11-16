// The K3s page's pieces, rendered to HTML: a pod in trouble with its state in words, its reason, its last log lines and
// its fix buttons (none below admin), a node card with its rings, pills and actions, a workload tile with ready against
// desired, the network view with ingress links, and the pure logic behind the confirmations and the drain plan.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { DrainSummary, NetworkView, NodeCard, ProblemCard, WorkloadTile } from '../components/plugins/k3s/parts'
import { confirmText, drainWords, healthWord, ingressLinks, share, cores, gib, visibleFixes, type Fix, type NodeRow, type ProblemPod, type WorkloadRow } from '../components/plugins/k3s/logic'

const noop = () => {}
const rollback: Fix = { action: 'rollback', label: 'Roll back to the previous version', confirm: 'web goes back to the pod template it had before the last change.', target: { kind: 'Deployment', namespace: 'demo', name: 'web' } }
const del: Fix = { action: 'delete-pod', label: 'Delete pod', confirm: 'gone', target: { kind: 'Pod', namespace: 'demo', name: 'web-1' } }
const pod = (o: Partial<ProblemPod> = {}): ProblemPod => ({
  namespace: 'demo', name: 'web-1', node: 'k3s-a', state: 'image', reason: 'ImagePullBackOff', message: 'Back-off pulling image "nginx:9.99"',
  container: 'nginx', restarts: 0, since: null, owner: { kind: 'Deployment', name: 'web' }, fixes: [rollback, del], ...o,
})
const node = (o: Partial<NodeRow> = {}): NodeRow => ({
  name: 'k3s-a', ready: true, reason: null, roles: ['control-plane'], version: 'v1.37.1+k3s1', ip: '10.0.0.40', os: 'Debian GNU/Linux 13', unschedulable: false, pressure: [], pods: 9,
  cpu: { capMilli: 2000, usedMilli: 500 }, mem: { capBytes: 4 * 1024 ** 3, usedBytes: 1024 ** 3 },
  fixes: [{ action: 'cordon', label: 'Cordon', target: { kind: 'Node', name: 'k3s-a' } }, { action: 'drain', label: 'Drain', target: { kind: 'Node', name: 'k3s-a' } }], ...o,
})

test('a pod in trouble says its state and reason in words, shows its last lines and offers its fixes to an admin', () => {
  const html = renderToStaticMarkup(<ProblemCard p={pod({ state: 'crashloop', reason: 'CrashLoopBackOff', message: 'The container app keeps stopping: Error (exit code 3).', restarts: 4, lastLines: ['starting', 'config file not found'] })} admin busy={null} onFix={noop} />)
  assert.match(html, /aria-label="Crash loop: demo\/web-1"/)
  assert.match(html, /CrashLoopBackOff/)
  assert.match(html, /exit code 3/)
  assert.match(html, /4 restarts/)
  assert.match(html, /config file not found/)
  assert.match(html, /Roll back to the previous version/)
  assert.match(html, /data-kind="delete-pod"/)
})

test('below admin the same card has no buttons and never had the log lines (the API leaves them out)', () => {
  const html = renderToStaticMarkup(<ProblemCard p={pod()} admin={false} busy={null} onFix={noop} />)
  assert.match(html, /Image cannot be pulled/)
  assert.ok(!/<button/.test(html))
  assert.deepEqual(visibleFixes([rollback], false), [])
})

test('a busy action shows as working and every other button waits', () => {
  const html = renderToStaticMarkup(<ProblemCard p={pod()} admin busy="rollback:demo/web" onFix={noop} />)
  assert.match(html, /Working…/)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
})

test('a node card: rings, Ready or not with the reason, cordoned, its facts and its actions', () => {
  const ok = renderToStaticMarkup(<NodeCard n={node()} admin busy={null} onFix={noop} />)
  assert.match(ok, /aria-label="CPU 25%, memory 25%"/)
  assert.match(ok, />Ready</)
  assert.match(ok, /500m of 2 cores/)
  assert.match(ok, /1\.0 GiB of 4\.0 GiB/)
  assert.match(ok, /data-state="ok"/)
  assert.match(ok, />Cordon</)
  const down = renderToStaticMarkup(<NodeCard n={node({ ready: false, reason: 'Kubelet stopped posting node status.', unschedulable: true, cpu: { capMilli: 2000, usedMilli: null } })} admin={false} busy={null} onFix={noop} />)
  assert.match(down, /Not ready/)
  assert.match(down, /Kubelet stopped posting/)
  assert.match(down, /Cordoned/)
  assert.match(down, /use not read yet/)
  assert.match(down, /data-state="down"/)
})

test('a workload tile: ready against desired, its bar and its state', () => {
  const w: WorkloadRow = { kind: 'Deployment', namespace: 'demo', name: 'web', desired: 3, ready: 1, updated: 1, available: 1, images: ['nginx:1.29-alpine'], problem: '1 of 3 ready',
    fixes: [{ action: 'restart', label: 'Restart', target: { kind: 'Deployment', namespace: 'demo', name: 'web' } }, { action: 'scale', label: 'Scale', target: { kind: 'Deployment', namespace: 'demo', name: 'web' } }] }
  const html = renderToStaticMarkup(<ul><WorkloadTile w={w} admin busy={null} onFix={noop} /></ul>)
  assert.match(html, /aria-label="Deployment demo\/web: 1 of 3 ready"/)
  assert.match(html, /width:33%/)
  assert.match(html, /data-state="warn"/)
  assert.match(html, /nginx:1\.29-alpine/)
  assert.match(html, />Scale</)
})

test('the network view lists ingresses with a link to open and exposed services with their addresses', () => {
  const html = renderToStaticMarkup(<NetworkView
    ingresses={[{ namespace: 'demo', name: 'web', hosts: ['*'], addresses: ['10.0.0.40'], tls: false, paths: ['*/ → web:80'] }]}
    services={[{ namespace: 'kube-system', name: 'traefik', type: 'LoadBalancer', clusterIP: '10.43.0.10', external: ['10.0.0.40'], ports: ['80:31960/TCP'] }]} />)
  assert.match(html, /href="http:\/\/10\.0\.0\.40\/"/)
  assert.match(html, /\*\/ → web:80/)
  assert.match(html, /1 exposed/)
  assert.deepEqual(ingressLinks({ namespace: 'a', name: 'b', hosts: ['app.example.com'], addresses: [], tls: true, paths: [] }), ['https://app.example.com/'])
})

test('the confirmations and the drain plan are said in words before anything runs', () => {
  assert.equal(confirmText(rollback), 'web goes back to the pod template it had before the last change.')
  assert.match(confirmText({ action: 'scale', label: 'Scale', target: { kind: 'Deployment', namespace: 'demo', name: 'web' } }, 0), /Every pod of it stops/)
  const plan = { node: 'k3s-a', move: ['demo/web-1', 'demo/web-2'], stay: ['kube-system/svclb-1'], lost: ['demo/lonely'], localData: ['demo/web-2'] }
  const w = drainWords(plan)
  assert.match(w[0], /2 pods move/)
  assert.ok(w.some(x => /1 DaemonSet pod stay/.test(x)))
  assert.ok(w.some(x => /deleted for good: demo\/lonely/.test(x)))
  assert.ok(w.some(x => /cordoned first/.test(x)))
  assert.match(renderToStaticMarkup(<DrainSummary plan={plan} />), /Deleted for good: demo\/lonely/)
})

test('numbers and words', () => {
  assert.equal(share(1, 4), 0.25); assert.equal(share(null, 4), null); assert.equal(share(1, 0), null)
  assert.equal(cores(1500), '1.5 cores'); assert.equal(cores(250), '250m'); assert.equal(gib(512 * 1024 ** 2), '512 MiB')
  assert.equal(healthWord({ state: 'bad', reasons: [] }), 'Not healthy')
})
