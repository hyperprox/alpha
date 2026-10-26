// Pebble (the ACME test CA) and pebble-challtestsrv (its DNS), in throwaway containers on loopback ports.
// Nothing here talks to a real CA or a real DNS provider. The tests skip when docker is not usable.
import { spawnSync } from 'node:child_process'
import type { DnsProvider } from '../../src/lib/certs/dns01'

const BASE = Number(process.env.CERTS_PEBBLE_PORT_BASE || 18600)
export const PORTS = { acme: BASE, mgmt: BASE + 1, chall: BASE + 2, dns: BASE + 3 }
export const DIRECTORY_URL = `https://127.0.0.1:${PORTS.acme}/dir`
export const DNS_SERVER = `127.0.0.1:${PORTS.dns}`

const PREFIX = 'abtest-cert-acme'
const NET = `${PREFIX}-net`
const DNS = `${PREFIX}-dns`
const CA = `${PREFIX}-pebble`
const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.8.0'
const CHALL_IMAGE = 'ghcr.io/letsencrypt/pebble-challtestsrv:2.8.0'

function docker(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

export function dockerAvailable(): boolean {
  if (process.env.CERTS_SKIP_PEBBLE) return false
  return docker('info', '--format', '{{.ServerVersion}}').ok
}

export function stopPebble(): void {
  docker('rm', '-f', CA, DNS)
  docker('network', 'rm', NET)
}

/** Starts both containers (replacing leftovers of an earlier run) and waits until both answer. */
export async function startPebble(): Promise<void> {
  stopPebble()
  const must = (r: { ok: boolean; out: string }, what: string) => { if (!r.ok) throw new Error(`${what}: ${r.out}`) }
  must(docker('network', 'create', NET), 'docker network create')
  must(docker('run', '-d', '--name', DNS, '--network', NET,
    '-p', `127.0.0.1:${PORTS.chall}:8055`, '-p', `127.0.0.1:${PORTS.dns}:8053/udp`,
    CHALL_IMAGE, '-management', ':8055', '-dns01', ':8053'), 'challtestsrv')
  must(docker('run', '-d', '--name', CA, '--network', NET,
    '-p', `127.0.0.1:${PORTS.acme}:14000`, '-p', `127.0.0.1:${PORTS.mgmt}:15000`,
    '-e', 'PEBBLE_VA_ALWAYS_VALID=0', '-e', 'PEBBLE_VA_NOSLEEP=1',
    '-e', 'PEBBLE_WFE_NONCEREJECT=0', '-e', 'PEBBLE_AUTHZREUSE=0',
    PEBBLE_IMAGE, '-config', 'test/config/pebble-config.json', '-dnsserver', `${DNS}:8053`), 'pebble')

  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const dir = await fetch(DIRECTORY_URL)
      const mgmt = await fetch(`http://127.0.0.1:${PORTS.chall}/clear-txt`, { method: 'POST', body: JSON.stringify({ host: 'ready.invalid.' }) })
      if (dir.ok && mgmt.ok) return
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`Pebble did not come up: ${docker('logs', CA).out.slice(-500)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

async function chall(path: string, body: object): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${PORTS.chall}${path}`, { method: 'POST', body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`challtestsrv ${path} ${r.status}`)
}

/** Writes TXT values straight into challtestsrv (what Pebble's resolver sees). */
export async function setTxt(fqdn: string, values: string[]): Promise<void> {
  await chall('/clear-txt', { host: `${fqdn}.` })
  for (const value of values) await chall('/set-txt', { host: `${fqdn}.`, value })
}

/**
 * A DnsProvider backed by challtestsrv. challtestsrv can only clear a whole name, so the provider keeps the
 * values and rewrites the remainder, which is the same contract a real provider meets.
 * `corrupt` writes a wrong value where Pebble looks while `mirror` gets the real one, for the rejection path.
 */
export function challtestProvider(zones: string[], opts: { calls?: string[]; corrupt?: boolean; mirror?: Map<string, string[]> } = {}): DnsProvider & { values: Map<string, string[]> } {
  const values = new Map<string, string[]>()
  const calls = opts.calls ?? []
  const sync = async (fqdn: string) => {
    const v = values.get(fqdn) ?? []
    if (opts.mirror) { if (v.length) opts.mirror.set(fqdn, [...v]); else opts.mirror.delete(fqdn) }
    await setTxt(fqdn, opts.corrupt ? v.map(x => `not-${x}`) : v)
  }
  return {
    name: 'challtest',
    values,
    async zones() { return zones },
    async present(zone, fqdn, value) {
      calls.push(`present ${zone} ${fqdn}`)
      values.set(fqdn, [...(values.get(fqdn) ?? []), value])
      await sync(fqdn)
    },
    async cleanup(zone, fqdn, value) {
      calls.push(`cleanup ${zone} ${fqdn}`)
      const left = (values.get(fqdn) ?? []).filter(v => v !== value)
      if (left.length) values.set(fqdn, left); else values.delete(fqdn)
      await sync(fqdn)
    },
  }
}

/** Pebble's current root and first intermediate, from its management interface. */
export async function pebbleRoots(): Promise<{ root: string; intermediate: string }> {
  const get = async (p: string) => {
    const r = await fetch(`https://127.0.0.1:${PORTS.mgmt}${p}`)
    if (!r.ok) throw new Error(`pebble ${p} ${r.status}`)
    return r.text()
  }
  return { root: await get('/roots/0'), intermediate: await get('/intermediates/0') }
}
