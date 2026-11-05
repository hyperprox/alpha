// End to end, opt-in (HP_E2E_DOCKER=1; needs Docker and internet): a throwaway Debian container, the real
// Tailscale repository and package, the real Tailscale API client against a mocked control plane, and the
// real service. Only `tailscale up`/`status` are a recording stand-in (there is no control plane to join),
// which is what lets the test prove the key arrived on stdin and never in argv, the log, or on disk.
// The container is removed afterwards whatever happens.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemoteAccessService, type RemoteJob } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import { TailscaleClient } from '../src/lib/remote/tailscale'
import { installScript, osSupport, parseFacts, DETECT_SCRIPT } from '../src/lib/remote/scripts'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'

const ENABLED = process.env.HP_E2E_DOCKER === '1'
const NAME = `hp-remote-e2e-${randomBytes(4).toString('hex')}`
const IMAGE = process.env.HP_E2E_IMAGE ?? 'debian:trixie'
const KEY = `tskey-auth-e2e${randomBytes(12).toString('hex')}`
const KEY_SHA = createHash('sha256').update(KEY).digest('hex')

function docker(args: string[], input?: string, onData?: (s: string) => void): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const take = (d: Buffer) => { const s = d.toString(); out += s; onData?.(s) }
    p.stdout.on('data', take); p.stderr.on('data', take)
    p.on('error', reject)
    p.on('close', code => resolve({ code: code ?? -1, output: out }))
    p.stdin.end(input ?? '')
  })
}

// The mocked control plane: Tailscale's API, as much of it as the service uses.
const api = { minted: 0, revoked: [] as string[], deleted: [] as string[], devices: [] as any[], routes: [] as string[] }
let server: http.Server
let base = ''

// Stand-ins, installed only after the real package: systemd's control (Docker runs no init) and the two
// client verbs that need a control plane. Everything else falls through to the real /usr/bin/tailscale.
const SHIMS = `set -e
mkdir -p /run/systemd/system /hp-e2e
cat > /usr/local/sbin/systemctl <<'X'
#!/bin/sh
# A stand-in that remembers enabled/active per unit, so a restore can be checked.
echo "$*" >> /hp-e2e/systemctl.log
d=/hp-e2e/units; mkdir -p $d
cmd=$1; shift
case "$cmd" in
  enable)  for u; do case "$u" in -*) ;; *) echo enabled > $d/$u.enabled ;; esac; done ;;
  disable) for u; do case "$u" in -*) ;; *) echo disabled > $d/$u.enabled ;; esac; done ;;
  start|restart) for u; do case "$u" in -*) ;; *) echo active > $d/$u.active ;; esac; done ;;
  stop)    for u; do case "$u" in -*) ;; *) echo inactive > $d/$u.active ;; esac; done ;;
  is-enabled) s=$(cat $d/$1.enabled 2>/dev/null || echo disabled); echo $s; [ "$s" = enabled ]; exit $? ;;
  is-active) q=0; [ "$1" = --quiet ] && { q=1; shift; }; s=$(cat $d/$1.active 2>/dev/null || echo inactive); [ $q = 1 ] || echo $s; [ "$s" = active ]; exit $? ;;
esac
exit 0
X
chmod +x /usr/local/sbin/systemctl
`
const TS_SHIM = `cat > /usr/local/bin/tailscale <<'X'
#!/bin/bash
case "$1" in
  up)
    printf '%s\\n' "$@" > /hp-e2e/up-argv
    sha256sum | cut -d' ' -f1 > /hp-e2e/up-stdin-sha
    echo "Success." ;;
  status)
    echo '{"BackendState":"Running","Version":"'"$(/usr/bin/tailscale version | head -n1)"'","Self":{"ID":"nE2E","HostName":"e2e-web","TailscaleIPs":["100.64.0.42"]}}' ;;
  *) exec /usr/bin/tailscale "$@" ;;
esac
X
chmod +x /usr/local/bin/tailscale`

