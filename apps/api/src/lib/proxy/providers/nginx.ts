// =============================================================================
//  HyperProx — Proxy provider: NGINX
//
//  NGINX has no API, so HyperProx writes one file of its own (by default
//  /etc/nginx/conf.d/hyperprox-hosts.conf) inside the container it installed,
//  through the container (the guest transport: the remote executor, which
//  refuses a guest HyperProx must leave alone). Every write is checked with
//  `nginx -t` before NGINX reloads; a file NGINX refuses is put back as it
//  was, so a bad change never reaches the running proxy.
//
//  Each host in the file is one server block, preceded by a comment line with
//  the host as JSON ("# hpx-host {...}"), so a read never has to parse NGINX
//  syntax back into a host. The file carries a header that says HyperProx owns
//  it; a file without it is never overwritten. Every other server block NGINX
//  loads (read from `nginx -T`) is shown read-only.
//
//  A disabled host keeps its server block and answers 503.
// =============================================================================

import { withFileLock } from './traefik'
import { slugFor, hostPort, checkHostname, checkForwardHost } from '../spec'
import type { GuestExec } from '../transport'
import { shq } from '../../shell'
import { parseNginxDump } from '../../webproxy/nginx-conf'
import { ProxyRefusal, type HostSpec, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyProvider } from '../types'

export const NGINX_HEADER = '# Managed by HyperProx. This file is rewritten whole on every change; put hand-made servers in another file.'
export const NGINX_HOSTS_FILE = '/etc/nginx/conf.d/hyperprox-hosts.conf'
const META = '# hpx-host '
const PREFIX = 'hpx-'
const BEGIN = '---HPX-NGINX-FILE---'
const DUMP = '---HPX-NGINX-DUMP---'
const END = '---HPX-NGINX-END---'

export interface NginxConfig {
  /** HyperProx's own file, inside a folder NGINX includes in its http block. */
  file:    string
  exec:    GuestExec
  /** Serialises writes to the file; the instance id. */
  lockKey: string
}

/** One HyperProx host as it is kept in the file's comment line. */
interface Kept { id: string; domains: string[]; forwardScheme: 'http' | 'https'; forwardHost: string; forwardPort: number; enabled: boolean; websockets: boolean }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string) => Buffer.from(s.trim(), 'base64').toString('utf8')

