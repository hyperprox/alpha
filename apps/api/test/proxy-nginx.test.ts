// The NGINX provider: the ProxyProvider contract against a stand-in container. The provider's own scripts run for real
// in bash, against a folder that plays /etc/nginx, with a stand-in `nginx` that accepts or refuses the configuration
// the way `nginx -t` does. So the write, the nginx -t gate, the put-back and the reload are what is tested.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runContract } from './proxy-contract'
import { fixtureWorld } from './fakes/proxy-world'
import { NGINX_HEADER, parseFile, renderFile, serverBlock } from '../src/lib/proxy/providers/nginx'
import { managedInstanceInput } from '../src/lib/proxy/managed-recipes'

const root = mkdtempSync(join(tmpdir(), 'hpx-nginx-'))
const conf = join(root, 'conf.d'), bin = join(root, 'bin')
mkdirSync(conf); mkdirSync(bin)
// The provider is given its real path; the stand-in container maps /etc/nginx/conf.d to the folder above.
const FILE = '/etc/nginx/conf.d/hyperprox-hosts.conf'
const LOCAL = join(conf, 'hyperprox-hosts.conf')
after(() => rmSync(root, { recursive: true, force: true }))

// HyperProx's own file, as the Catalogue's install leaves it: the header only.
writeFileSync(LOCAL, NGINX_HEADER + '\n')
// A hand-made site HyperProx did not write: listed read-only, never touched.
writeFileSync(join(conf, 'legacy.conf'), `server {\n  listen 80;\n  server_name legacy-nginx.hpx.invalid;\n  location / { proxy_pass http://192.0.2.60:8000; }\n}\n`)
writeFileSync(join(bin, 'nginx'), `#!/bin/bash
D="${conf}"
bad() { grep -lE 'BROKEN|refused\.hpx\.invalid' "$D"/*.conf 2>/dev/null | head -n1; }
case "$1" in
  -v) echo "nginx version: nginx/1.31.8" >&2 ;;
  -t) if f=$(bad) && [ -n "$f" ]; then echo "nginx: [emerg] unknown directive \\"BROKEN\\" in $f:1" >&2; echo "nginx: configuration file /etc/nginx/nginx.conf test failed" >&2; exit 1; fi
      echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2 ;;
  -T) if f=$(bad) && [ -n "$f" ]; then echo "nginx: [emerg] unknown directive in $f:1" >&2; exit 1; fi
      echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2
      for f in "$D"/*.conf; do echo "# configuration file /etc/nginx/conf.d/$(basename "$f"):"; cat "$f"; echo; done ;;
  -s) echo reload >> "${root}/reloads" ;;
esac
`)
writeFileSync(join(bin, 'systemctl'), '#!/bin/bash\n[ "$1" = is-active ] && { [ "$2" = --quiet ] || echo active; exit 0; }\n[ "$1" = reload ] && { echo reload >> "' + root + '/reloads"; exit 0; }\nexit 0\n')
chmodSync(join(bin, 'nginx'), 0o755); chmodSync(join(bin, 'systemctl'), 0o755)

const runs: string[] = []
const exec = async (script: string) => {
  runs.push(script)
  const r = spawnSync('bash', ['-s'], { input: script.replaceAll('/etc/nginx/conf.d', conf), encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } })
  return { code: r.status ?? -1, output: (r.stdout ?? '') + (r.stderr ?? '') }
}
const w = fixtureWorld({ guestExec: () => exec })
const actor = { email: 'admin@example.invalid' }
let id = ''

test('setup: a Managed NGINX instance, as the Catalogue registers it', async () => {
  const input = managedInstanceInput('nginx', { name: 'edge nginx', ip: '192.0.2.70', node: 'node1', vmid: 9100, secret: 'unused-secret-0123456789' })
  assert.equal(input.url, 'http://127.0.0.1')
  const r = await w.service.createInstance({ ...input, settings: { file: FILE } }, actor)
  assert.equal(r.health.ok, true, JSON.stringify(r.health.checks))
  assert.equal(r.health.version, '1.31.8')
  id = r.instance.id
})

test('a BYO NGINX is refused: it is driven through its container only', async () => {
  const r = await w.service.createInstance({ kind: 'nginx', name: 'byo nginx', url: 'http://192.0.2.71', settings: { file: FILE } }, actor)
  assert.equal(r.health.ok, false)
  assert.match(JSON.stringify(r.health), /must be a Managed instance/)
})

runContract({
  label: 'NGINX', service: () => w.service, get instanceId() { return id }, externalDomain: 'legacy-nginx.hpx.invalid',
  domain: 'test-n.hpx.invalid', secondDomain: 'test-n2.hpx.invalid', forwardHost: '192.0.2.50', forwardPort: 9000, multiDomain: true,
})

test('every write was checked by nginx -t and reloaded; the file carries the header and nothing else of a person', () => {
  assert.ok(readFileSync(join(root, 'reloads'), 'utf8').trim().split('\n').length >= 6)
  assert.ok(readFileSync(LOCAL, 'utf8').startsWith(NGINX_HEADER))
  assert.equal(readFileSync(join(conf, 'legacy.conf'), 'utf8').includes('legacy-nginx.hpx.invalid'), true)
  assert.ok(runs.some(s => s.includes('nginx -t')))
})

