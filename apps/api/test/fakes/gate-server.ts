// The real gate and auth routes (fakes/app.ts) on a real port, with an in-memory vault, for shell tests
// that need a real HyperProx session behind a real nginx (scripts/test-monitoring-front.sh).
//   PORT=18392 node --import tsx apps/api/test/fakes/gate-server.ts
import { FakeBroker } from './fake-broker'
import { buildTestApp } from './app'

export const VIEWER = { email: 'viewer@example.com', password: 'viewer master password' }

async function main() {
  const broker = new FakeBroker()
  broker.addUser(VIEWER.email, VIEWER.password, 'viewer')
  const app = await buildTestApp(broker)
  await app.listen({ port: Number(process.env.PORT ?? 18392), host: '127.0.0.1' })
  process.stdout.write('ready\n')
}

main().catch(e => { console.error(e); process.exit(1) })
