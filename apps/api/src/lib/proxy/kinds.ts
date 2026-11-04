// =============================================================================
//  HyperProx — Proxy providers: what each kind needs, and how to build one
// =============================================================================

import { NpmProvider } from './providers/npm'
import { TraefikProvider } from './providers/traefik'
import { CaddyProvider } from './providers/caddy'
import { HaproxyProvider } from './providers/haproxy'
import { PangolinProvider } from './providers/pangolin'
import { GuestFileTransport, SshFileTransport, type FileTransport, type GuestExec } from './transport'
import type { FetchLike } from './http'
import { KIND_LABEL, ProxyRefusal, type ProxyInstance, type ProxyKind, type ProxyProvider } from './types'

export interface KindField {
  key:       string
  label:     string
  secret:    boolean
  required:  boolean | ((s: Record<string, string>) => boolean)
  help?:     string
  default?:  string
  options?:  string[]
}

export interface KindInfo {
  kind:     ProxyKind
  label:    string
  urlLabel: string
  urlHint:  string
  fields:   KindField[]
  notes:    string[]
}

const ssh = (s: Record<string, string>) => (s.transport ?? 'ssh') === 'ssh'

export const KINDS: Record<ProxyKind, KindInfo> = {
  npm: {
    kind: 'npm', label: KIND_LABEL.npm, urlLabel: 'NPM URL', urlHint: 'http://192.0.2.10:81',
    fields: [
      { key: 'email', label: 'Email', secret: false, required: true },
      { key: 'password', label: 'Password', secret: true, required: true },
    ],
    notes: ['Every NPM host is editable, as before. Use an administrator login, or NPM shows only that user’s hosts.'],
  },
  traefik: {
    kind: 'traefik', label: KIND_LABEL.traefik, urlLabel: 'Traefik API URL', urlHint: 'http://192.0.2.10:8080',
    fields: [
      { key: 'api_user', label: 'API user (basic auth)', secret: false, required: false },
      { key: 'api_password', label: 'API password', secret: true, required: false },
      { key: 'file', label: 'HyperProx’s dynamic file', secret: false, required: true, default: '/etc/traefik/dynamic/hyperprox.yml',
        help: 'A file of its own inside the directory Traefik’s file provider watches. HyperProx rewrites it whole.' },
      { key: 'entrypoints', label: 'Entry points', secret: false, required: true, default: 'web', help: 'Comma-separated.' },
      { key: 'cert_resolver', label: 'Certificate resolver', secret: false, required: false, help: 'Set to give HyperProx’s routers TLS from this resolver.' },
      { key: 'transport', label: 'How HyperProx writes the file', secret: false, required: true, default: 'ssh', options: ['ssh', 'guest'],
        help: 'ssh: an SFTP login. guest: the Managed container, through its node.' },
      { key: 'ssh_host', label: 'SSH host', secret: false, required: ssh },
      { key: 'ssh_port', label: 'SSH port', secret: false, required: false, default: '22' },
      { key: 'ssh_user', label: 'SSH user', secret: false, required: ssh },
      { key: 'ssh_password', label: 'SSH password', secret: true, required: false },
      { key: 'ssh_private_key', label: 'SSH private key', secret: true, required: false },
      { key: 'ssh_host_key', label: 'Pinned host key', secret: false, required: false, help: 'Learned when the instance is added; the server must keep offering it.' },
    ],
    notes: ['Routers from labels, other files and other providers are shown read-only.',
      'Traefik has no off switch: a disabled host answers 403.'],
  },
  caddy: {
    kind: 'caddy', label: KIND_LABEL.caddy, urlLabel: 'Admin API URL', urlHint: 'http://192.0.2.10:2019',
    fields: [
      { key: 'server', label: 'Server', secret: false, required: false, help: 'The apps.http server to use; empty picks the one on :80/:443.' },
      { key: 'admin_user', label: 'Basic auth user', secret: false, required: false, help: 'Only if the admin API sits behind something that checks it.' },
      { key: 'admin_password', label: 'Basic auth password', secret: true, required: false },
    ],
    notes: ['Caddy’s admin API has no login of its own: expose it only to HyperProx.',
      'Run Caddy with --resume, or a restart loses the hosts HyperProx adds.'],
  },
  haproxy: {
    kind: 'haproxy', label: KIND_LABEL.haproxy, urlLabel: 'Data Plane API URL', urlHint: 'http://192.0.2.10:5555',
    fields: [
      { key: 'user', label: 'Data Plane user', secret: false, required: true },
      { key: 'password', label: 'Data Plane password', secret: true, required: true },
      { key: 'frontend', label: 'Frontend', secret: false, required: false, help: 'Where HyperProx adds its rules; empty picks the first.' },
    ],
    notes: ['Every change is validated with haproxy -c before HAProxy reloads.'],
  },
  pangolin: {
    kind: 'pangolin', label: KIND_LABEL.pangolin, urlLabel: 'Integration API URL', urlHint: 'https://pangolin.example.invalid:3003/v1',
    fields: [
      { key: 'api_key', label: 'API key', secret: true, required: true, help: 'An organisation key with the resource, target and site actions.' },
      { key: 'org_id', label: 'Organisation id', secret: false, required: true },
      { key: 'site_id', label: 'Site id', secret: false, required: false, help: 'Empty uses the organisation’s first site.' },
    ],
    notes: ['A Pangolin host has one name, under one of the organisation’s domains.'],
  },
}

