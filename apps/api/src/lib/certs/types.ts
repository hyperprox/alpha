// =============================================================================
//  The shared Certificates types, as the API compiles them.
//
//  The source of truth is packages/types/src/certs.ts (@hyperprox/types). The
//  API compiles with rootDir ./src and cannot import it (see lib/updates/types.ts
//  for why). Everything below the marker is a verbatim copy, and
//  test/certs-types.test.ts fails if the two drift.
// =============================================================================
// --- verbatim copy below ---
// --- Certificates --------------------------------------------------------------
// Shared by the Certificates API (apps/api/src/routes/certs.ts) and page (apps/frontend/app/certificates).

export type CertsVerdict = 'ok' | 'warn' | 'critical' | 'error' | 'unknown'
export type CertsStartTls = 'none' | 'smtp' | 'imap' | 'pop3'

/** One certificate the network has, wherever it comes from. */
export type CertsInventoryEntry = {
  id:           string                     // stable: `${source}:${key}`
  source:       'npm' | 'managed' | 'pve' | 'pbs' | 'probe'
  names:        string[]
  issuer:       string | null
  notBefore:    string | null
  notAfter:     string | null
  lifetimeDays: number | null
  daysLeft:     number | null
  renewal:      string                     // how it renews, in words: "Proxy (HTTP-01)", "HyperProx (DNS-01)", ...
  selfSigned:   boolean
  staging:      boolean
  verdict:      CertsVerdict
  reason:       string | null              // one line, user-facing
  usedBy:       string[]                   // endpoints / hosts / targets using it
}

/** A live TLS check of one endpoint. */
export type CertsProbe = {
  host:        string
  port:        number
  starttls:    CertsStartTls
  source:      'policy' | 'proxy' | 'node' | 'managed'
  internal:    boolean                     // self-signed is expected here
  checkedAt:   string | null
  verdict:     CertsVerdict
  reason:      string | null
  fingerprint: string | null               // SHA-256 of the served leaf
  issuer:      string | null
  notAfter:    string | null
  trusted:     boolean | null
  namesMatch:  boolean | null
}

export type CertsTargetState = {
  name:         string
  kind:         'guest-files' | 'hyperprox'
  lastDeployAt: string | null
  lastResult:   string | null
  verdict:      CertsVerdict
}

/** A certificate HyperProx issues and renews itself (DNS-01). */
export type CertsManaged = {
  label:      string
  names:      string[]
  status:     'pending' | 'valid' | 'renewing' | 'failed'
  issuer:     string | null
  notBefore:  string | null
  notAfter:   string | null
  renewAfter: string | null
  ariStart:   string | null
  ariEnd:     string | null
  staging:    boolean
  lastError:  string | null
  dns:        { name: string; zone: string | null; provider: string | null }[]   // zone null: no managed DNS zone covers it
  targets:    CertsTargetState[]
}

export type CertsEvent = {
  id:     string
  label:  string | null
  kind:   'issue' | 'renew' | 'deploy' | 'probe' | 'housekeeping' | 'alert'
  ok:     boolean
  detail: string
  at:     string
}

export type CertsHousekeepingItem = {
  id:        string
  kind:      'proxy-expired-unused' | 'proxy-orphan-files'
  names:     string[]
  expiredAt: string | null
  detail:    string
}

export type CertsPolicyStatus = {
  loaded:   boolean
  path:     string
  error?:   string
  acme:     { directory: string; staging: boolean; email: string | null }
  schedule: { cron: string; nextRun: string | null }
}

export type CertsOverview = {
  policy:    CertsPolicyStatus
  inventory: CertsInventoryEntry[]
  probes:    CertsProbe[]
  managed:   CertsManaged[]
  checkedAt: string | null
}