test('a change NGINX refuses is not applied, and the file is put back as it was', async () => {
  // The stand-in refuses any configuration naming refused.hpx.invalid: the new file is what nginx -t refuses.
  const before = readFileSync(LOCAL, 'utf8')
  const { provider } = await w.service.provider(id)
  await assert.rejects(provider.createHost({ domains: ['refused.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.51', forwardPort: 80, enabled: true }),
    /NGINX refused the change, so nothing was changed: \[emerg\] unknown directive/)
  assert.equal(readFileSync(LOCAL, 'utf8'), before)
  assert.equal(existsSync(`${LOCAL}.hyperprox-previous`), false)
  // A configuration NGINX already refuses is not touched at all.
  writeFileSync(join(conf, 'broken.conf'), 'BROKEN;\n')
  try {
    await assert.rejects(provider.createHost({ domains: ['other.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.51', forwardPort: 80, enabled: true }),
      /nginx -t refuses NGINX's configuration as it is now/)
    assert.equal(readFileSync(LOCAL, 'utf8'), before)
  } finally { rmSync(join(conf, 'broken.conf')) }
})

test('a file HyperProx did not write is never overwritten', async () => {
  const saved = existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8') : ''
  writeFileSync(LOCAL, 'server { listen 80; server_name mine.hpx.invalid; }\n')
  try {
    const { provider } = await w.service.provider(id)
    await assert.rejects(provider.createHost({ domains: ['x.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.51', forwardPort: 80, enabled: true }), /not written by HyperProx/)
    assert.equal(readFileSync(LOCAL, 'utf8'), 'server { listen 80; server_name mine.hpx.invalid; }\n')
    const h = await provider.health()
    assert.equal(h.ok, false)
  } finally { writeFileSync(LOCAL, saved) }
})

test('the server block: proxy headers, websockets through the map, https upstreams with SNI, 503 when disabled', () => {
  const k = { id: 'hpx-a', domains: ['a.hpx.invalid', 'b.hpx.invalid'], forwardScheme: 'https' as const, forwardHost: '2001:db8::5', forwardPort: 8443, enabled: true, websockets: true }
  const b = serverBlock(k)
  assert.match(b, /server_name a\.hpx\.invalid b\.hpx\.invalid;/)
  assert.match(b, /proxy_pass https:\/\/\[2001:db8::5\]:8443;/)
  assert.match(b, /proxy_set_header Connection \$hpx_connection_upgrade;/)
  assert.match(b, /proxy_ssl_server_name on;/)
  assert.match(serverBlock({ ...k, enabled: false }), /return 503;/)
  assert.doesNotMatch(serverBlock({ ...k, enabled: false }), /proxy_pass/)
  assert.doesNotMatch(serverBlock({ ...k, websockets: false }), /Upgrade/)
  const file = renderFile([k])
  assert.match(file, /map \$http_upgrade \$hpx_connection_upgrade/)
  assert.deepEqual(parseFile(file, '/f'), [k])
  // A damaged comment line drops that host only.
  assert.deepEqual(parseFile(file.replace('# hpx-host {', '# hpx-host {x'), '/f'), [])
})

test('the server file must be a .conf under /etc/nginx, and one NGINX loads', async () => {
  for (const file of ['/tmp/x.conf', '/etc/nginx/../shadow.conf', '/etc/nginx/conf.d/x.txt']) {
    const r = await w.service.createInstance({ ...managedInstanceInput('nginx', { name: `bad ${file}`, ip: '192.0.2.70', node: 'node1', vmid: 9100, secret: 'unused-secret-0123456789' }), settings: { file } }, actor)
    assert.match(JSON.stringify(r.health), /must be a \.conf file under \/etc\/nginx/)
  }
  const r = await w.service.createInstance({ ...managedInstanceInput('nginx', { name: 'not loaded', ip: '192.0.2.70', node: 'node1', vmid: 9100, secret: 'unused-secret-0123456789' }), settings: { file: '/etc/nginx/sites-enabled/hpx.conf' } }, actor)
  assert.equal(r.health.ok, false)
  const { provider } = await w.service.provider(r.instance.id)
  await assert.rejects(provider.createHost({ domains: ['x.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.51', forwardPort: 80, enabled: true }), /NGINX does not load \/etc\/nginx\/sites-enabled\/hpx\.conf/)
})

test('a host edited by hand in the file into something that is not a host is dropped, never written back', () => {
  const ok = { id: 'hpx-a', domains: ['a.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.5', forwardPort: 80, enabled: true, websockets: true }
  const line = (k: any) => `# hpx-host ${JSON.stringify(k)}`
  const text = [NGINX_HEADER, line(ok), line({ ...ok, id: 'hpx-b', forwardHost: '1.2.3.4; include /etc/shadow' }), line({ ...ok, id: 'hpx-c', domains: ['x.invalid; return 200'] }),
    line({ ...ok, id: 'hpx-d', forwardPort: 70000 }), line({ ...ok, id: 'evil;', domains: ['e.hpx.invalid'] }), line({ ...ok, id: 'hpx-f', forwardScheme: 'ftp' })].join('\n')
  assert.deepEqual(parseFile(text, '/f').map(k => k.id), ['hpx-a'])
})