export function settingKeys(kind: ProxyKind): string[] { return KINDS[kind].fields.filter(f => !f.secret).map(f => f.key) }
export function secretKeys(kind: ProxyKind): string[] { return KINDS[kind].fields.filter(f => f.secret).map(f => f.key) }

export interface BuildDeps {
  fetch?: FetchLike
  /** The guest transport: a script runner for the instance's Managed container. */
  guestExec?: (node: string, vmid: number) => GuestExec
  /** Tests: the Traefik file transport, in place of SSH or the guest. */
  fileTransport?: (inst: ProxyInstance) => FileTransport
}

/** Build the provider for an instance from its settings and secrets. */
export function buildProvider(inst: ProxyInstance, secrets: Record<string, string>, deps: BuildDeps = {}): ProxyProvider {
  const s = inst.settings
  const need = (k: string, v: string | undefined, label: string) => { if (!v) throw new ProxyRefusal(`${inst.name}: ${label} is not set.`, 400); return v }
  switch (inst.kind) {
    case 'npm':
      return new NpmProvider({ url: inst.url, email: need('email', s.email, 'the NPM email'), password: need('password', secrets.password, 'the NPM password') }, deps.fetch)
    case 'traefik': {
      const transport = deps.fileTransport ? deps.fileTransport(inst) : (s.transport ?? 'ssh') === 'guest'
        ? (() => {
            if (!inst.managed) throw new ProxyRefusal(`${inst.name}: the guest transport needs a Managed instance (its container is not known).`, 400)
            if (!deps.guestExec) throw new ProxyRefusal(`${inst.name}: the guest transport is not available here.`, 400)
            return new GuestFileTransport(deps.guestExec(inst.managed.node, inst.managed.vmid), `container ${inst.managed.vmid} on ${inst.managed.node}`)
          })()
        : new SshFileTransport({
            host: need('ssh_host', s.ssh_host, 'the SSH host'), port: Number(s.ssh_port || 22), username: need('ssh_user', s.ssh_user, 'the SSH user'),
            password: secrets.ssh_password || undefined, privateKey: secrets.ssh_private_key || undefined, hostKey: s.ssh_host_key || undefined,
          })
      return new TraefikProvider({
        apiUrl: inst.url, file: need('file', s.file, 'the dynamic file'),
        auth: s.api_user ? { basic: { user: s.api_user, password: secrets.api_password ?? '' } } : {},
        entryPoints: (s.entrypoints || 'web').split(',').map(x => x.trim()).filter(Boolean),
        certResolver: s.cert_resolver || undefined, transport,
      }, deps.fetch)
    }
    case 'caddy':
      return new CaddyProvider({ adminUrl: inst.url, server: s.server || undefined,
        auth: s.admin_user ? { basic: { user: s.admin_user, password: secrets.admin_password ?? '' } } : {} }, deps.fetch)
    case 'haproxy':
      return new HaproxyProvider({ url: inst.url, frontend: s.frontend || undefined,
        auth: { basic: { user: need('user', s.user, 'the Data Plane user'), password: need('password', secrets.password, 'the Data Plane password') } } }, deps.fetch)
    case 'pangolin':
      return new PangolinProvider({ url: inst.url, apiKey: need('api_key', secrets.api_key, 'the API key'),
        orgId: need('org_id', s.org_id, 'the organisation id'), siteId: s.site_id ? Number(s.site_id) : undefined }, deps.fetch)
  }
}
