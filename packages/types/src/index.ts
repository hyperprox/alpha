// =============================================================================
//  HyperProx — Shared Types
// =============================================================================

// --- Proxmox -----------------------------------------------------------------

export type NodeStatus = 'online' | 'offline' | 'unknown'
export type VMStatus   = 'running' | 'stopped' | 'paused' | 'suspended'

export interface ProxmoxNode {
  id:         string
  name:       string
  status:     NodeStatus
  cpu:        number        // 0-1
  maxcpu:     number
  mem:        number        // bytes
  maxmem:     number
  disk:       number
  maxdisk:    number
  uptime:     number        // seconds
  type:       'node'
  roles?:     string[]      // e.g. ['gpu', 'primary']
}

export interface ProxmoxVM {
  vmid:       number
  name:       string
  status:     VMStatus
  type:       'qemu' | 'lxc'
  node:       string
  cpu:        number
  cpus:       number
  mem:        number
  maxmem:     number
  disk:       number
  maxdisk:    number
  uptime:     number
  netIn:      number
  netOut:     number
  tags?:      string[]
}

// --- Proxy -------------------------------------------------------------------

// Every kind is implemented (apps/api/src/lib/proxy/providers); the API's own types are in lib/proxy/types.ts.
export type ProxyProvider  = 'npm' | 'traefik' | 'caddy' | 'haproxy' | 'pangolin'
export type SSLStatus      = 'valid' | 'expiring' | 'expired' | 'none' | 'pending'

export interface ProxyHost {
  id:           string
  domain:       string
  target:       string
  port:         number
  ssl:          SSLStatus
  sslExpiry?:   string
  enabled:      boolean
  provider:     ProxyProvider
  /** The proxy instance that owns the host (several instances may share a kind). */
  instanceId?:  string
  /** Made outside HyperProx: shown, never rewritten. */
  readOnly?:    boolean
  containerId?: number
}

// --- DNS ---------------------------------------------------------------------

export type DNSProvider  = 'godaddy' | 'cloudflare' | 'namecheap' | 'route53' | 'porkbun'
export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'NS'

export interface DNSRecord {
  id:       string
  type:     DNSRecordType
  name:     string
  value:    string
  ttl:      number
  domain:   string
  provider: DNSProvider
}

// --- Events ------------------------------------------------------------------

export type EventSeverity = 'info' | 'warning' | 'error' | 'success'

export interface ClusterEvent {
  id:        string
  timestamp: string
  severity:  EventSeverity
  source:    string
  message:   string
  nodeId?:   string
  vmid?:     number
}

// --- API Response envelope ---------------------------------------------------

export interface ApiResponse<T> {
  success: boolean
  data?:   T
  error?:  string
  meta?: {
    page?:  number
    total?: number
  }
}

// --- WebSocket messages ------------------------------------------------------

export type WSEventType =
  | 'node:update'
  | 'vm:update'
  | 'cluster:event'
  | 'proxy:update'
  | 'dns:update'
  | 'task:update'

export interface WSMessage {
  type:      WSEventType
  payload:   unknown
  timestamp: string
}

// Updates feature
export * from './updates'

// Certificates feature
export * from './certs'

// Remote access feature
export * from './remote'

// Plug-in pages: the numbers behind the visuals
export * from './plugin-visual'
