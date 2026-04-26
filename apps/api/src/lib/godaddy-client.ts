// =============================================================================
//  HyperProx — GoDaddy DNS API Client
// =============================================================================

export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'NS' | 'CAA'

export interface DNSRecord {
  type:   DNSRecordType
  name:   string
  data:   string
  ttl:    number
  priority?: number  // MX / SRV
}

export interface Domain {
  domain:       string
  domainId:     number
  status:       string
  createdAt:    string
  expires?:     string
  renewAuto:    boolean
  locked:       boolean
  nameServers:  string[] | null
}

export interface WanInfo {
  ip:      string
  source:  string
}

export class GoDaddyClient {
  private baseUrl = 'https://api.godaddy.com/v1'
  private authHeader: string

  constructor(apiKey: string, apiSecret: string) {
    this.authHeader = `sso-key ${apiKey}:${apiSecret}`
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization:  this.authHeader,
        Accept:         'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`GoDaddy ${method} ${path} failed ${res.status}: ${err}`)
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as any
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  //  Domains
  // ---------------------------------------------------------------------------

  async getDomains(): Promise<Domain[]> {
    const all = await this.req<Domain[]>('GET', '/domains?limit=100')
    return all.filter(d => d.status === 'ACTIVE')
  }

  async getDomain(domain: string): Promise<Domain> {
    return this.req<Domain>('GET', `/domains/${domain}`)
  }

  // ---------------------------------------------------------------------------
  //  Records
  // ---------------------------------------------------------------------------

  async getRecords(domain: string, type?: DNSRecordType): Promise<DNSRecord[]> {
    const path = type
      ? `/domains/${domain}/records/${type}`
      : `/domains/${domain}/records`
    return this.req<DNSRecord[]>('GET', path)
  }

  async createRecord(domain: string, record: DNSRecord): Promise<void> {
    await this.req('PATCH', `/domains/${domain}/records`, [record])
  }

  async updateRecord(domain: string, type: DNSRecordType, name: string, record: Partial<DNSRecord>): Promise<void> {
    await this.req('PUT', `/domains/${domain}/records/${type}/${encodeURIComponent(name)}`, [record])
  }

  async deleteRecord(domain: string, type: DNSRecordType, name: string): Promise<void> {
    await this.req('DELETE', `/domains/${domain}/records/${type}/${encodeURIComponent(name)}`)
  }

  // ---------------------------------------------------------------------------
  //  WAN IP detection
  // ---------------------------------------------------------------------------

  static async getWanIP(): Promise<WanInfo> {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
      const { ip } = await res.json() as { ip: string }
      return { ip, source: 'ipify' }
    } catch {
      try {
        const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) })
        const ip  = (await res.text()).trim()
        return { ip, source: 'amazonaws' }
      } catch {
        return { ip: 'unknown', source: 'failed' }
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  DDNS — update all A records for a domain to current WAN IP
  // ---------------------------------------------------------------------------

  async updateDDNS(domain: string, excludeNames: string[] = []): Promise<{
    updated: string[]; skipped: string[]; wanIP: string
  }> {
    const { ip: wanIP } = await GoDaddyClient.getWanIP()
    const records = await this.getRecords(domain, 'A')

    const updated: string[] = []
    const skipped: string[] = []

    for (const record of records) {
      if (excludeNames.includes(record.name)) { skipped.push(record.name); continue }
      if (record.data === wanIP)              { skipped.push(record.name); continue }

      await this.updateRecord(domain, 'A', record.name, { ...record, data: wanIP })
      updated.push(record.name)
    }

    return { updated, skipped, wanIP }
  }

  // ---------------------------------------------------------------------------
  //  Stats
  // ---------------------------------------------------------------------------

  async getStats(domain: string): Promise<{
    total: number; byType: Record<string, number>
  }> {
    const records = await this.getRecords(domain)
    const byType: Record<string, number> = {}
    for (const r of records) {
      byType[r.type] = (byType[r.type] ?? 0) + 1
    }
    return { total: records.length, byType }
  }
}
