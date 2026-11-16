// =============================================================================
//  HyperProx — HAProxy: changes that survive a restart, through the Data Plane API
//
//  A change meant to last is written to haproxy.cfg, never edited in place: it
//  is one Data Plane transaction (lib/proxy/providers/haproxy.ts configChange)
//  that haproxy -c validates before HAProxy reloads, with the previous
//  configuration put back if the reload fails. A failed validation applies
//  nothing and says why.
//
//  Only names HAProxy accepts reach the API (lib/haproxy/runtime.ts checks).
// =============================================================================

import type { DataPlaneTx } from '../proxy/providers/haproxy'
import { RuntimeRefusal, checkAddress, checkName, checkPort, checkWeight } from './runtime'

/** The balance algorithms the plug-in offers, with what each one does in words. */
export const ALGORITHMS = {
  roundrobin: 'Takes turns, in proportion to each server\'s weight. The usual choice.',
  leastconn: 'Sends each visitor to the server with the fewest open connections. Best for long sessions.',
  source: 'The same visitor address always goes to the same server, while that server is up.',
  first: 'Fills the first server up to its connection limit, then the next. Saves power on idle servers.',
  random: 'Picks two servers at random and uses the less busy one.',
  'static-rr': 'Takes turns by weight; weights cannot change while running.',
} as const
export type Algorithm = keyof typeof ALGORITHMS

export function checkAlgorithm(v: unknown): Algorithm {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!Object.prototype.hasOwnProperty.call(ALGORITHMS, s)) throw new RuntimeRefusal(`The balance algorithm is one of ${Object.keys(ALGORITHMS).join(', ')}.`)
  return s as Algorithm
}

/** What the plug-in needs of a Data Plane connection (HaproxyProvider has it). */
export interface ConfigWriter {
  configChange(what: string, fn: (tx: DataPlaneTx) => Promise<void>): Promise<void>
  configRead<T>(path: string): Promise<T>
}

interface DpServer { name: string; address?: string; port?: number; weight?: number; check?: string; maintenance?: string; [k: string]: unknown }

const enc = encodeURIComponent

async function server(tx: DataPlaneTx, b: string, s: string): Promise<DpServer> {
  const list = (await tx.get<DpServer[]>(`/backends/${enc(b)}/servers`)) ?? []
  const cur = list.find(x => x.name === s)
  if (!cur) throw new RuntimeRefusal(`${s} is not in ${b}'s saved configuration (it may have been added for this run only).`)
  return cur
}

export async function persistBalance(w: ConfigWriter, backend: string, algo: unknown): Promise<void> {
  const b = checkName(backend, 'The backend'), a = checkAlgorithm(algo)
  await w.configChange(`switching ${b} to ${a}`, async tx => {
    const cur = await tx.get<Record<string, unknown>>(`/backends/${enc(b)}`)
    await tx.send('PUT', `/backends/${enc(b)}`, { ...cur, name: b, balance: { algorithm: a } })
  })
}

export async function persistWeight(w: ConfigWriter, backend: string, srv: string, weight: unknown): Promise<void> {
  const b = checkName(backend, 'The backend'), s = checkName(srv, 'The server'), n = checkWeight(weight)
  await w.configChange(`setting ${s}'s weight to ${n}`, async tx => {
    const cur = await server(tx, b, s)
    await tx.send('PUT', `/backends/${enc(b)}/servers/${enc(s)}`, { ...cur, weight: n })
  })
}

export async function persistHealth(w: ConfigWriter, backend: string, srv: string, on: boolean): Promise<void> {
  const b = checkName(backend, 'The backend'), s = checkName(srv, 'The server')
  await w.configChange(`turning ${s}'s health check ${on ? 'on' : 'off'}`, async tx => {
    const cur = await server(tx, b, s)
    await tx.send('PUT', `/backends/${enc(b)}/servers/${enc(s)}`, { ...cur, check: on ? 'enabled' : 'disabled' })
  })
}

export async function persistMaintenance(w: ConfigWriter, backend: string, srv: string, on: boolean): Promise<void> {
  const b = checkName(backend, 'The backend'), s = checkName(srv, 'The server')
  await w.configChange(`${on ? 'putting' : 'taking'} ${s} ${on ? 'into' : 'out of'} maintenance`, async tx => {
    const cur = await server(tx, b, s)
    await tx.send('PUT', `/backends/${enc(b)}/servers/${enc(s)}`, { ...cur, maintenance: on ? 'enabled' : 'disabled' })
  })
}

