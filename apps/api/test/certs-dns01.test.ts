// DNS-01 records: zone matching, the GoDaddy provider over a pretend GoDaddy (adding a value keeps the others,
// cleanup removes only ours, other names are never touched), and the authoritative propagation wait.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findZone, relativeName, godaddyProvider, waitForPropagation, CHALLENGE_TTL } from '../src/lib/certs/dns01'
import type { GoDaddyClient, DNSRecord, DNSRecordType } from '../src/lib/godaddy-client'
import { startTxtServer } from './fakes/pebble-dns'

test('findZone: longest suffix at a label boundary', () => {
  const zones = ['example.com', 'lab.example.com', 'example.org', 'ample.com']
  assert.equal(findZone('mail.example.com', zones), 'example.com')
  assert.equal(findZone('example.com', zones), 'example.com')
  assert.equal(findZone('host.lab.example.com', zones), 'lab.example.com')
  assert.equal(findZone('lab.example.com', zones), 'lab.example.com')
  assert.equal(findZone('*.lab.example.com', zones), 'lab.example.com')
  assert.equal(findZone('*.example.com', zones), 'example.com')
  assert.equal(findZone('MAIL.Example.COM.', zones), 'example.com')
  assert.equal(findZone('notexample.com', zones), null, 'a suffix that is not a label boundary')
  assert.equal(findZone('ample.com', zones), 'ample.com')
  assert.equal(findZone('example.net', zones), null)
  assert.equal(findZone('mail.example.com', []), null)
  assert.equal(findZone('mail.example.com', ['Example.COM.']), 'example.com')
})

test('relativeName', () => {
  assert.equal(relativeName('example.com', '_acme-challenge.mail.example.com'), '_acme-challenge.mail')
  assert.equal(relativeName('example.com', '_acme-challenge.example.com'), '_acme-challenge')
  assert.equal(relativeName('example.com', 'example.com'), '@')
  assert.throws(() => relativeName('example.com', '_acme-challenge.example.org'), /not inside zone/)
})

// --- A pretend GoDaddy, with the real client's semantics: PATCH appends, PUT replaces a name, DELETE drops it.

class FakeGoDaddy {
  records: Record<string, DNSRecord[]> = { 'example.com': [], 'example.org': [] }
  calls: string[] = []
  failOn: string | null = null

  private hit(call: string) {
    this.calls.push(call)
    if (this.failOn && call.startsWith(this.failOn)) throw new Error(`GoDaddy ${call} failed 500`)
  }
  async getDomains() {
    this.hit('GET domains')
    return Object.keys(this.records).map(domain => ({ domain, status: 'ACTIVE' }))
  }
  async getRecords(domain: string, type?: DNSRecordType) {
    this.hit(`GET ${domain} ${type}`)
    return this.records[domain].filter(r => !type || r.type === type).map(r => ({ ...r }))
  }
  async createRecord(domain: string, record: DNSRecord) {
    this.hit(`PATCH ${domain} ${record.type} ${record.name} ${record.data}`)
    this.records[domain].push({ ...record })
  }
  async updateRecord(domain: string, type: DNSRecordType, name: string, record: Partial<DNSRecord>) {
    this.hit(`PUT ${domain} ${type} ${name} ${record.data}`)
    this.records[domain] = this.records[domain].filter(r => !(r.type === type && r.name === name))
    this.records[domain].push({ type, name, data: record.data!, ttl: record.ttl ?? 3600 })
  }
  async deleteRecord(domain: string, type: DNSRecordType, name: string) {
    this.hit(`DELETE ${domain} ${type} ${name}`)
    this.records[domain] = this.records[domain].filter(r => !(r.type === type && r.name === name))
  }
  txt(domain: string, name: string) {
    return this.records[domain].filter(r => r.type === 'TXT' && r.name === name).map(r => r.data).sort()
  }
}

function setup() {
  const gd = new FakeGoDaddy()
  gd.records['example.com'].push(
    { type: 'TXT', name: '@', data: 'v=spf1 -all', ttl: 3600 },
    { type: 'TXT', name: '_acme-challenge', data: 'someone-elses-token', ttl: 300 },
    { type: 'TXT', name: '_acme-challenge.www', data: 'other-name', ttl: 600 },
    { type: 'A', name: 'mail', data: '10.0.0.5', ttl: 600 },
  )
  return { gd, p: godaddyProvider(gd as unknown as GoDaddyClient) }
}

test('godaddy: zones are the active domains', async () => {
  const { p } = setup()
  assert.equal(p.name, 'godaddy')
  assert.deepEqual(await p.zones(), ['example.com', 'example.org'])
})

test('godaddy: present appends a TXT value with TTL 600 under the zone-relative name', async () => {
  const { gd, p } = setup()
  await p.present('example.com', '_acme-challenge.mail.example.com', 'v1')
  assert.deepEqual(gd.records['example.com'].at(-1), { type: 'TXT', name: '_acme-challenge.mail', data: 'v1', ttl: CHALLENGE_TTL })
  assert.equal(CHALLENGE_TTL, 600)
  assert.ok(!gd.calls.some(c => /^(PUT|DELETE)/.test(c)), 'present never replaces or deletes')
})

