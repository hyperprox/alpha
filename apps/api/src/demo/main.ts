// =============================================================================
//  HyperProx demo mode — the separate entrypoint
//
//  `pnpm demo` (scripts/demo.sh) runs this file, never src/index.ts. It loads no .env
//  file (unlike src/index.ts, it never imports dotenv), refuses every outbound connection
//  (./no-outbound), checks it is not looking at a real install (./safety.ts), and only
//  then listens: on loopback for a local demo, or on the one address public mode names.
// =============================================================================

import { installNoOutbound } from './no-outbound'
installNoOutbound()

import { checkDemoEnvironment, prepareDataDir, DemoRefused } from './safety'
import { buildDemoServer } from './server'

async function main() {
  let cfg
  try { cfg = checkDemoEnvironment() } catch (e) {
    if (e instanceof DemoRefused) { console.error(`[demo] ${e.message}`); process.exit(2) }
    throw e
  }
  prepareDataDir(cfg.dataDir)
  const app = await buildDemoServer({ logger: false, public: cfg.public })
  const host = cfg.public ? cfg.public.listenHost : cfg.host
  const port = cfg.public ? cfg.public.listenPort : cfg.port
  await app.listen({ port, host })
  console.log(cfg.public
    ? `[demo] HyperProx public demo on http://${host}:${port} (pages from 127.0.0.1:${cfg.public.webPort}; invented data; nothing can be changed)`
    : `[demo] HyperProx demo API on http://${host}:${port} (invented data; every change is refused). Data directory: ${cfg.dataDir}`)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { app.close().finally(() => process.exit(0)) })
}

main().catch(err => { console.error(err); process.exit(1) })