export interface NewServer { name: string; address: string; port: number; weight: number; check: boolean }

export function checkNewServer(v: Record<string, unknown>): NewServer {
  return { name: checkName(v.name, 'The server name'), address: checkAddress(v.address), port: checkPort(v.port),
    weight: v.weight === undefined || v.weight === '' ? 100 : checkWeight(v.weight), check: v.check !== false }
}

const serverBody = (s: NewServer) => ({ name: s.name, address: s.address, port: s.port, weight: s.weight, check: s.check ? 'enabled' : 'disabled' })

export async function persistAddServer(w: ConfigWriter, backend: string, s: NewServer): Promise<void> {
  const b = checkName(backend, 'The backend')
  await w.configChange(`adding ${s.name} to ${b}`, async tx => {
    const list = (await tx.get<DpServer[]>(`/backends/${enc(b)}/servers`)) ?? []
    if (list.some(x => x.name === s.name)) throw new RuntimeRefusal(`${b} already has a server called ${s.name}.`)
    await tx.send('POST', `/backends/${enc(b)}/servers`, serverBody(s))
  })
}

export async function persistRemoveServer(w: ConfigWriter, backend: string, srv: string): Promise<void> {
  const b = checkName(backend, 'The backend'), s = checkName(srv, 'The server')
  await w.configChange(`removing ${s} from ${b}`, async tx => {
    await server(tx, b, s)
    await tx.send('DELETE', `/backends/${enc(b)}/servers/${enc(s)}`)
  })
}

export interface LoadBalance {
  backend: string
  algorithm: Algorithm
  servers: NewServer[]
  /** The public frontend the rule goes in. */
  frontend: string
  /** A Host header the rule matches; null sends everything with no other match (the frontend's default). */
  hostname: string | null
  /** The path HAProxy's HTTP health check asks for. */
  checkPath: string
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const CHECK_PATH_RE = /^\/[A-Za-z0-9._~\/-]{0,200}$/

export function checkHostname(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : ''
  if (!s) return null
  if (!HOSTNAME_RE.test(s)) throw new RuntimeRefusal('The name is a full host name, such as app.example.com.')
  return s
}

/** A backend of 2 or more servers, with HTTP health checks, and the frontend rule that sends visitors to it. */
export async function createLoadBalance(w: ConfigWriter, lb: LoadBalance): Promise<void> {
  const b = checkName(lb.backend, 'The backend name'), fe = checkName(lb.frontend, 'The frontend')
  if (lb.servers.length < 2) throw new RuntimeRefusal('Load balancing needs at least two servers.')
  if (!CHECK_PATH_RE.test(lb.checkPath)) throw new RuntimeRefusal('The health check path starts with / and has no spaces or query.')
  const names = new Set<string>()
  for (const s of lb.servers) { if (names.has(s.name)) throw new RuntimeRefusal(`Two servers are called ${s.name}.`); names.add(s.name) }
  await w.configChange(`load-balancing ${lb.hostname ?? b}`, async tx => {
    const backends = ((await tx.get<Array<{ name: string }>>('/backends')) ?? []).map(x => x.name)
    if (backends.includes(b)) throw new RuntimeRefusal(`A backend called ${b} already exists. Pick another name.`)
    await tx.send('POST', '/backends', { name: b, mode: 'http', balance: { algorithm: lb.algorithm },
      adv_check: 'httpchk', httpchk_params: { method: 'GET', uri: lb.checkPath } })
    for (const s of lb.servers) await tx.send('POST', `/backends/${enc(b)}/servers`, serverBody(s))
    const frontend = await tx.get<Record<string, unknown>>(`/frontends/${enc(fe)}`)
    if (lb.hostname) {
      const rules = (await tx.get<unknown[]>(`/frontends/${enc(fe)}/backend_switching_rules`)) ?? []
      await tx.send('POST', `/frontends/${enc(fe)}/backend_switching_rules/${rules.length}`,
        { name: b, cond: 'if', cond_test: `{ req.hdr(host),field(1,:) -i ${lb.hostname} }` })
    } else {
      if (frontend?.default_backend) throw new RuntimeRefusal(`Frontend ${fe} already sends everything else to ${String(frontend.default_backend)}. Give this app a host name instead.`)
      await tx.send('PUT', `/frontends/${enc(fe)}`, { ...frontend, name: fe, default_backend: b })
    }
  })
}