/** The server block for one host. Every value was checked by parseHostSpec (names, an address, a port): nothing here is free text. */
export function serverBlock(k: Kept): string {
  const target = `${k.forwardScheme}://${hostPort(k.forwardHost, k.forwardPort)}`
  const body = k.enabled ? [
    `    proxy_pass ${target};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    ...(k.websockets ? ['    proxy_set_header Upgrade $http_upgrade;', '    proxy_set_header Connection $hpx_connection_upgrade;'] : []),
    ...(k.forwardScheme === 'https' ? ['    proxy_ssl_server_name on;'] : []),
  ] : ['    return 503;']
  return [`${META}${JSON.stringify(k)}`, 'server {', '  listen 80;', `  server_name ${k.domains.join(' ')};`, '  location / {', ...body, '  }', '}'].join('\n')
}

/** The whole file for these hosts. The map gives websocket hosts their Connection header. */
export function renderFile(hosts: Kept[]): string {
  return [NGINX_HEADER, '', 'map $http_upgrade $hpx_connection_upgrade {', '  default upgrade;', "  ''      close;", '}', '',
    ...hosts.map(h => serverBlock(h) + '\n')].join('\n')
}

/**
 * One host from the file, checked again the way a new host is (names, address, port, scheme), or null. The file
 * sits in a container that root there can edit, and a host written back goes into NGINX syntax: anything that would
 * not pass as a new host is dropped, never written again.
 */
function keptOf(k: any): Kept | null {
  try {
    if (typeof k?.id !== 'string' || !/^hpx-[a-z0-9-]{1,60}$/.test(k.id) || !Array.isArray(k.domains) || !k.domains.length || k.domains.length > 20) return null
    const domains = k.domains.map(checkHostname)
    const port = Number(k.forwardPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    if (k.forwardScheme !== 'http' && k.forwardScheme !== 'https') return null
    return { id: k.id, domains, forwardScheme: k.forwardScheme, forwardHost: checkForwardHost(k.forwardHost), forwardPort: port, enabled: k.enabled !== false, websockets: k.websockets !== false }
  } catch { return null }
}

/** The hosts kept in a file HyperProx wrote. A file without the header is refused, never read as HyperProx's. */
export function parseFile(text: string | null, file: string): Kept[] {
  if (text === null || !text.trim()) return []
  if (!text.startsWith(NGINX_HEADER)) throw new ProxyRefusal(`${file} in the NGINX container was not written by HyperProx, so HyperProx will not change it. Point the instance at a file of its own.`)
  const out: Kept[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(META)) continue
    try { const k = keptOf(JSON.parse(line.slice(META.length))); if (k) out.push(k) }
    catch { /* a damaged line: that host is not HyperProx's any more */ }
  }
  return out
}

export class NginxProvider implements ProxyProvider {
  readonly kind = 'nginx' as const
  readonly capabilities = { certificates: 'list' as const, requestCertificate: false, multiDomain: true,
    disabledMeans: 'NGINX keeps the server block and answers 503 for it.' }

  constructor(private cfg: NginxConfig) {}

  /** HyperProx's file and NGINX's whole loaded configuration, in one trip into the container. */
  private async read(): Promise<{ file: string | null; dump: string; dumpOk: boolean }> {
    const f = shq(this.cfg.file)
    const r = await this.cfg.exec([
      'set -e', `if [ -e ${f} ]; then echo ${BEGIN}; base64 -w0 ${f}; echo; else echo ${BEGIN}; echo NOFILE; fi`,
      `echo ${DUMP}`, 'if out=$(nginx -T 2>&1); then echo OK; else echo FAIL; fi', 'printf %s "$out" | base64 -w0; echo', `echo ${END}`,
    ].join('\n') + '\n')
    const m = new RegExp(`${BEGIN}\\s*\\n(NOFILE|[A-Za-z0-9+/=]*)\\s*\\n${DUMP}\\s*\\n(OK|FAIL)\\s*\\n([A-Za-z0-9+/=]*)\\s*\\n${END}`).exec(r.output)
    if (r.code !== 0 || !m) throw new Error(`Reading NGINX's configuration in the container failed (exit ${r.code}).`)
    return { file: m[1] === 'NOFILE' ? null : unb64(m[1]), dump: unb64(m[3]), dumpOk: m[2] === 'OK' }
  }

  /** Put the file in place only if `nginx -t` accepts it, then reload. Otherwise the old file is put back. */
  private async write(text: string): Promise<void> {
    const f = shq(this.cfg.file), bak = shq(`${this.cfg.file}.hyperprox-previous`), tmp = shq(`${this.cfg.file}.hyperprox-new`)
    const r = await this.cfg.exec([
      'set -u', 'umask 022',
      `printf '%s' '${b64(text)}' | base64 -d > ${tmp} || exit 4`,
      `if [ -e ${f} ]; then cp -p ${f} ${bak}; had=1; else had=0; fi`,
      `mv -f ${tmp} ${f}`,
      'if ! out=$(nginx -t 2>&1); then',
      `  if [ "$had" = 1 ]; then mv -f ${bak} ${f}; else rm -f ${f}; fi`,
      '  echo HPX_REFUSED; printf %s "$out" | tail -n 5; exit 3',
      'fi',
      'if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then systemctl reload nginx; else nginx -s reload; fi || { echo HPX_RELOAD_FAILED; exit 5; }',
      `rm -f ${bak}`, 'echo HPX_WROTE',
    ].join('\n') + '\n')
    if (/HPX_REFUSED/.test(r.output)) {
      const lines = r.output.split('HPX_REFUSED')[1].trim().split('\n')
      // The [emerg] line names the problem and the file; "test failed" only says that it failed.
      const why = lines.find(l => /\[emerg\]/.test(l)) ?? lines.find(l => /error|failed/i.test(l)) ?? 'nginx -t failed'
      throw new ProxyRefusal(`NGINX refused the change, so nothing was changed: ${why.replace(/^nginx: /, '')}`)
    }
    if (/HPX_RELOAD_FAILED/.test(r.output)) throw new Error('The file was accepted by nginx -t, but NGINX did not reload. Check the service in the container.')
    if (r.code !== 0 || !/HPX_WROTE/.test(r.output)) throw new Error(`Writing ${this.cfg.file} in the container failed (exit ${r.code}).`)
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> { return withFileLock(this.cfg.lockKey, fn) }

  async health(): Promise<ProxyHealth> {
    const checks: ProxyHealth['checks'] = []
    let ok = true
    let version: string | undefined
    try {
      const r = await this.cfg.exec('v=$(nginx -v 2>&1) || exit 9; echo "$v"; if command -v systemctl >/dev/null 2>&1; then systemctl is-active nginx || true; fi\n')
      if (r.code !== 0) throw new Error('nginx is not installed in the container.')
      version = /nginx\/([\d.]+)/.exec(r.output)?.[1]
      const active = !/\b(inactive|failed)\b/.test(r.output)
      checks.push({ name: 'service', ok: active, detail: active ? `NGINX ${version ?? ''} is running`.replace('  ', ' ') : 'NGINX is installed but not running' })
      if (!active) ok = false
    } catch (e: any) { ok = false; checks.push({ name: 'service', ok: false, detail: e.message }) }
    try {
      const { file, dump, dumpOk } = await this.read()
      const loaded = dumpOk && parseNginxDump(dump).files.includes(this.cfg.file)
      if (dumpOk && !loaded) { ok = false; checks.push({ name: 'loaded', ok: false, detail: `NGINX does not load ${this.cfg.file}; hosts written there would never be served` }) }
      checks.push({ name: 'config', ok: dumpOk, detail: dumpOk ? 'nginx -t accepts the configuration' : 'nginx -t refuses the configuration as it is now; HyperProx cannot change it until that is fixed' })
      if (!dumpOk) ok = false
      if (file === null) checks.push({ name: 'file', ok: false, detail: `${this.cfg.file} does not exist. The Catalogue's NGINX has it from the install; elsewhere, create it with HyperProx's header line as its only content` })
      else if (!file.startsWith(NGINX_HEADER)) { ok = false; checks.push({ name: 'file', ok: false, detail: `${this.cfg.file} exists but was not written by HyperProx; it will not be overwritten` }) }
      else checks.push({ name: 'file', ok: true, detail: `${this.cfg.file} is HyperProx's` })
    } catch (e: any) { ok = false; checks.push({ name: 'config', ok: false, detail: e.message }) }
    return { ok, version, checks }
  }

  private record(k: Kept): ProxyHostRecord {
    return {
      id: k.id, domains: k.domains, forwardScheme: k.forwardScheme, forwardHost: k.forwardHost, forwardPort: k.forwardPort,
      enabled: k.enabled, owned: true, websockets: k.websockets, tls: { kind: 'none' }, online: null,
      detail: k.enabled ? undefined : 'Disabled: answers 503', state: k,
    }
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    const { file, dump } = await this.read()
    let mine: Kept[] = [], fileError = ''
    try { mine = parseFile(file, this.cfg.file) } catch (e: any) { fileError = e.message }
    const out = mine.map(k => this.record(k))
    for (const [i, s] of parseNginxDump(dump).servers.entries()) {
      if (s.file === this.cfg.file && !fileError) continue
      if (!s.names.length) continue
      const target = s.proxyPass ? /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/.exec(s.proxyPass) : null
      out.push({
        id: `${s.file}#${i}`, domains: s.names, forwardScheme: target?.[1] === 'https' ? 'https' : 'http',
        forwardHost: target ? target[2].replace(/^\[|\]$/g, '') : '', forwardPort: target ? Number(target[3] ?? (target[1] === 'https' ? 443 : 80)) : 0,
        enabled: true, owned: false,
        readOnlyReason: fileError && s.file === this.cfg.file ? fileError : `Made outside HyperProx (${s.file})`,
        tls: s.ssl ? { kind: 'certificate', certificateName: s.certificate ?? undefined } : { kind: 'none' }, online: null,
        detail: s.proxyPass ? `proxy_pass ${s.proxyPass}` : s.kind === 'static' ? 'Serves files' : s.kind === 'redirect' ? 'Redirects or answers directly' : undefined,
      })
    }
    return out
  }

  /** NGINX must load the file (it is in `nginx -T`), or a host written there would never be served. */
  private loaded(dump: string, dumpOk: boolean): void {
    if (!dumpOk) throw new ProxyRefusal('nginx -t refuses NGINX\'s configuration as it is now, so HyperProx changes nothing until that is fixed.')
    if (!parseNginxDump(dump).files.includes(this.cfg.file)) throw new ProxyRefusal(`NGINX does not load ${this.cfg.file}, so a host written there would never be served. Point the instance at a file NGINX includes in its http block.`)
  }

  private async mutate<T>(fn: (hosts: Kept[]) => T): Promise<T> {
    return this.locked(async () => {
      const { file, dump, dumpOk } = await this.read()
      this.loaded(dump, dumpOk)
      const hosts = parseFile(file, this.cfg.file)
      const out = fn(hosts)
      await this.write(renderFile(hosts))
      return out
    })
  }

  private kept(id: string, spec: HostSpec): Kept {
    return { id, domains: spec.domains, forwardScheme: spec.forwardScheme, forwardHost: spec.forwardHost, forwardPort: spec.forwardPort, enabled: spec.enabled, websockets: spec.websockets !== false }
  }

  private find(hosts: Kept[], id: string): number {
    const i = hosts.findIndex(h => h.id === id)
    if (i < 0) {
      if (!id.startsWith(PREFIX)) throw new ProxyRefusal(`${id} was not made by HyperProx; it is read-only.`)
      throw new ProxyRefusal(`NGINX has no HyperProx host ${id}.`, 404)
    }
    return i
  }

  async createHost(spec: HostSpec): Promise<string> {
    return this.mutate(hosts => {
      const id = slugFor(spec, new Set(hosts.map(h => h.id)))
      hosts.push(this.kept(id, spec))
      return id
    })
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    await this.mutate(hosts => { const i = this.find(hosts, id); hosts[i] = this.kept(id, { ...spec, websockets: spec.websockets ?? hosts[i].websockets }) })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate(hosts => { const i = this.find(hosts, id); hosts[i] = { ...hosts[i], enabled } })
  }

  async deleteHost(id: string): Promise<void> {
    await this.mutate(hosts => { hosts.splice(this.find(hosts, id), 1) })
  }

  async listCertificates(): Promise<ProxyCertificate[]> { return [] }
}