test('godaddy: apex + wildcard put two values on one name beside an existing one, and cleanup peels them off one by one', async () => {
  const { gd, p } = setup()
  const before = JSON.stringify(gd.records['example.com'].filter(r => r.name !== '_acme-challenge'))
  await p.present('example.com', '_acme-challenge.example.com', 'apex-value')
  await p.present('example.com', '_acme-challenge.example.com', 'wildcard-value')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge'), ['apex-value', 'someone-elses-token', 'wildcard-value'])

  await p.cleanup('example.com', '_acme-challenge.example.com', 'apex-value')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge'), ['someone-elses-token', 'wildcard-value'])
  await p.cleanup('example.com', '_acme-challenge.example.com', 'wildcard-value')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge'), ['someone-elses-token'])
  assert.equal(gd.records['example.com'].find(r => r.name === '_acme-challenge')!.ttl, 300, 'the survivor keeps its TTL')
  assert.ok(!gd.calls.some(c => c.startsWith('DELETE')), 'a name with a foreign value is never deleted')
  assert.equal(JSON.stringify(gd.records['example.com'].filter(r => r.name !== '_acme-challenge')), before, 'other names untouched')
})

test('godaddy: cleanup of the last value deletes the name, and only that name', async () => {
  const { gd, p } = setup()
  await p.present('example.com', '_acme-challenge.mail.example.com', 'only')
  await p.cleanup('example.com', '_acme-challenge.mail.example.com', 'only')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge.mail'), [])
  assert.deepEqual(gd.calls.filter(c => c.startsWith('DELETE')), ['DELETE example.com TXT _acme-challenge.mail'])
  assert.deepEqual(gd.txt('example.com', '_acme-challenge.www'), ['other-name'])
  assert.deepEqual(gd.txt('example.com', '@'), ['v=spf1 -all'])
})

test('godaddy: cleanup with several survivors restores all of them', async () => {
  const { gd, p } = setup()
  gd.records['example.com'].push(
    { type: 'TXT', name: '_acme-challenge', data: 'third', ttl: 300 },
    { type: 'TXT', name: '_acme-challenge', data: 'fourth', ttl: 900 },
  )
  await p.present('example.com', '_acme-challenge.example.com', 'ours')
  await p.cleanup('example.com', '_acme-challenge.example.com', 'ours')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge'), ['fourth', 'someone-elses-token', 'third'])
  const ttl = Object.fromEntries(gd.records['example.com'].filter(r => r.name === '_acme-challenge').map(r => [r.data, r.ttl]))
  assert.deepEqual(ttl, { 'someone-elses-token': 300, third: 300, fourth: 900 })
})

test('godaddy: present is idempotent and cleanup of an absent value writes nothing', async () => {
  const { gd, p } = setup()
  await p.present('example.com', '_acme-challenge.mail.example.com', 'v1')
  await p.present('example.com', '_acme-challenge.mail.example.com', 'v1')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge.mail'), ['v1'])
  gd.calls = []
  await p.cleanup('example.com', '_acme-challenge.example.com', 'never-written')
  assert.ok(gd.calls.every(c => c.startsWith('GET')), gd.calls.join(', '))
  assert.deepEqual(gd.txt('example.com', '_acme-challenge'), ['someone-elses-token'])
})

test('godaddy: names are matched case-insensitively and the apex is "@"', async () => {
  const { gd, p } = setup()
  await p.present('Example.com', '_ACME-Challenge.Mail.Example.com.', 'v1')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge.mail'), ['v1'])
  await p.cleanup('example.com', '_acme-challenge.mail.example.com', 'v1')
  assert.deepEqual(gd.txt('example.com', '_acme-challenge.mail'), [])
  await p.present('example.com', 'example.com', 'apex-txt')
  assert.deepEqual(gd.txt('example.com', '@'), ['apex-txt', 'v=spf1 -all'])
  await p.cleanup('example.com', 'example.com', 'apex-txt')
  assert.deepEqual(gd.txt('example.com', '@'), ['v=spf1 -all'])
})

test('godaddy: API errors surface', async () => {
  const { gd, p } = setup()
  gd.failOn = 'PATCH'
  await assert.rejects(p.present('example.com', '_acme-challenge.mail.example.com', 'v1'), /failed 500/)
  gd.failOn = 'GET example.com'
  await assert.rejects(p.cleanup('example.com', '_acme-challenge.mail.example.com', 'v1'), /failed 500/)
})

// --- Propagation, against pretend authoritative servers on loopback.

test('propagation: resolves once every authoritative server serves the value', async () => {
  const a = await startTxtServer(), b = await startTxtServer()
  try {
    const fqdn = '_acme-challenge.mail.example.com'
    a.txt.set(fqdn, ['old', 'v1'])
    setTimeout(() => b.txt.set(fqdn, ['v1']), 300)   // the second server lags
    let asked = ''
    const t0 = Date.now()
    await waitForPropagation(fqdn, 'v1', {
      zone: 'example.com', intervalMs: 100, timeoutMs: 5000,
      authoritative: async z => { asked = z; return [a.address, b.address] },
    })
    assert.equal(asked, 'example.com')
    assert.ok(Date.now() - t0 >= 250, 'waited for the lagging server')
    assert.ok(b.queries.length >= 2)
  } finally { await a.close(); await b.close() }
})

test('propagation: times out naming the servers that never saw it', async () => {
  const a = await startTxtServer(), b = await startTxtServer()
  try {
    const fqdn = '_acme-challenge.mail.example.com'
    a.txt.set(fqdn, ['v1'])
    b.txt.set(fqdn, ['something-else'])
    await assert.rejects(
      waitForPropagation(fqdn, 'v1', { zone: 'example.com', intervalMs: 50, timeoutMs: 300, authoritative: async () => [a.address, b.address] }),
      (e: Error) => e.message.includes(b.address) && !e.message.includes(a.address) && /not visible/.test(e.message),
    )
  } finally { await a.close(); await b.close() }
})

test('propagation: no authoritative servers is an error, not a pass', async () => {
  await assert.rejects(
    waitForPropagation('_acme-challenge.example.com', 'v1', { zone: 'example.com', authoritative: async () => [] }),
    /no authoritative name servers/,
  )
})

