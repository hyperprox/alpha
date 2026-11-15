// =============================================================================
//  HyperProx demo mode — the start-up guard
//
//  The demo is a separate process (src/demo/main.ts) that answers every read the
//  frontend makes from invented fixtures and refuses every write. It must never be
//  able to stand in for, or read from, a real install. Before it listens it checks
//  that nothing a real install would hand it is present, and refuses to start if it is:
//
//    - HYPERPROX_DEMO=1 must be set on purpose. It is read here and nowhere else:
//      the real entrypoint (src/index.ts) does not look at it at all.
//    - No database, vault, hypervisor, DNS, proxy or notification setting may be in the
//      environment. A shell that has sourced a real .env, or a systemd unit with the real
//      EnvironmentFile, fails here. The demo never loads a .env itself.
//    - It never takes the real API's or frontend's port, so it cannot answer behind the
//      real nginx in place of the real API.
//    - Its data directory is its own: outside the repo, and either empty or already marked
//      as a demo directory.
//
//  Public mode (HYPERPROX_DEMO_PUBLIC=1, the live demo on a website) adds:
//
//    - It listens on one address given on purpose (HYPERPROX_DEMO_LISTEN=<ip>:<port>) and serves the
//      whole demo there: the API itself, and every page from the demo frontend, which stays on loopback.
//    - It refuses to start in a checkout that holds a real install's .env, so a public demo can never
//      be started on, or next to, a real HyperProx.
//
//  Every refusal names the problem, never a value.
// =============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEMO_FLAG = 'HYPERPROX_DEMO'
export const DEMO_MARKER = '.hyperprox-demo'
/** The ports the real install uses (API, frontend). The demo never listens on either. */
export const REAL_PORTS = [3000, 3002]
export const DEFAULT_DEMO_API_PORT = 3102

/** Environment names a real install uses for its database, vault and stored credentials. */
const FORBIDDEN_ENV: RegExp[] = [
  /^DATABASE_URL$/, /^POSTGRES_/, /^REDIS_/,
  /^VAULT_/, /^BW_/, /^BITWARDEN/, /^KEYHOLDER/, /^VAULT_KEYHOLDER_SOCKET$/,
  /^PROXMOX_/, /^PVE_/, /^NPM_/, /^GODADDY_/, /^CLOUDFLARE_/, /^DNS_/,
  /^GRAFANA_/, /^PROMETHEUS_/, /^LOCK_ALERT_/, /^ANTHROPIC_/, /^OPENAI_/,
  /^ENCRYPTION_KEY$/, /^JWT_SECRET$/, /^SESSION_SECRET$/, /^SETUP_KEY$/, /^HYPERPROX_SETUP/,
  /^ENV_FILE_PATH$/, /^CREDENTIALS?_/,
  // Anything else that looks like a secret.
  /SECRET/, /PASSWORD/, /PASSWD/, /_TOKEN$/, /^TOKEN$/, /API_KEY/, /PRIVATE_KEY/,
]

export const PUBLIC_FLAG = 'HYPERPROX_DEMO_PUBLIC'
export const DEFAULT_DEMO_WEB_PORT = 3100

/** Public mode: where the open-internet demo listens, and where its frontend waits on loopback. */
export interface PublicConfig {
  /** The one address the public demo listens on (an IP literal). */
  listenHost: string
  listenPort: number
  /** The demo frontend (next start), on 127.0.0.1 only. */
  webPort: number
  /** Reverse proxies whose X-Forwarded-For names the visitor (for the per-address rate limit). */
  trustedProxies: string[]
}

export interface DemoConfig {
  port: number
  host: string
  dataDir: string
  /** Set only in public mode. */
  public: PublicConfig | null
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const isIp = (s: string) => IPV4.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':'))

function portOf(raw: string | undefined, fallback: number, name: string): number {
  const port = Number(raw ?? fallback)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new DemoRefused(`${name} must be a port number from 1024 to 65535.`)
  if (REAL_PORTS.includes(port)) throw new DemoRefused(`Refusing to start the demo on port ${port}: that is the real HyperProx's port.`)
  return port
}

export class DemoRefused extends Error {}

