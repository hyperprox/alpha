// K3s in the Catalogue: the two recipes, the pinned release (binary and install script checked by SHA-256, nothing
// "latest"), an unprivileged container (keyctl set from the node, read back), the agent's join token kept out of the
// environment, the server address check, the agent preview (a server HyperProx looks after, with its token), the
// install env, the setup steps with a stand-in service, placement spreading a cluster over nodes, the shared scan's
// probe and the route roles. Nothing real is contacted; every name and address is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOGUE, findRecipe, checkOptions } from '../src/lib/catalogue'
import { installScript } from '../src/lib/install-script'
import {
  K3S_RECIPE, K3S_AGENT_RECIPE, K3S_VERSION, K3S_SHA256, K3S_INSTALL_SH_SHA256, parseServer, checkAgentOptions,
} from '../src/lib/k3s/recipe'
import { prepareScript, configProblems, k3sPreview, k3sInstallEnv, k3sRunSetup, k3sSteps, k3sPrepare } from '../src/lib/k3s/catalogue'
import { READ_LOGIN_SCRIPT, parseLoginOutput } from '../src/lib/k3s/accounts'
import { scoreNodes } from '../src/lib/wizard-placement'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { PROBES } from '@hyperprox/hardware/service-probes'

test('both K3s recipes are in the catalogue, not offered to the AI wizard, and use their own setup', () => {
  for (const id of ['k3s', 'k3s-agent']) {
    const r = findRecipe(id)!
    assert.ok(r, id)
    assert.equal(r.setup, 'k3s')
    assert.equal(r.wizard, false)
    assert.equal(r.needsDocker, false)
    assert.equal(r.install.kind, 'script')
  }
  assert.ok(CATALOGUE.filter(r => r.id === 'k3s').length === 1)
  assert.deepEqual(K3S_AGENT_RECIPE.spreadWith, ['k3s', 'k3s-agent'])
  assert.equal(K3S_RECIPE.defaults.swapMb, 0, 'Kubernetes expects no swap')
})

