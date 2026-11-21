// The simple Updates view: its status line in every state, the check-then-update flow (with fakes, nothing is
// called for real), plain sentences instead of raw refusals, and the daily check card's partial explanation.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/updates-simple.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { SimpleUpdates } from '../components/updates/SimpleUpdates'
import { CheckPanel } from '../components/updates/ClusterBits'
import { planFacts, freshness, statusLine, updateNow, plainRefusal, partialWhy, progressOf, finishedLine, autoInstallLine, confirmSentence, CHECKING_NOW_TEXT, UP_TO_DATE_TEXT, type UpdateNowDeps } from '../lib/updates-simple'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const mins = (n: number) => new Date(NOW - n * 60_000).toISOString()
const row = (extra: object = {}): any => ({ cluster: { id: 'home', name: 'Home', kind: 'home' }, at: mins(5), result: 'ok', lastOkAt: mins(5), targets: [], unread: [], available: 0, packages: 0, security: 0, ...extra })
const tgt = (name: string, security: string[] = []) => ({ kind: 'node', name, packages: 3, security, kernel: false, rebootNeeded: false, held: 0 })
const line = (r: any, extra: object = {}) => statusLine({ row: r, checking: false, phase: null, job: null, loaded: true, now: NOW, ...extra })
const step = (target: string, status: string, seq = 1): any => ({ id: `${target}${seq}`, seq, target, action: 'apt', status })
const job = (steps: any[], status = 'running', extra: object = {}): any => ({ id: 'j', trigger: 'manual', status, plan: { steps: [], warnings: [] }, startedAt: mins(10), steps, ...extra })

test('freshness: complete and under an hour is fresh; older is stale; skipped or unread is partial', () => {
  assert.equal(freshness(row(), NOW), 'fresh')
  assert.equal(freshness(row({ at: mins(61) }), NOW), 'stale')
  assert.equal(freshness(row({ result: 'skipped', reason: 'HyperProx is locked' }), NOW), 'partial')
  assert.equal(freshness(row({ result: 'partial', unread: ['node a: x'] }), NOW), 'partial')
  assert.equal(freshness(null, NOW), 'none')
})

test('status line in every state', () => {
  assert.equal(line(row()).text, 'Everything is up to date')
  assert.match(line(row()).sub, /Last full check/)
  const two = line(row({ available: 2, targets: [tgt('a', ['openssl']), tgt('b')] }))
  assert.equal(two.text, '2 machines have updates (1 security)')
  assert.equal(line(row({ available: 1, targets: [tgt('a')] })).text, '1 machine has updates')
  assert.equal(line(row(), { checking: true }).text, 'Checking…')
  assert.equal(line(row(), { phase: 'Checking first…' }).text, 'Checking first…')
  const steps = [...['a', 'b', 'c'].map((n, i) => step(n, i === 0 ? 'ok' : 'pending')), step('cluster', 'ok')]
  assert.equal(line(row(), { job: job(steps) }).text, 'Updating 2 of 3…')
  assert.equal(line(null).text, 'Not checked yet')
  const part = line(row({ result: 'skipped', reason: 'HyperProx is locked, so it has no credentials to read with' }))
  assert.match(part.text, /could not read everything/)
  assert.match(part.sub, /locked.*checks again shortly after you sign in/)
  assert.match(line(row(), { job: job([], 'awaiting-confirm') }).text, /waiting for your OK/)
  assert.match(line(row(), { job: job([], 'awaiting-confirm', { pauseReason: 'The plan changed since you confirmed it.' }) }).sub, /plan changed/)
})

test('progress is a per-machine list with ticks', () => {
  const rows = progressOf(job([step('a', 'ok'), step('b', 'running'), step('c', 'pending'), step('d', 'failed'), step('cluster', 'ok')]))
  assert.deepEqual(rows.map(r => `${r.name}:${r.state}`), ['a:done', 'b:working', 'c:waiting', 'd:failed'])
  const html = renderToStaticMarkup(<SimpleUpdates status={line(row())} buttonLabel="Update now" canUpdate message={null} auto={null} onToggleAuto={() => {}} onUpdateNow={() => {}} job={job([step('a', 'ok'), step('b', 'pending')])} lastJob={null} onJobAction={() => {}} busy={false} />)
  assert.match(html, /✓/); assert.match(html, /waiting/)
  assert.match(finishedLine(job([step('a', 'ok')], 'done', { finishedAt: mins(2) })) ?? '', /1 machine updated, nothing needs attention/)
  assert.match(finishedLine(job([step('a', 'failed')], 'failed')) ?? '', /need/)
})

const deps = (over: Partial<UpdateNowDeps> & { log?: string[] } = {}): UpdateNowDeps => {
  const log = over.log ?? []
  return {
    row: () => row({ at: mins(180) }), now: () => NOW,
    checkAndWait: async () => { log.push('check'); return true },
    readSelection: async () => ['node:a', 'guest:101'],
    rowAfter: async () => row(),
    preview: async () => { log.push('preview'); return { plan: { steps: [], warnings: [] }, planHash: 'h'.repeat(64) } },
    confirm: async () => { log.push('confirm'); return true },
    start: async (_ids, hash) => { log.push(`start:${hash.length}`) },
    say: t => { if (t) log.push(`say:${t}`) }, phase: t => { if (t) log.push(`phase:${t}`) },
    ...over,
  }
}

