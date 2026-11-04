// One of each proxy, on recorded fixtures, behind one ProxyService (the legacy NPM login included).
import { ProxyService } from '../../src/lib/proxy/service'
import { ProxyRefusal } from '../../src/lib/proxy/types'
import { MemoryInstanceSecrets, MemoryProxyStore } from '../../src/lib/proxy/store'
import type { FetchLike } from '../../src/lib/proxy/http'
import { FakeCaddy, FakeHaproxy, FakeNpm, FakePangolin, FakeTraefik, MemoryFiles } from './proxy-servers'

export function fixtureWorld(extra: Record<string, unknown> = {}) {
  const npm1 = new FakeNpm(1, 'npm1-password'), npm2 = new FakeNpm(2, 'npm2-password')
  const files = new MemoryFiles()
  const traefik = new FakeTraefik(files)
  const caddy = new FakeCaddy(), haproxy = new FakeHaproxy(), pangolin = new FakePangolin()
  // Looked up per request, so a test can wrap one server's fetch.
  const byOrigin: Record<string, () => FetchLike> = {
    'http://192.0.2.37:81': () => npm1.fetch, 'http://192.0.2.37:181': () => npm2.fetch, 'http://192.0.2.38:8282': () => traefik.fetch,
    'http://192.0.2.38:2019': () => caddy.fetch, 'http://192.0.2.38:5555': () => haproxy.fetch, 'http://192.0.2.39:3003': () => pangolin.fetch,
  }
  const fetchImpl: FetchLike = (u, i) => {
    const f = byOrigin[new URL(u).origin]
    if (!f) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } }))
    return f()(u, i)
  }
  const store = new MemoryProxyStore(), secrets = new MemoryInstanceSecrets()
  const service = new ProxyService({
    store, secrets, fetch: fetchImpl, fileTransport: () => files,
    legacyNpm: async () => ({ url: 'http://192.0.2.37:81', email: 'admin@example.invalid', password: 'npm1-password' }),
    learnHostKey: async () => 'SHA256:fixture-host-key',
    // The Catalogue's rule, as fixtures: CT 9404 is a VM, CT 9405 is not running, anything else on node1 passes.
    checkManagedTarget: async (ref: { node: string; vmid: number }) => {
      if (ref.vmid === 9404) throw new ProxyRefusal('9404 is a VM; a Managed proxy runs in a container.', 400)
      if (ref.vmid === 9405) throw new ProxyRefusal('CT 9405 is not running.', 400)
      if (ref.node !== 'node1') throw new ProxyRefusal(`CT ${ref.vmid} was not found.`, 400)
    },
    resolve: async (h: string) => (h === 'loop.example.invalid' ? ['127.0.0.1'] : ['192.0.2.80']),
    ...extra,
  })
  return { service, store, secrets, npm1, npm2, files, traefik, caddy, haproxy, pangolin }
}

