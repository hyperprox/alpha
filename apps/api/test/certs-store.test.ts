// The in-memory Certificates store: the same rules the Prisma store keeps (one issuance per label,
// restart recovery, full probe runs replacing the list), so the service tests mean something.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCertsStore, RenewingError, probeView, eventView, type ProbeRecord } from '../src/lib/certs/store'

const probe = (host: string, port: number, over: Partial<ProbeRecord> = {}): ProbeRecord => ({
  host, port, starttls: 'none', source: 'policy', internal: false, checkedAt: null, verdict: null, reason: null,
  fingerprint: null, issuer: null, notAfter: null, trusted: null, namesMatch: null, ...over,
})

test('beginIssue creates the row on first issuance, refuses a second, and clears the last error', async () => {
  const s = new MemoryCertsStore()
  const r = await s.beginIssue('mail', ['mail.example.com'])
  assert.equal(r.status, 'renewing')
  await assert.rejects(s.beginIssue('mail', ['mail.example.com']), RenewingError)
  await s.updateManaged('mail', { status: 'failed', lastError: 'CA said no' })
  const again = await s.beginIssue('mail', ['mail.example.com', 'smtp.example.com'])
  assert.equal(again.lastError, null)
  assert.deepEqual(again.names, ['mail.example.com', 'smtp.example.com'])
})

test('recoverInterrupted releases only rows that were renewing', async () => {
  const s = new MemoryCertsStore()
  await s.beginIssue('a', ['a.example.com'])
  await s.beginIssue('b', ['b.example.com'])
  await s.updateManaged('b', { status: 'valid' })
  assert.deepEqual(await s.recoverInterrupted('restarted'), ['a'])
  assert.equal((await s.getManaged('a'))!.status, 'failed')
  assert.equal((await s.getManaged('b'))!.status, 'valid')
})

test('targets need their certificate; setTarget replaces by name', async () => {
  const s = new MemoryCertsStore()
  await assert.rejects(s.setTarget('nope', { name: 't', kind: 'hyperprox', lastDeployAt: null, ok: null, detail: null, fingerprint: null }))
  await s.beginIssue('mail', ['mail.example.com'])
  await s.setTarget('mail', { name: 't', kind: 'hyperprox', lastDeployAt: new Date(), ok: false, detail: 'x', fingerprint: 'AA' })
  await s.setTarget('mail', { name: 't', kind: 'hyperprox', lastDeployAt: new Date(), ok: true, detail: 'y', fingerprint: 'BB' })
  const t = await s.listTargets('mail')
  assert.equal(t.length, 1)
  assert.equal(t[0].ok, true)
})

test('replaceProbes keeps exactly the endpoints given; upsert is keyed on host and port', async () => {
  const s = new MemoryCertsStore()
  await s.upsertProbe(probe('a.example.com', 443))
  await s.upsertProbe(probe('A.example.com', 443, { verdict: 'ok' }))
  assert.equal((await s.listProbes()).length, 1)
  await s.replaceProbes([probe('b.example.com', 993), probe('b.example.com', 587)])
  assert.deepEqual((await s.listProbes()).map(p => `${p.host}:${p.port}`), ['b.example.com:587', 'b.example.com:993'])
  assert.equal(probeView(probe('c.example.com', 443)).verdict, 'unknown', 'never checked')
})

test('events: newest first, filtered by label, limited', async () => {
  const s = new MemoryCertsStore()
  await s.addEvent({ label: 'a', kind: 'issue', ok: true, detail: '1' })
  await s.addEvent({ label: null, kind: 'probe', ok: true, detail: '2' })
  await s.addEvent({ label: 'a', kind: 'deploy', ok: false, detail: '3' })
  assert.deepEqual((await s.listEvents(undefined, 10)).map(e => e.detail), ['3', '2', '1'])
  assert.deepEqual((await s.listEvents('a', 1)).map(e => e.detail), ['3'])
  const v = eventView((await s.listEvents('a', 1))[0])
  assert.equal(typeof v.at, 'string')
})

test('state values are copies, not shared references', async () => {
  const s = new MemoryCertsStore()
  const v = [{ key: 'k', verdict: 'ok' }]
  await s.setState('alerts', v)
  v[0].verdict = 'critical'
  assert.deepEqual(await s.getState('alerts'), [{ key: 'k', verdict: 'ok' }])
  assert.equal(await s.getState('missing'), null)
})