test('Update now with an old check: checks first, then one confirmation, then runs the whole plan', async () => {
  const log: string[] = []
  assert.equal(await updateNow(deps({ log })), 'started')
  assert.deepEqual(log, ['phase:Checking first…', 'check', 'preview', 'confirm', 'start:64'])
})
test('Update now with a fresh complete check does not check again', async () => {
  const log: string[] = []
  assert.equal(await updateNow(deps({ log, row: () => row() })), 'started')
  assert.deepEqual(log, ['preview', 'confirm', 'start:64'])
})
test('a partial check is checked again before anything runs', async () => {
  const log: string[] = []
  await updateNow(deps({ log, row: () => row({ result: 'partial', unread: ['x'] }) }))
  assert.equal(log[1], 'check')
})
test('nothing to update after a full check says so and never asks or starts', async () => {
  const log: string[] = []
  assert.equal(await updateNow(deps({ log, readSelection: async () => [] })), 'up-to-date')
  assert.ok(log.includes(`say:${UP_TO_DATE_TEXT}`)); assert.ok(!log.includes('confirm') && !log.some(l => l.startsWith('start')) && !log.includes('preview'))
})
test('nothing to update after a partial check does not claim everything is current', async () => {
  const log: string[] = []
  const r = await updateNow(deps({ log, readSelection: async () => [], rowAfter: async () => row({ result: 'partial', unread: ['x'] }) }))
  assert.equal(r, 'nothing')
  assert.ok(!log.includes(`say:${UP_TO_DATE_TEXT}`))
})
test('declining the one question starts nothing; a failed check starts nothing', async () => {
  const log: string[] = []
  assert.equal(await updateNow(deps({ log, confirm: async () => false })), 'declined')
  assert.ok(!log.some(l => l.startsWith('start')))
  assert.equal(await updateNow(deps({ checkAndWait: async () => false })), 'not-checked')
})

test('refusals become plain sentences, never the server text', () => {
  assert.match(plainRefusal({ status: 409, code: 'check_busy' }, 'x'), /still reading the machines/)
  assert.match(plainRefusal({ status: 400, code: 'invalid_request', error: 'select must be a list of 1 to 500 target ids from /targets' }, 'start the update'), /^Could not start the update/)
  assert.equal(plainRefusal({ status: 403 }, 'x'), 'Updates is limited to admins.')
  assert.equal(plainRefusal({ status: 400, error: 'Pick at least one machine, or run Check now first.' }, 'x'), 'Pick at least one machine, or run Check now first.')
})

test('the confirmation is one sentence from the real plan: counts, snapshots that cannot be taken, exceptions, reboots', () => {
  const plan: any = {
    steps: [{ target: 'cluster', action: 'preflight' }, { target: '101', action: 'snapshot', detail: 'before updating' }, { target: '102', action: 'snapshot', detail: 'not possible — bind-mounted storage' }, { target: 'node-a', action: 'node-upgrade' }],
    refused: [{ id: 'node:b:pkg:x', reason: 'a held package' }],
  }
  const facts = planFacts(plan, t => (t === '102' ? '102 media' : t))
  assert.deepEqual([facts.machines, facts.noSnapshot, facts.refused], [3, ['102 media'], ['a held package']])
  const rb: any = { available: true, settings: { nodes: true, guests: false, window: { start: '09:00', hours: 3, days: [] } }, nextWindow: { start: 'x', end: 'y' }, byHand: [{ target: 'n1', reason: 'policy' }] }
  const t = confirmSentence({ facts, remote: false, reboots: rb })
  assert.match(t, /3 machines/); assert.match(t, /where possible \(1 can't: 102 media/); assert.doesNotMatch(t, /Each guest gets a snapshot/)
  assert.match(t, /1 thing in your choice will not run: a held package/); assert.match(t, /09:00–12:00/); assert.match(t, /by hand/); assert.match(t, /asked again/)
  assert.match(confirmSentence({ facts: planFacts({ steps: [] }), remote: true, reboots: null }), /remote server by itself/)
  assert.equal(autoInstallLine('08:00', rb), 'Every morning at 08:00, reboots 09:00–12:00.')
})

test('the switch and button render; the switch is off by default', () => {
  const p: any = { status: line(row()), buttonLabel: 'Update now', canUpdate: true, message: null, onToggleAuto: () => {}, onUpdateNow: () => {}, job: null, lastJob: null, onJobAction: () => {}, busy: false }
  const html = renderToStaticMarkup(<SimpleUpdates {...p} auto={{ enabled: false, line: 'Every morning at 08:00, reboots 09:00–12:00.', canChange: true }} />)
  assert.match(html, /Everything is up to date/); assert.match(html, /Update now/)
  assert.match(html, /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/)
  assert.match(html, /every morning at 08:00/)
})

test('the daily check card explains a partial result and offers Check now prominently', () => {
  const r = row({ result: 'partial', reason: 'stopped early: an Updates run was started; the machines not read are listed' })
  assert.match(partialWhy(r), /update was started while the check was reading/)
  const html = renderToStaticMarkup(<CheckPanel status={{ running: false, lastRun: null, nextRun: null, lastNotified: null, clusters: [r] } as any} error={null} busy={false} onCheck={() => {}} current="home" />)
  assert.match(html, /Why: An update was started/)
  assert.match(html, /Check now/)
})

test('the page never sends an empty selection and keeps everything under Advanced', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/updates/page.tsx'), 'utf8')
  assert.match(src, /if \(!ids\.length\) return \{ error: EMPTY_SELECTION_TEXT \}/)
  assert.match(src, /nothingToUpdate/)
  assert.ok(CHECKING_NOW_TEXT.startsWith('Nothing to update yet'))
  assert.ok(src.indexOf('<SimpleUpdates') < src.indexOf('>Advanced<') && src.indexOf('>Advanced<') < src.indexOf('<PolicyStrip') && src.indexOf('<PolicyStrip') < src.indexOf('<RebootsCard'))
  for (const keep of ['<History', '<TargetTree', '<CheckPanel', '<RebootsCard', 'Dry run'.length ? '<PolicyStrip' : '']) assert.ok(src.includes(keep), keep)
})
