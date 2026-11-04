// One of each proxy, on recorded fixtures, behind one ProxyService (the legacy NPM login included).
import { ProxyService } from '../../src/lib/proxy/service'
import { MemoryInstanceSecrets, MemoryProxyStore } from '../../src/lib/proxy/store'
import type { FetchLike } from '../../src/lib/proxy/http'
import { FakeCaddy, FakeHaproxy, FakeNpm, FakePangolin, FakeTraefik, MemoryFiles } from './proxy-servers'

export function fixtureWorld() {
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
  })
  return { service, store, secrets, npm1, npm2, files, traefik, caddy, haproxy, pangolin }
}

