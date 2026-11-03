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
const api = { minted: 0, revoked: [] as string[], deleted: [] as string[], devices: [] as any[] }
let server: http.Server
let base = ''

// Stand-ins, installed only after the real package: systemd's control (Docker runs no init) and the two
// client verbs that need a control plane. Everything else falls through to the real /usr/bin/tailscale.
const SHIMS = `set -e
mkdir -p /run/systemd/system /hp-e2e
cat > /usr/local/sbin/systemctl <<'X'
#!/bin/sh
echo "$*" >> /hp-e2e/systemctl.log
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
const exec: RemoteExecutor = {
  listMachines: async () => [machine],
  run: async (_m, script, o) => {
    // After the package install, before `up`: put the client stand-in in front of the real binary.
    if (!shimmed && script.includes('HP_KEY=')) { await docker(['exec', '-i', NAME, 'bash', '-s'], TS_SHIM); shimmed = true }
    const r = await docker(['exec', '-i', NAME, 'bash', '-s'], script, o?.onData)
    return { code: r.code, output: r.output, timedOut: false }
  },
  lxcConfig: async () => ({}),
  setLxcConfig: async () => { throw new Error('not in this test') },
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
      if (req.method === 'GET' && url.pathname === '/api/v2/tailnet/-/devices') return send(200, { devices: api.devices })
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
  const svc = new RemoteAccessService({ store, exec, provider: async id => (id === 'tailscale' ? provider : null), providerSettings: async () => ({ tags: [] }) })

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
  assert.equal((await store.get('lxc-990', 'tailscale'))?.deviceId, 'd-e2e')

  // The stand-in goes first, or uninstall would rightly report a `tailscale` still on PATH.
  await docker(['exec', NAME, 'rm', '-f', '/usr/local/bin/tailscale'])
  const gone = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-990'] }, 'e2e'))
  assert.equal(gone.status, 'completed', `${gone.error}\n${gone.log.slice(-2000)}`)
  assert.equal((await docker(['exec', NAME, 'test', '-e', '/usr/bin/tailscale'])).code, 1, 'package removed')
  assert.equal((await docker(['exec', NAME, 'test', '-e', '/etc/apt/sources.list.d/tailscale.list'])).code, 1, 'repository removed')
  assert.deepEqual(api.deleted, ['d-e2e'])
  assert.equal(await store.get('lxc-990', 'tailscale'), null)
  svc.close()
})
