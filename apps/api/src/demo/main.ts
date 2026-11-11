// =============================================================================
//  HyperProx demo mode — the separate entrypoint
//
//  `pnpm demo` (scripts/demo.sh) runs this file, never src/index.ts. It loads no .env
//  file (unlike src/index.ts, it never imports dotenv), checks it is not looking at a
//  real install (./safety.ts), and only then listens, on loopback, on its own port.
// =============================================================================

import { checkDemoEnvironment, prepareDataDir, DemoRefused } from './safety'
import { buildDemoServer } from './server'

async function main() {
  let cfg
  try { cfg = checkDemoEnvironment() } catch (e) {
    if (e instanceof DemoRefused) { console.error(`[demo] ${e.message}`); process.exit(2) }
    throw e
  }
  prepareDataDir(cfg.dataDir)
  const app = await buildDemoServer({ logger: false })
  await app.listen({ port: cfg.port, host: cfg.host })
  console.log(`[demo] HyperProx demo API on http://${cfg.host}:${cfg.port} (invented data; every change is refused). Data directory: ${cfg.dataDir}`)
}

main().catch(err => { console.error(err); process.exit(1) })