test('the release is pinned: version, both binary hashes and the install script hash, all checked before anything runs', () => {
  assert.match(K3S_VERSION, /^v\d+\.\d+\.\d+\+k3s\d+$/)
  for (const h of [K3S_SHA256.amd64, K3S_SHA256.arm64, K3S_INSTALL_SH_SHA256]) assert.match(h, /^[0-9a-f]{64}$/)
  const s = installScript(K3S_RECIPE, 'debian', { ...checkOptions(K3S_RECIPE, {}).values, K3S_NODE_IP: '10.0.0.40' })
  const v = K3S_VERSION.replace('+', '%2B')
  assert.ok(s.includes(`https://github.com/k3s-io/k3s/releases/download/${v}/$BIN`))
  assert.ok(s.includes(`https://raw.githubusercontent.com/k3s-io/k3s/${v}/install.sh`))
  assert.ok(s.includes(K3S_SHA256.amd64) && s.includes(K3S_SHA256.arm64) && s.includes(K3S_INSTALL_SH_SHA256))
  assert.match(s, /sha256sum -c --quiet[\s\S]*install -m 755 k3s\.bin/, 'the binary is checked before it is installed')
  assert.match(s, /k3s-install\.sh" \| sha256sum -c --quiet[\s\S]*sh \/tmp\/k3s-install\.sh server/, 'the script is checked before it runs')
  assert.match(s, /INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="\$V"/)
  assert.ok(!/get\.k3s\.io|latest|curl[^\n]*\| *sh/.test(s), 'never an unpinned script piped into a shell')
})

test('the server runs unprivileged: user-namespace kubelet, host-gw flannel, its address in the certificate, private config', () => {
  const s = installScript(K3S_RECIPE, 'debian', { ...checkOptions(K3S_RECIPE, {}).values, K3S_NODE_IP: '10.0.0.40' })
  assert.match(s, /feature-gates=KubeletInUserNamespace=true/)
  assert.match(s, /flannel-backend: host-gw/)
  assert.match(s, /conntrack-max-per-core=0/)
  assert.match(s, /write-kubeconfig-mode: "0600"/)
  assert.match(s, /tls-san:/)
  assert.match(s, /umask 077\n\{/, 'config.yaml is written root-only')
  assert.ok(!/\bprivileged|apparmor|cgroup2\.devices|lxc\./i.test(s), 'nothing here widens the container')
  assert.match(s, /grep -q ' Ready'/, 'it waits for the node to be Ready, not just the service')
  // Built-ins off only when asked.
  const off = installScript(K3S_RECIPE, 'debian', checkOptions(K3S_RECIPE, { K3S_TRAEFIK: '0', K3S_SERVICELB: 'no' }).values)
  assert.match(off, /export K3S_TRAEFIK='0'/)
  assert.match(off, /export K3S_SERVICELB='0'/)
})

test('the agent keeps its join token out of every child environment and writes it only to the root-only config', () => {
  const s = installScript(K3S_AGENT_RECIPE, 'debian', { K3S_SERVER: '10.0.0.40:6443', K3S_NODE_IP: '10.0.0.41', K3S_SERVER_URL: 'https://10.0.0.40:6443', K3S_TOKEN: 'K10abc::server:made-up-token' })
  assert.match(s, /TOKEN="\$K3S_TOKEN"; export -n K3S_TOKEN/)
  assert.ok(s.indexOf('export -n K3S_TOKEN') < s.indexOf('apt-get update'), 'taken out before anything else runs')
  assert.match(s, /printf 'token: %s\\n' "\$TOKEN"/)
  assert.match(s, /sh \/tmp\/k3s-install\.sh agent/)
  assert.ok(!/echo[^\n]*\$TOKEN/.test(s), 'the token is never echoed')
})

test('an agent names its server as host[:port]; loopback, link-local and nonsense are refused', () => {
  assert.deepEqual(parseServer('10.0.0.40'), { host: '10.0.0.40', port: 6443, url: 'https://10.0.0.40:6443' })
  assert.deepEqual(parseServer('https://k3s.example.lan:7443/'), { host: 'k3s.example.lan', port: 7443, url: 'https://k3s.example.lan:7443' })
  for (const bad of ['', '127.0.0.1', 'localhost:6443', '169.254.1.1', '10.0.0.400', '10.0.0.40:99999', 'http://10.0.0.40', '10.0.0.40;rm -rf /']) assert.equal(parseServer(bad), null, bad)
  assert.deepEqual(checkAgentOptions({ K3S_SERVER: '10.0.0.40:6443' }), [])
  assert.equal(checkOptions(K3S_AGENT_RECIPE, { K3S_SERVER: 'not an address' }).errors.length, 1)
  assert.match(checkOptions(K3S_AGENT_RECIPE, {}).errors.join(' '), /K3s server is required/)
})

test('prepare sets keyctl and nesting from the node, and the read-back refuses anything less or privileged', async () => {
  const s = prepareScript(240)
  assert.match(s, /pct set "\$V" --features nesting=1,keyctl=1/)
  assert.ok(!/unprivileged 0|--unprivileged|lxc\./.test(s))
  assert.throws(() => prepareScript(5))
  assert.deepEqual(configProblems({ features: 'nesting=1,keyctl=1', unprivileged: 1 }), [])
  assert.equal(configProblems({ features: 'nesting=1', unprivileged: 1 }).length, 1)
  assert.equal(configProblems({ features: 'keyctl=1,nesting=1', unprivileged: 0 }).length, 1)
  const ran: string[] = []
  const ok = await k3sPrepare({ node: 'pve1', vmid: 240 }, {
    service: () => { throw new Error('unused') }, nodeRun: async (_n, sc) => { ran.push(sc); return { code: 0, output: '@@k3s prepared\n' } },
    client: { fetchStrict: async <T>() => ({ features: 'nesting=1,keyctl=1', unprivileged: 1 }) as T },
  })
  assert.match(ok, /unprivileged/)
  assert.equal(ran.length, 1)
  await assert.rejects(k3sPrepare({ node: 'pve1', vmid: 240 }, {
    service: () => { throw new Error('unused') }, nodeRun: async () => ({ code: 0, output: '@@k3s prepared\n' }),
    client: { fetchStrict: async <T>() => ({ features: 'nesting=1', unprivileged: 1 }) as T },
  }), /keyctl is not on/)
})

test('the login read prints the kubeconfig and the token between markers; anything else reads as not found', () => {
  assert.match(READ_LOGIN_SCRIPT, /base64 -w0 \/etc\/rancher\/k3s\/k3s\.yaml/)
  const kc = 'apiVersion: v1\nkind: Config\n'
  const out = `@@k3s kubeconfig\n${Buffer.from(kc).toString('base64')}\n@@k3s token\n${Buffer.from('K10made-up::server:abcdefabcdef').toString('base64')}\n@@k3s hostname k3s-a\n@@k3s end\n`
  const p = parseLoginOutput(out)
  assert.ok(p.found)
  if (p.found) { assert.equal(p.kubeconfig, kc); assert.equal(p.nodeToken, 'K10made-up::server:abcdefabcdef'); assert.equal(p.hostname, 'k3s-a') }
  assert.deepEqual(parseLoginOutput('@@k3s none\n'), { found: false })
  assert.deepEqual(parseLoginOutput(`@@k3s kubeconfig\n${Buffer.from(kc).toString('base64')}\n`), { found: false }, 'cut short: not trusted')
})

const fakeService = (o: { url?: string; token?: string | null } = {}) => {
  const calls: string[] = []
  const svc: any = {
    calls,
    byServerUrl: async (url: string) => (url === (o.url ?? 'https://10.0.0.40:6443') ? { meta: { id: 'k00000001', name: 'lab' }, nodeToken: o.token === undefined ? 'K10made-up::server:abcdefabcdef' : o.token } : null),
    connect: async (c: any) => { calls.push(`connect ${c.address} ${c.via} ${c.guest.vmid}`); return { id: 'k00000001', name: c.name } },
    reading: async () => ({ version: { current: 'v1.37.1+k3s1' }, nodes: [{ name: 'k3s-a', ready: true }], counts: { running: 7 } }),
    waitNodeReady: async (_id: string, n: string) => { calls.push(`wait ${n}`); return true },
    addAgent: async (_id: string, g: any) => { calls.push(`agent ${g.vmid}`) },
  }
  return svc
}

test('an agent preview needs a server HyperProx looks after and its join token in the vault', async () => {
  assert.deepEqual(await k3sPreview('k3s', {}, { service: () => fakeService() }), { errors: [], checks: [] })
  const ok = await k3sPreview('k3s-agent', { K3S_SERVER: '10.0.0.40' }, { service: () => fakeService() })
  assert.deepEqual(ok.errors, [])
  assert.match(ok.checks[0], /Joins lab at https:\/\/10\.0\.0\.40:6443/)
  assert.match((await k3sPreview('k3s-agent', { K3S_SERVER: '10.0.0.99' }, { service: () => fakeService() })).errors[0], /does not look after/)
  assert.match((await k3sPreview('k3s-agent', { K3S_SERVER: '10.0.0.40' }, { service: () => fakeService({ token: null }) })).errors[0], /join token is not in the vault/)
})

test('the install env: the address for the server; the server and its token from the vault for an agent', async () => {
  assert.deepEqual(await k3sInstallEnv('k3s', { ip: '10.0.0.40', options: {} }, { service: () => fakeService() }), { K3S_NODE_IP: '10.0.0.40' })
  const a = await k3sInstallEnv('k3s-agent', { ip: '10.0.0.41', options: { K3S_SERVER: '10.0.0.40:6443' } }, { service: () => fakeService() })
  assert.equal(a.K3S_SERVER_URL, 'https://10.0.0.40:6443')
  assert.equal(a.K3S_TOKEN, 'K10made-up::server:abcdefabcdef')
  await assert.rejects(k3sInstallEnv('k3s-agent', { options: { K3S_SERVER: '10.0.0.40' } }, { service: () => fakeService({ token: null }) }), /no longer in the vault/)
})

test('server setup: the login read in the guest, connected with the container as its guest, checked, an agent offered next', async () => {
  const svc = fakeService()
  const steps: Record<string, any> = {}
  const kc = 'apiVersion: v1\n'
  const out = await k3sRunSetup({ recipeId: 'k3s', ip: '10.0.0.40', vmid: 240, hostname: 'k3s-a', owner: 'admin@example.com', options: {} },
    id => (steps[id] = { status: 'running' }), { service: () => svc, sh: async () => ({ code: 0, output: `@@k3s kubeconfig\n${Buffer.from(kc).toString('base64')}\n@@k3s end\n` }) })
  assert.equal(out.url, 'https://10.0.0.40:6443')
  assert.deepEqual(Object.keys(steps), k3sSteps('k3s').map(s => s.id))
  assert.ok(Object.values(steps).every(s => s.status === 'done'))
  assert.deepEqual(svc.calls, ['connect https://10.0.0.40:6443 catalogue 240'])
  assert.deepEqual(out.followUp, { recipeId: 'k3s-agent', label: 'Add an agent on another node', url: 'https://10.0.0.40:6443', options: { K3S_SERVER: '10.0.0.40:6443' } })
  await assert.rejects(k3sRunSetup({ recipeId: 'k3s', ip: '10.0.0.40', vmid: 240, hostname: 'k3s-a', owner: 'x', options: {} }, id => (steps[id] = { status: 'running' }),
    { service: () => svc, sh: async () => ({ code: 0, output: '@@k3s none\n' }) }), /could not be read/)
})

test('agent setup waits for its node to be Ready and records it on the cluster', async () => {
  const svc = fakeService()
  const out = await k3sRunSetup({ recipeId: 'k3s-agent', ip: '10.0.0.41', vmid: 241, hostname: 'k3s-b', owner: 'x', options: { K3S_SERVER: '10.0.0.40' } },
    () => ({ status: 'running' }), { service: () => svc, sh: async () => { throw new Error('the agent setup runs nothing in the guest') } })
  assert.deepEqual(svc.calls, ['wait k3s-b', 'agent 241'])
  assert.equal(out.followUp?.options.K3S_SERVER, '10.0.0.40:6443')
})

test('placement spreads a cluster: a node already running part of it is counted against, not refused', () => {
  const node = (n: string) => ({ node: n, online: true, cores: 8, memTotalMb: 32768, memUsedMb: 8192, cpuLoad: 0.2, hasLogin: true, runningGuests: 2 })
  const st = (n: string) => ({ node: n, storage: 'fast', type: 'rbd', shared: true, freeGb: 500, totalGb: 1000, content: ['rootdir'], active: true })
  const v = scoreNodes([node('pve1'), node('pve2')] as any, [st('pve1'), st('pve2')] as any,
    { cores: 2, memoryMb: 4096, diskGb: 20, avoidNodes: { nodes: ['pve1'], what: 'part of this K3s cluster' } })
  assert.equal(v[0].node, 'pve2')
  const p1 = v.find(x => x.node === 'pve1')!
  assert.ok(p1.eligible)
  assert.ok(p1.notes.some(n => /part of this K3s cluster/.test(n)))
})

test('the shared scan finds a Kubernetes API by its own 401 Status and sends people to the K3s page', () => {
  const p = (PROBES as any[]).find(x => x.key === 'k3s')
  assert.equal(p.port, 6443)
  assert.equal(p.scheme, 'https')
  assert.equal(p.page, '/plugins/k3s')
  const body = JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: 'Unauthorized', reason: 'Unauthorized', code: 401 }, null, 2)
  assert.ok(p.match(401, body))
  assert.ok(!p.match(200, body))
  assert.ok(!p.match(401, '<html>Unauthorized</html>'))
})

test('K3s routes: reads are viewer, logs and the found list admin, every change admin with the master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/k3s/clusters'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/k3s/clusters/k12345678/reading'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/k3s/clusters/k12345678/logs'), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/k3s/waiting'), 'admin')
  for (const [m, p] of [['POST', '/api/plugins/k3s/clusters'], ['PUT', '/api/plugins/k3s/clusters/k12345678'], ['DELETE', '/api/plugins/k3s/clusters/k12345678'],
    ['POST', '/api/plugins/k3s/clusters/k12345678/actions/restart'], ['POST', '/api/plugins/k3s/clusters/k12345678/actions/drain']]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  assert.equal(requiredRole('POST', '/api/plugins/k3s/clusters/k12345678/drain-preview'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/plugins/k3s/clusters/k12345678/drain-preview'), false, 'the preview only reads')
})