const machine: Machine = { id: 'lxc-990', kind: 'lxc', name: 'e2e-web', node: 'pve-test', vmid: 990, running: true, ostype: 'debian' }
let shimmed = false
// The container's node exists only as a canned snapshot: routing on a guest reads the cluster's networks from it.
const NODE_SNAPSHOT = ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_NET corosync 192.0.2.12', 'HP_NET own 192.0.2.11/24', 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')
const pveNode: Machine = { id: 'node-pve-test', kind: 'node', name: 'pve-test', node: 'pve-test', running: true, address: '192.0.2.11' }
const exec: RemoteExecutor = {
  listMachines: async () => [machine, pveNode],
  run: async (m, script, o) => {
    if (m.kind === 'node') return { code: 0, output: NODE_SNAPSHOT, timedOut: false }
    // After the package install, before `up`: put the client stand-in in front of the real binary.
    if (!shimmed && script.includes('HP_KEY=')) { await docker(['exec', '-i', NAME, 'bash', '-s'], TS_SHIM); shimmed = true }
    const r = await docker(['exec', '-i', NAME, 'bash', '-s'], script, o?.onData)
    return { code: r.code, output: r.output, timedOut: false }
  },
  lxcConfig: async () => ({}),
  setLxcConfig: async () => { throw new Error('not in this test') },
  firewallState: async () => { throw new Error('not in this test') },
  addFirewallRule: async () => { throw new Error('not in this test') },
  hostKeyTarget: async () => { throw new Error('not in this test') },
  probeHostKey: async () => { throw new Error('not in this test') },
  pinnedHostKey: async () => null,
  pinHostKey: async () => { throw new Error('not in this test') },
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 1200; i++) {
    const j = svc.getJob(job.id)!
    if (j.status !== 'running') return j
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('job did not settle in 10 minutes')
}

