// =============================================================================
//  HyperProx — Proxy providers: the one interface
//
//  Every reverse proxy HyperProx drives (Nginx Proxy Manager, Traefik, Caddy,
//  HAProxy, Pangolin) is reached through ProxyProvider. The Proxy page, the
//  AI wizard's proxy step and the certificate inventory all read and write
//  through it, so a second NPM, or a Caddy beside an NPM, is just another
//  instance in the registry.
//
//  Ownership: a provider marks each host it reads as `owned` (created by
//  HyperProx, safe to change) or not. A host made outside HyperProx is shown
//  read-only and never rewritten; the plan layer refuses a write to it before
//  the provider is asked, and each provider refuses again.
// =============================================================================

export type ProxyKind = 'npm' | 'traefik' | 'caddy' | 'haproxy' | 'pangolin'
export const PROXY_KINDS: ProxyKind[] = ['npm', 'traefik', 'caddy', 'haproxy', 'pangolin']

export const KIND_LABEL: Record<ProxyKind, string> = {
  npm: 'Nginx Proxy Manager', traefik: 'Traefik', caddy: 'Caddy', haproxy: 'HAProxy', pangolin: 'Pangolin',
}

/** NPM-only options a host may carry; the other providers ignore them. */
export interface NpmExtras {
  certificate_id?:          number | false
  ssl_forced?:              boolean
  block_exploits?:          boolean
  http2_support?:           boolean
  hsts_enabled?:            boolean
  hsts_subdomains?:         boolean
  caching_enabled?:         boolean
  advanced_config?:         string
}

/** What a caller asks for: the same shape for every provider. */
export interface HostSpec {
  domains:       string[]
  forwardScheme: 'http' | 'https'
  forwardHost:   string
  forwardPort:   number
  enabled:       boolean
  websockets?:   boolean
  npm?:          NpmExtras
}

export interface HostTls {
  /** none: plain HTTP. certificate: a certificate the proxy holds (id below). auto: the proxy gets its own (ACME). */
  kind:           'none' | 'certificate' | 'auto'
  certificateId?: string
  expiresAt?:     string | null
  forced?:        boolean
}

/** One host as a provider reads it. */
export interface ProxyHostRecord {
  /** Provider-local id: NPM's number, Traefik's router, Caddy's @id, HAProxy's backend, Pangolin's resource. */
  id:            string
  domains:       string[]
  forwardScheme: 'http' | 'https'
  forwardHost:   string
  forwardPort:   number
  enabled:       boolean
  /** Created by HyperProx (or, for NPM, any host: NPM is driven whole, as before). */
  owned:         boolean
  /** Why a host is read-only, in words. */
  readOnlyReason?: string
  tls:           HostTls
  /** The proxy's own view of whether the host is serving, when it reports one. */
  online?:       boolean | null
  websockets?:   boolean
  /** A short provider-native summary for display (a Traefik rule, an HAProxy condition). */
  detail?:       string
  /** NPM: the native host, so the edit form keeps every NPM option. */
  native?:       Record<string, unknown>
}

/** A host with the instance that owns it, as the API returns it. */
export interface ProxyHostView extends ProxyHostRecord {
  instanceId:   string
  instanceName: string
  kind:         ProxyKind
  readOnly:     boolean
}

export interface ProxyCertificate {
  id:          string
  names:       string[]
  expiresAt:   string | null
  issuer:      string
  /** NPM: the native certificate, for the certificate inventory and housekeeping. */
  native?:     Record<string, unknown>
}

export interface HealthCheck { name: string; ok: boolean; detail: string; warn?: boolean }

export interface ProxyHealth {
  ok:       boolean
  version?: string
  checks:   HealthCheck[]
}

export interface ProviderCapabilities {
  /** list: the proxy holds certificates HyperProx can list. auto: it gets its own and says nothing about them. */
  certificates:       'list' | 'auto'
  requestCertificate: boolean
  /** Hosts may have more than one name. */
  multiDomain:        boolean
  /** What "disabled" means on this proxy, in words. */
  disabledMeans:      string
}

export interface ProxyProvider {
  readonly kind:         ProxyKind
  readonly capabilities: ProviderCapabilities
  health(): Promise<ProxyHealth>
  listHosts(): Promise<ProxyHostRecord[]>
  /** Returns the new host's id. */
  createHost(spec: HostSpec): Promise<string>
  updateHost(id: string, spec: HostSpec): Promise<void>
  deleteHost(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  listCertificates(): Promise<ProxyCertificate[]>
  requestCertificate?(domains: string[], email: string): Promise<ProxyCertificate>
}

// --- Instances -----------------------------------------------------------------------------------

export type InstanceMode = 'byo' | 'managed'

/** A Managed instance: installed by the Catalogue into a container HyperProx knows. */
export interface ManagedRef { node: string; vmid: number; recipe: string }

export interface ProxyInstance {
  id:        string
  kind:      ProxyKind
  name:      string
  /** The API base the provider talks to (NPM's UI/API, Traefik's API, Caddy's admin, Data Plane, Pangolin's integration API). */
  url:       string
  mode:      InstanceMode
  managed:   ManagedRef | null
  /** Non-secret options per kind (see providers/*: settings). */
  settings:  Record<string, string>
  /** The instance backed by the old single NPM login (Settings → Proxy). It cannot be removed here. */
  legacy?:   boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** Thrown for a request HyperProx refuses (bad input, read-only host): the routes answer 400/409, not 500. */
export class ProxyRefusal extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'ProxyRefusal' }
}
