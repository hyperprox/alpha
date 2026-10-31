// A whole API process for the restart test: the real gate, auth routes and unlock state over a fake broker,
// attached to the keyholder named in VAULT_KEYHOLDER_SOCKET. Prints {"port":N} once it listens.
import { FakeBroker } from './fake-broker'
import { buildTestApp } from './app'
import { attachUnlockState, setStateLogger } from '../../src/lib/vault/state'

async function main() {
  const broker = new FakeBroker()
  broker.addUser('owner@example.com', 'correct horse battery staple', 'owner')
  setStateLogger({ info: m => process.stderr.write(m + '\n'), warn: m => process.stderr.write(m + '\n') })
  const app = await buildTestApp(broker)
  await attachUnlockState(5000)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  process.stdout.write(JSON.stringify({ port: typeof addr === 'object' && addr ? addr.port : 0 }) + '\n')
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1) })