before(async () => {
  if (!ENABLED) return
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const send = (s: number, j: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
      if (req.headers.authorization !== 'Bearer tskey-api-e2e') return send(401, { message: 'bad token' })
      if (req.method === 'POST' && url.pathname === '/api/v2/tailnet/-/keys') {
        const b = JSON.parse(body)
        assert.equal(b.capabilities.devices.create.reusable, false)
        api.minted++
        // The device appears at the provider once the key is minted (as it would after `up`).
        api.devices = [{ id: 'd-e2e', nodeId: 'nE2E', name: 'e2e-web.tail.ts.net', hostname: 'e2e-web', addresses: ['100.64.0.42'], connectedToControl: true, lastSeen: new Date().toISOString(), clientVersion: '1.0.0' }]
        return send(200, { id: 'k-e2e', key: KEY, expires: new Date(Date.now() + 600_000).toISOString() })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/v2/tailnet/-/keys/')) { api.revoked.push(url.pathname.split('/').pop()!); return send(200, {}) }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v2/tailnet/-/keys/')) {
        const id = url.pathname.split('/').pop()!
        return api.revoked.includes(id) ? send(404, { message: 'not found' }) : send(200, { id, expires: new Date(Date.now() + 600_000).toISOString() })
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/tailnet/-/devices') return send(200, { devices: api.devices })
      if (url.pathname === '/api/v2/device/d-e2e/routes') {
        if (req.method === 'POST') { api.routes = JSON.parse(body).routes; return send(200, {}) }
        return send(200, { advertisedRoutes: api.routes, enabledRoutes: api.routes })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/v2/device/')) { api.deleted.push(url.pathname.split('/').pop()!); api.devices = []; return send(200, {}) }
      send(404, { message: 'not mocked' })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' })
  execFileSync('docker', ['run', '-d', '--rm', '--name', NAME, '--label', 'hyperprox-test=remote-e2e', IMAGE, 'sleep', '3600'], { stdio: 'ignore' })
  const r = await docker(['exec', '-i', NAME, 'bash', '-s'], SHIMS)
  assert.equal(r.code, 0, r.output)
})

after(async () => {
  if (!ENABLED) return
  try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* already gone */ }
  server?.close()
})

test('e2e: real repository and package, key on stdin only, device recorded, then a clean uninstall', { skip: !ENABLED, timeout: 15 * 60_000 }, async () => {
  const store = new MemoryRemoteStore()
  const provider = new TailscaleClient({ apiToken: 'tskey-api-e2e' }, { base })
  const svc = new RemoteAccessService({ store, exec, provider: async id => (id === 'tailscale' ? provider : null), providerSettings: async () => ({ tags: [] }), settleMs: 0 })

  // No /dev/net/tun in a plain Docker container: refused with the way forward, nothing installed.
  const refused = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-990'] }, 'e2e'))
  assert.equal(refused.status, 'failed')
  assert.match(refused.steps[0].detail ?? '', /\/dev\/net\/tun/)
  assert.equal(api.minted, 0)

  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-990'], mode: 'userspace' }, 'e2e'))
  assert.equal(job.status, 'completed', `${job.error}\n${job.log.slice(-3000)}`)
  assert.match(job.steps[0].detail ?? '', /Connected as 100\.64\.0\.42/)

  // The real package from the official repository.
  const v = await docker(['exec', NAME, '/usr/bin/tailscale', 'version'])
  assert.equal(v.code, 0, v.output)
  assert.match((await docker(['exec', NAME, 'cat', '/etc/apt/sources.list.d/tailscale.list'])).output, /pkgs\.tailscale\.com\/stable\/debian trixie/)
  assert.match((await docker(['exec', NAME, 'cat', '/etc/default/tailscaled'])).output, /--tun=userspace-networking/)

  // The key: on stdin (hash matches), not in argv, safe flags present, nowhere on disk, not in the log.
  assert.equal((await docker(['exec', NAME, 'cat', '/hp-e2e/up-stdin-sha'])).output.trim(), KEY_SHA)
  const argv = (await docker(['exec', NAME, 'cat', '/hp-e2e/up-argv'])).output
  assert.doesNotMatch(argv, new RegExp(KEY))
  for (const f of ['--auth-key=file:/dev/stdin', '--accept-dns=false', '--accept-routes=false']) assert.ok(argv.includes(f), f)
  const grep = await docker(['exec', NAME, 'bash', '-c', `grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -F '${KEY}' / 2>/dev/null; true`])
  assert.equal(grep.output.trim(), '', `key found on disk: ${grep.output}`)
  assert.doesNotMatch(job.log, new RegExp(KEY))
  assert.deepEqual(api.revoked, ['k-e2e'], 'the key was revoked once used')
  assert.equal(store.pending.size, 0, 'and the provider confirmed it, so nothing is left to sweep')
  assert.equal((await store.get('lxc-990', 'tailscale'))?.deviceId, 'd-e2e')

  // The stand-in goes first, or uninstall would rightly report a `tailscale` still on PATH.
  await docker(['exec', NAME, 'rm', '-f', '/usr/local/bin/tailscale'])
  const gone = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-990'] }, 'e2e'))
  assert.equal(gone.status, 'completed', `${gone.error}\n${gone.log.slice(-2000)}`)
  assert.equal((await docker(['exec', NAME, 'test', '-e', '/usr/bin/tailscale'])).code, 1, 'package removed')
  assert.equal((await docker(['exec', NAME, 'test', '-e', '/etc/apt/sources.list.d/tailscale.list'])).code, 1, 'repository removed')
  assert.deepEqual(api.deleted, ['d-e2e'])
  assert.equal(await store.get('lxc-990', 'tailscale'), null)
  await svc.close()
})

test('e2e: a replace that fails puts the old client back exactly: version, state, service, and wipes the copy', { skip: !ENABLED, timeout: 15 * 60_000 }, async () => {
  const sh = async (script: string) => { const r = await docker(['exec', '-i', NAME, 'bash', '-s'], script); assert.equal(r.code, 0, r.output); return r.output.trim() }
  // An existing Tailscale that HyperProx did not install: an older version, disabled and stopped, with state.
  const support = osSupport(parseFacts(await sh(DETECT_SCRIPT)))
  assert.ok(support.ok)
  if (!support.ok) return
  await sh(installScript('tailscale', support, 'kernel'))
  const old = await sh(`apt-cache madison tailscale | awk 'NR==3 {print $3}'`)
  assert.ok(old, 'an older version is on offer')
  await sh(`apt-get install -y -qq --allow-downgrades tailscale=${old} >/dev/null && systemctl disable tailscaled && systemctl stop tailscaled && mkdir -p /var/lib/tailscale && echo kept > /var/lib/tailscale/hp-marker`)
  // `up` fails, so the replace must be rolled back.
  await sh(`cat > /usr/local/bin/tailscale <<'X'\n#!/bin/bash\n[ "$1" = up ] && { echo "backend error"; exit 1; }\nexec /usr/bin/tailscale "$@"\nX\nchmod +x /usr/local/bin/tailscale`)
  shimmed = true
  api.revoked.length = 0
  const store = new MemoryRemoteStore()
  const provider = new TailscaleClient({ apiToken: 'tskey-api-e2e' }, { base })
  const svc = new RemoteAccessService({ store, exec, provider: async id => (id === 'tailscale' ? provider : null), providerSettings: async () => ({ tags: [] }), settleMs: 0 })
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-990'], mode: 'userspace', existing: 'replace' }, 'e2e'))
  assert.equal(job.status, 'failed')
  assert.match(job.steps[0].detail ?? '', /put the previous client and its state back/, `${job.steps[0].detail}\n${job.log.slice(-2000)}`)
  assert.equal(await sh(`dpkg-query -W -f='\${Version}' tailscale`), old, 'the exact earlier version')
  assert.equal(await sh('cat /var/lib/tailscale/hp-marker'), 'kept')
  assert.equal(await sh('cat /hp-e2e/units/tailscaled.enabled'), 'disabled')
  assert.equal(await sh('cat /hp-e2e/units/tailscaled.active'), 'inactive')
  assert.equal(await sh('test -e /var/lib/hyperprox-remote-access/tailscale && echo still || echo gone'), 'gone', 'the copy was wiped')
  assert.doesNotMatch(await sh('cat /etc/default/tailscaled'), /userspace/, 'the old defaults file is back')
  assert.deepEqual(api.revoked, ['k-e2e'])
  assert.equal(store.pending.size, 0)
  assert.equal(await store.get('lxc-990', 'tailscale'), null)
  await svc.close()
})

test('e2e: VPN settings against a real tailscaled: accept-dns, accept-routes, SSH, exit node and subnet routes, read back from the client', { skip: !ENABLED, timeout: 15 * 60_000 }, async () => {
  const sh = async (script: string) => { const r = await docker(['exec', '-i', NAME, 'bash', '-s'], script); assert.equal(r.code, 0, r.output); return r.output.trim() }
  // A real daemon, in userspace mode, never signed in: settings still apply locally and read back.
  await sh(`rm -f /usr/local/bin/tailscale
cat > /usr/local/sbin/sysctl <<'X'\n#!/bin/sh\necho "$*" >> /hp-e2e/sysctl.log\nX\nchmod +x /usr/local/sbin/sysctl
mkdir -p /run/tailscale /var/lib/tailscale
nohup tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket=/run/tailscale/tailscaled.sock >/hp-e2e/tailscaled.log 2>&1 &
for i in $(seq 30); do tailscale debug prefs >/dev/null 2>&1 && break; sleep 1; done
tailscale debug prefs >/dev/null`)
  const store = new MemoryRemoteStore()
  await store.upsert({ machineId: 'lxc-990', provider: 'tailscale', deviceId: 'd-e2e', nodeKey: 'nE2E', hostname: 'e2e-web', address: '100.64.0.42', mode: 'userspace', version: null,
    routes: [], exitNode: false, routeIds: [], adopted: true, forwardingBefore: null, connected: true, checkedAt: null, lastError: null })
  const provider = new TailscaleClient({ apiToken: 'tskey-api-e2e' }, { base })
  const svc = new RemoteAccessService({ store, exec, provider: async id => (id === 'tailscale' ? provider : null), providerSettings: async () => ({ tags: [] }), settleMs: 0 })
  const run = async (prefs: Record<string, unknown>) => settle(svc, svc.startJob({ action: 'configure', provider: 'tailscale', machineIds: ['lxc-990'], prefs, acknowledge: true }, 'e2e'))

  const a = await run({ acceptDns: true, acceptRoutes: true, ssh: true })
  assert.equal(a.status, 'completed', `${a.error}\n${a.log.slice(-2000)}`)
  const prefs = JSON.parse(await sh(`tailscale debug prefs | grep -E '"(CorpDNS|RouteAll|RunSSH)"' | tr -d '\\t' | sed 's/,$//' | paste -sd, | sed 's/^/{/; s/$/}/'`))
  assert.deepEqual(prefs, { RouteAll: true, CorpDNS: true, RunSSH: true }, 'the real client has them')
  assert.doesNotMatch(a.log, /privkey:|nlpriv:/, 'the read-back never carries the node keys')

  const b = await run({ advertiseExitNode: true, subnets: ['198.51.100.0/24'] })
  assert.equal(b.status, 'completed', `${b.error}\n${b.log.slice(-2000)}`)
  const adv = await sh(`tailscale debug prefs | tr -d ' \\t\\n' | grep -oE '"AdvertiseRoutes":\\[[^]]*\\]'`)
  for (const r of ['198.51.100.0/24', '0.0.0.0/0', '::/0']) assert.ok(adv.includes(r), `${r} in ${adv}`)
  assert.deepEqual([...api.routes].sort(), ['0.0.0.0/0', '198.51.100.0/24', '::/0'], 'approved in the tailnet through the API')

  const c = await run({ acceptDns: false, ssh: false, advertiseExitNode: false, subnets: [] })
  assert.equal(c.status, 'completed', `${c.error}\n${c.log.slice(-2000)}`)
  const off = await sh(`tailscale debug prefs | tr -d ' \\t\\n'`)
  assert.match(off, /"CorpDNS":false/); assert.match(off, /"RunSSH":false/); assert.match(off, /"AdvertiseRoutes":null|"AdvertiseRoutes":\[\]/)
  assert.deepEqual(api.routes, [])
  await sh('pkill tailscaled || true')
  await svc.close()
})
