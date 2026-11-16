// A local plug-in for the loader tests that opts out of the master-password re-confirmation: one read, one change.
import type { LocalApiPlugin } from '../../../../src/lib/local-plugins'

const plugin: LocalApiPlugin = {
  id: 'sample',
  name: 'Sample',
  reconfirm: false,
  routes: (host) => async (f) => {
    f.get('/hello', async () => ({ success: true, data: { hello: host.id } }))
    f.post<{ Body: { n?: number } }>('/echo', async (req) => {
      await host.audit('echo', { by: host.actor(req).email, n: req.body?.n ?? 0 })
      return { success: true, data: { n: req.body?.n ?? 0 } }
    })
  },
}
export default plugin