/** Walks up from this file to the folder holding pnpm-workspace.yaml (the repo root), or null. */
export function repoRoot(from = __dirname): string | null {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Checks the environment and works out where the demo listens and keeps its files.
 * Throws DemoRefused with a plain reason if anything belongs to a real install.
 */
export function checkDemoEnvironment(env: NodeJS.ProcessEnv = process.env, root: string | null = repoRoot()): DemoConfig {
  if (env[DEMO_FLAG] !== '1') {
    throw new DemoRefused(`Demo mode is off. Start it with ${DEMO_FLAG}=1 through the demo entrypoint (pnpm demo).`)
  }

  const found = Object.keys(env).filter(k => k !== DEMO_FLAG && !k.startsWith('HYPERPROX_DEMO_') && FORBIDDEN_ENV.some(r => r.test(k)))
  if (found.length) {
    throw new DemoRefused(`Refusing to start the demo: the environment holds settings from a real install (${found.sort().join(', ')}). ` +
      'Run it from a clean shell; the demo needs none of them and reads no .env file.')
  }

  const port = portOf(env.HYPERPROX_DEMO_API_PORT, DEFAULT_DEMO_API_PORT, 'HYPERPROX_DEMO_API_PORT')

  // The demo API only ever talks to the demo frontend on the same machine.
  const host = '127.0.0.1'

  const dataDir = path.resolve(env.HYPERPROX_DEMO_DATA || path.join(os.tmpdir(), `hyperprox-demo-${process.getuid?.() ?? 'user'}`))
  if (root && within(dataDir, root)) {
    throw new DemoRefused('Refusing to start the demo: its data directory is inside the HyperProx folder, next to a real install\'s data. Use a directory outside it.')
  }
  if (fs.existsSync(dataDir)) {
    const entries = fs.readdirSync(dataDir)
    if (entries.length && !entries.includes(DEMO_MARKER)) {
      throw new DemoRefused('Refusing to start the demo: its data directory already holds files that are not the demo\'s. Point HYPERPROX_DEMO_DATA at an empty directory.')
    }
  }
  return { port, host, dataDir, public: env[PUBLIC_FLAG] === undefined ? null : checkPublic(env, root) }
}

function checkPublic(env: NodeJS.ProcessEnv, root: string | null): PublicConfig {
  if (env[PUBLIC_FLAG] !== '1') throw new DemoRefused(`${PUBLIC_FLAG} must be 1 or unset.`)
  // A public demo runs on a machine of its own. A real install keeps its settings in the repo's .env.
  if (root) {
    const dotenv = path.join(root, '.env')
    if (fs.existsSync(dotenv) && fs.statSync(dotenv).size > 0) {
      throw new DemoRefused('Refusing to start the public demo: this checkout holds a real install\'s .env. Run the public demo from a checkout of its own, on a machine of its own.')
    }
  }
  const listen = env.HYPERPROX_DEMO_LISTEN ?? ''
  const m = /^\[?([0-9a-fA-F.:]+)\]?:(\d+)$/.exec(listen)
  if (!m || !isIp(m[1])) throw new DemoRefused('Public mode needs HYPERPROX_DEMO_LISTEN=<ip>:<port>, the one address the demo serves on.')
  const listenPort = portOf(m[2], 0, 'HYPERPROX_DEMO_LISTEN')
  const webPort = portOf(env.HYPERPROX_DEMO_WEB_PORT, DEFAULT_DEMO_WEB_PORT, 'HYPERPROX_DEMO_WEB_PORT')
  if (webPort === listenPort) throw new DemoRefused('HYPERPROX_DEMO_WEB_PORT and the listen port must differ.')
  const trustedProxies = (env.HYPERPROX_DEMO_TRUSTED_PROXIES ?? '').split(',').map(x => x.trim()).filter(Boolean)
  for (const t of trustedProxies) if (!isIp(t)) throw new DemoRefused('HYPERPROX_DEMO_TRUSTED_PROXIES must be a comma-separated list of IP addresses.')
  return { listenHost: m[1], listenPort, webPort, trustedProxies }
}

/** Creates the demo's own data directory and marks it. Nothing else is ever written there. */
export function prepareDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dataDir, DEMO_MARKER), 'HyperProx demo data directory. Safe to delete.\n')
}
