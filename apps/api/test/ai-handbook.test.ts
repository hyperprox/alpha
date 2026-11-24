// The AI operator's handbook (phase 2): playbooks and house rules, the markdown importer, keyword retrieval, the
// context that goes into a prompt (sized for a 16K local model), read-only live readings, cloud answers that draft a
// playbook, redaction of all of it before the cloud, the handbook routes, and the baseline question (a download at 0%
// with no seeders) answered by the "queued is not dead" logic. Every playbook, rule and reading here is invented.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {
  askOperator, defaultSettings, normalizeSettings, MemoryOperatorStore,
  MemoryPlaybookStore, parsePlaybookMarkdown, playbookToMarkdown, parseRulesMarkdown, normalizePlaybook,
  rankPlaybooks, pickPlaybooks, pickRules, buildContext, renderPlaybook, readLive, liveBlock, handbookMatcher, tunarrLines,
  type OperatorDeps, type Tier, type TierCall, type TierCallArgs, type LiveReading, type Playbook,
} from '../src/lib/ai/operator'
import { importPlaybooks } from '../src/lib/ai/operator/importer'
import { BUDGET } from '../src/lib/ai/operator/context'
import { makeHandbookRoutes } from '../src/routes/ai-handbook'
import { plainLines } from '../src/lib/arr-queue/lines'
import { requiredRole } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { setAuditSink } from '../src/lib/audit'
import { clearConfirms } from '../src/lib/confirm'
import { injectConfirmed } from './fakes/confirm'
import type { AskSource } from '../src/lib/ai/ask'

const NOW = new Date('2026-11-24T12:00:00Z')

// ── Invented sample playbooks ───────────────────────────────────────────────

const QUEUED_MD = `---
title: Queued downloads show zero seeds
tags: [torrent, queue, seeds, stuck]
symptoms:
  - a download is stuck at 0% with zero seeders
  - torrents show 0 seeds and no progress
severity: high
area: downloads
---

## Checks
- Read the client's state for the torrent: queued, stopped or downloading.
- Read how long it has been active.

## Cause
A torrent that has never had a slot is queued, and a queued torrent reports 0 seeds by construction. Zero seeds on a queued torrent means nothing yet.

## Fix
1. Check whether it is only queued. Queued torrents show 0 seeds until they get a slot.
2. Call it dead only after it has had a slot for about 1 hour with no progress.
3. Point to the real queue item in the live readings and say its place in line.

## Safety
Never purge, blocklist or pause anything because it shows 0 seeds while it is queued.

## Test scenario
Situation: 40 torrents are queued with 0 seeds, added hours ago, active time 0. Expected: they are waiting, not dead.
`

const DISK_MD = `---
title: Backup disk nearly full
tags: [backup, disk, capacity]
symptoms:
  - backup job fails with no space left
  - the backup store is above 90 percent
severity: medium
area: storage
---

## Checks
Read the store's usage.

## Cause
Old backups were kept too long.

## Fix
Shorten the retention and run the cleanup.

## Safety
Never delete the newest backup of a guest.

## Test scenario
Situation: the store is 95 percent full. Expected: shorten retention first.
`

const PRINTER_MD = `---
title: Office printer offline
tags: [printer, network]
symptoms:
  - the printer shows offline
severity: low
area: network
---

## Checks
Ping the printer.

## Cause
It lost its address.

## Fix
Restart the printer.

## Safety
None.

## Test scenario
Situation: offline printer. Expected: ping first.
`

const RULES_MD = `# House rules

Plain rules. Where a rule conflicts with a playbook, the rule wins.

## Downloads
- Never pause or stop torrents as a fix. Use speed limits.
- A queued torrent is waiting, not dead.
  - Judge it only after it has had a slot.

## Cluster
- Never restart the cluster file system service.
`

const file = (name: string, content: string) => ({ name, content })

async function seeded(): Promise<MemoryPlaybookStore> {
  const store = new MemoryPlaybookStore()
  await importPlaybooks([file('queued.md', QUEUED_MD), file('backup-disk.md', DISK_MD), file('printer.md', PRINTER_MD), file('house-rules.md', RULES_MD)], store)
  return store
}

const BASELINE = 'A download is stuck at 0% with zero seeders — what does it mean and what should I do?'

const ARR_READING: LiveReading = {
  id: 'plugin:arrstack', title: 'Arr Stack',
  lines: ['3 shows, 1 film, 1 downloading, 1 stuck.', 'Example Show (show, sonarr): waiting · 4th in line, 0% done.'],
}

beforeEach(() => { clearConfirms() })

// ── Markdown ────────────────────────────────────────────────────────────────

test('a markdown playbook is read into its fields, and written back out the same', () => {
  const r = parsePlaybookMarkdown(QUEUED_MD, 'queued.md')
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.value.title, 'Queued downloads show zero seeds')
  assert.deepEqual(r.value.tags, ['torrent', 'queue', 'seeds', 'stuck'])
  assert.equal(r.value.symptoms.length, 2)
  assert.equal(r.value.severity, 'high')
  assert.equal(r.value.area, 'downloads')
  assert.match(r.value.fix, /about 1 hour/)
  assert.match(r.value.testScenario, /waiting, not dead/)
  assert.equal(r.value.key, 'queued')
  const again = parsePlaybookMarkdown(playbookToMarkdown({ ...r.value }), 'queued.md')
  assert.ok(again.ok)
  if (again.ok) assert.deepEqual(again.value, r.value)
})

test('a bad playbook is refused in words, never thrown', () => {
  assert.equal(parsePlaybookMarkdown('no frontmatter here').ok, false)
  assert.equal(parsePlaybookMarkdown('---\ntitle: [unclosed\n---\n').ok, false)
  const noTitle = parsePlaybookMarkdown('---\ntags: [a]\n---\n## Fix\nx')
  assert.equal(noTitle.ok, false)
  assert.equal(normalizePlaybook({ title: 'x', severity: 'nonsense', source: 'nonsense' }).ok, true)
  const n = normalizePlaybook({ title: 'x', severity: 'nonsense', source: 'nonsense', approved: 'yes' })
  assert.ok(n.ok && n.value.severity === 'medium' && n.value.source === 'user' && n.value.approved === false)
})

test('house rules: bullets become rules (sub-bullets joined), the rest stays as text', () => {
  const r = parseRulesMarkdown(RULES_MD)
  assert.equal(r.rules.length, 3)
  assert.match(r.rules[1], /waiting, not dead\. Judge it only after/)
  assert.match(r.text, /Where a rule conflicts/)
  assert.doesNotMatch(r.text, /Never pause/)
})

// ── Importer ────────────────────────────────────────────────────────────────

test('the importer takes playbooks and house rules, skips README and INDEX, and is safe to run twice', async () => {
  const store = new MemoryPlaybookStore()
  const files = [file('queued.md', QUEUED_MD), file('printer.md', PRINTER_MD), file('README.md', '# readme'), file('INDEX.md', '# index'),
    file('broken.md', 'nothing'), file('house-rules.md', RULES_MD), file('notes.txt', 'ignored')]
  const a = await importPlaybooks(files, store)
  assert.deepEqual([a.created, a.updated, a.skipped], [2, 0, 0])
  assert.equal(a.failed.length, 1)
  assert.equal(a.failed[0].file, 'broken.md')
  assert.deepEqual(a.rules, { imported: true, rules: 3 })
  const rows = await store.list()
  assert.ok(rows.every(p => p.approved && p.source === 'seed'))
  const b = await importPlaybooks(files, store)
  assert.deepEqual([b.created, b.updated, b.skipped], [0, 0, 2])
  assert.equal(b.rules.imported, false, 'rules a person may have edited are not overwritten')
  const c = await importPlaybooks(files, store, { overwrite: true })
  assert.deepEqual([c.created, c.updated], [0, 2])
  assert.equal((await store.list()).length, 2)
})

// ── Retrieval ───────────────────────────────────────────────────────────────

test('the baseline question finds the queued-downloads playbook first, and the unrelated ones not at all', async () => {
  const store = await seeded()
  const ranked = rankPlaybooks(BASELINE, await store.list())
  assert.equal(ranked[0].playbook.title, 'Queued downloads show zero seeds')
  assert.ok(!ranked.some(r => r.playbook.title === 'Office printer offline'))
  const picks = pickPlaybooks(BASELINE, await store.list(), 3)
  assert.equal(picks[0].playbook.key, 'queued')
  assert.ok(picks.length <= 3)
})

test('a different question finds a different playbook; nonsense finds none', async () => {
  const pbs = await (await seeded()).list()
  assert.equal(pickPlaybooks('the backup failed with no space left on the store', pbs)[0].playbook.key, 'backup-disk')
  assert.equal(pickPlaybooks('purple elephants dance quietly', pbs).length, 0)
  assert.equal(pickPlaybooks('', pbs).length, 0)
})

test('only approved playbooks are ever offered', async () => {
  const store = await seeded()
  const q = (await store.list()).find(p => p.key === 'queued')!
  await store.update(q.id, { approved: false })
  assert.equal(pickPlaybooks(BASELINE, await store.list()).some(r => r.playbook.key === 'queued'), false)
})

test('rules that touch the question come first, and the budget is never passed', () => {
  const rules = ['Never touch the printer.', 'A queued torrent is waiting, not dead.', 'x'.repeat(500), 'Keep notes short.']
  const got = pickRules('is this queued torrent dead', rules, 600)
  assert.ok(got.includes('A queued torrent is waiting, not dead.'))
  assert.ok(got.join('').length <= 600)
  assert.ok(pickRules('anything', rules, 10).length === 0)
})

// ── Context for the prompt ──────────────────────────────────────────────────

test('the context holds the rules, the matching playbook and the live reading, and says which playbooks', async () => {
  const store = await seeded()
  const c = await buildContext(BASELINE, { store, live: async () => [ARR_READING] })
  assert.match(c.block, /HOUSE RULES/)
  assert.match(c.block, /A queued torrent is waiting, not dead/)
  assert.match(c.block, /\[P1\] Queued downloads show zero seeds/)
  assert.match(c.block, /LIVE READINGS/)
  assert.match(c.block, /Example Show .* 4th in line/)
  assert.deepEqual(c.playbooks.map(p => p.title), ['Queued downloads show zero seeds'])
  assert.deepEqual(c.live, ['Arr Stack'])
})

test('the context stays inside the local model budget however big the handbook is', async () => {
  const store = new MemoryPlaybookStore()
  const big = 'queue torrent seeds stuck download '.repeat(400)
  for (let i = 0; i < 8; i++) {
    const n = normalizePlaybook({ title: `Torrent queue problem ${i}`, tags: ['torrent', 'queue'], symptoms: ['download stuck zero seeds'], checks: big, cause: big, fix: big, safety: big, approved: true })
    if (n.ok) await store.create(n.value)
  }
  await store.saveRules({ text: 'y '.repeat(5000), rules: Array.from({ length: 200 }, (_, i) => `Rule ${i}: ${'torrent '.repeat(30)}`) }, 't')
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'z'.repeat(150)}`)
  const live = await readLive('queue download', [fakeSource('arr', 'Arr Stack', /queue|download/i, { headline: 'h', lines })])
  const c = await buildContext('download stuck zero seeds in the queue', { store, live: async () => live })
  assert.ok(c.playbooks.length <= 3)
  assert.ok(c.block.length < 18_000, `context was ${c.block.length} characters`)
  const first = renderPlaybook(1, (await store.list())[0])
  assert.ok(first.length <= BUDGET.playbookEach + 12)
})

// ── Live readings ───────────────────────────────────────────────────────────

function fakeSource(id: string, title: string, aliases: RegExp, sum: Partial<{ headline: string; lines: string[]; locked: boolean; unread: string[] }>): AskSource {
  return { id, title, blurb: title, aliases, load: async () => ({ headline: sum.headline ?? `${title}: ok`, lines: sum.lines ?? [], locked: sum.locked, unread: sum.unread }) }
}

test('live readings: only the areas the question is about, read-only, with locked and unreadable areas said', async () => {
  const sources = [
    fakeSource('plugin:arrstack', 'Arr Stack', /\b(downloads?|queue)\b/i, { headline: 'Arr: 1 stuck', lines: ['Example Show waiting'] }),
    fakeSource('plugin:plex', 'Plex', /\bplex\b/i, { lines: ['2 streams'] }),
    fakeSource('plugin:unmanic', 'Unmanic', /\bunmanic\b/i, { headline: 'Unmanic: locked', locked: true }),
    fakeSource('operator', 'AI operator', /\boperator\b/i, { lines: ['never read into a prompt'] }),
  ]
  const got = await readLive('why is a download stuck', sources)
  assert.deepEqual(got.map(g => g.title), ['Arr Stack'])
  assert.deepEqual(got[0].lines, ['Arr: 1 stuck', 'Example Show waiting'])
  const locked = await readLive('unmanic is slow', sources)
  assert.match(locked[0].note ?? '', /locked/i)
  assert.deepEqual(locked[0].lines, [])
  assert.equal((await readLive('what is the operator doing', sources)).length, 0, 'the operator source is never read into its own prompt')
  assert.match(liveBlock(got), /\[Arr Stack\]\n- Arr: 1 stuck\n- Example Show waiting/)
})

test('live readings give up on a slow area instead of holding the question up', async () => {
  const slow: AskSource = { id: 'slow', title: 'Slow area', blurb: 'x', aliases: /\bslow\b/i, budgetMs: 20, load: () => new Promise(() => {}) }
  const got = await readLive('slow things', [slow])
  assert.match(got[0].note ?? '', /still being read/)
  assert.deepEqual(got[0].lines, [])
})

test('the Arr Stack queue lines say a waiting item is waiting, with its place in line', () => {
  const lines = plainLines({
    summary: { shows: 3, films: 0, artists: 0, downloading: 1, waiting: 2, stuck: 0, requestsStuck: 0, done: 0, sizeLeft: 1, speedBps: null, text: '3 shows · 1 downloading', unit: 'show' },
    items: [{ key: 'a', kind: 'show', instance: 'sonarr', title: 'Example Show', detail: '', order: 4, state: 'waiting', text: 'waiting', line: 4, progress: 0, sizeLeft: 1, etaSec: null, problem: null, downloadIds: [], problemIds: [], torrentIds: [], children: [] }],
    needs: [],
  } as any)
  assert.match(lines[0], /3 shows/)
  assert.ok(lines.some(l => /waiting for a download slot/.test(l) && /no seeds/.test(l)))
  assert.ok(lines.some(l => /Example Show \(show, sonarr\): waiting, place 4 in line, 0% done/.test(l)))
})

test('Live TV lines say what is wrong in words', () => {
  const lines = tunarrLines({
    configured: true, channels: [{ id: '1', number: 5, name: 'Example', hasIcon: false, programCount: 3, now: null, next: null, guideHours: 6, guideShort: true, group: null } as any],
    sources: [], version: { installed: '1.0', latest: '1.1', behind: true, edge: false } as any,
    warnings: [{ level: 'warning', text: 'Channel 5 guide is short' }],
    summary: { channels: 1, viewers: 0, streaming: 0, guideShort: 1, cannotStream: 0, shortestGuideHours: 6, synced: 1, unsynced: 0, unsyncedProgrammes: 0, notRescanning: 0 },
    actions: { refreshGuide: true, stopSession: false }, readAt: '', detail: true,
  })
  assert.match(lines[0], /1 channels, 0 watching/)
  assert.ok(lines.some(l => /warning: Channel 5 guide is short/.test(l)))
  assert.ok(lines.some(l => /Channel 5 Example: guide only 6 h/.test(l)))
})

// ── The operator with the handbook ──────────────────────────────────────────

interface Rig { deps: OperatorDeps; calls: TierCallArgs[]; store: MemoryOperatorStore; book: MemoryPlaybookStore; audits: Array<{ action: string; details: any }> }

/** A scripted model: it can only say what the prompt it is given contains. */
function modelFrom(prompt: string): { answer: string; used: number[] } {
  const fix = /Fix: ([\s\S]*?)(?:\nSafety:|\nChecks:|\n\n|$)/.exec(prompt)?.[1]
  const item = /^- (.*waiting.*)$/m.exec(prompt)?.[1]
  const rule = /\d+\. (A queued torrent is waiting[^\n]*)/.exec(prompt)?.[1]
  if (!fix) return { answer: 'I have no playbook for that.', used: [] }
  return { answer: `${rule ?? ''} ${fix.replace(/\n/g, ' ')} The real queue item is: ${item ?? 'not in the readings'}`.trim(), used: [1] }
}

async function rig(o: { live?: LiveReading[]; scripted?: (a: TierCallArgs) => any; settings?: Partial<ReturnType<typeof defaultSettings>> } = {}): Promise<Rig> {
  const store = new MemoryOperatorStore()
  store.settings = normalizeSettings({ ...defaultSettings(), localBaseUrl: 'http://10.0.0.5:8080/v1', ...o.settings })
  const book = await seeded()
  const calls: TierCallArgs[] = []
  const audits: Rig['audits'] = []
  const call: TierCall = async a => {
    calls.push(a)
    if (a.name === 'operator_class') return { value: { class: 'new_fault' }, usage: { inputTokens: 5, outputTokens: 1 } }
    const v = o.scripted ? o.scripted(a) : { ...modelFrom(a.user), confidence: 'high', verified: null }
    return { value: v, usage: { inputTokens: 1500, outputTokens: 200 } }
  }
  const deps: OperatorDeps = {
    store, call, vaultUnlocked: () => true, now: () => NOW, tierReady: async () => ({ ready: true }),
    matcher: handbookMatcher(book), playbooks: book,
    context: (q) => buildContext(q, { store: book, live: async () => o.live ?? [] }),
    audit: async (action, _r, details) => { audits.push({ action, details }) },
  }
  return { deps, calls, store, book, audits }
}

const ask = (r: Rig, text: string, more: object = {}) => askOperator({ text, source: 'test', userRef: 'u1', role: 'admin', ...more }, r.deps)

test('BASELINE: a download stuck at 0% with zero seeders is "queued, not dead", judged after about an hour, and points to the real item', async () => {
  const r = await rig({ live: [ARR_READING] })
  const res = await ask(r, BASELINE)
  assert.equal(res.status, 'answered')
  if (res.status !== 'answered') return
  // Answered on the local tier, never the cloud.
  assert.equal(res.tier, 'local')
  assert.equal(r.calls.filter(c => c.tier !== 'local').length, 0)
  // 1. Check whether it is only queued (zero seeds is what a queued torrent shows).
  assert.match(res.answer, /only queued/i)
  assert.match(res.answer, /queued torrents show 0 seeds until they get a slot/i)
  // 2. Dead only after about an hour with a slot.
  assert.match(res.answer, /dead only after it has had a slot for about 1 hour with no progress/i)
  // 3. The real queue item, from the live reading.
  assert.match(res.answer, /Example Show .*4th in line/)
  // The house rule was in the prompt and the answer says which playbook it used.
  assert.match(res.answer, /Playbooks used: Queued downloads show zero seeds\./)
  assert.deepEqual(res.used.playbooks.map(p => p.title), ['Queued downloads show zero seeds'])
  assert.deepEqual(res.used.live, ['Arr Stack'])
  assert.equal(res.used.rules, 3)
  // What the model was sent: the question, the rules, the playbook, the reading; and room is left in 16K tokens.
  const sent = r.calls.find(c => c.name === 'operator_answer')!
  assert.match(sent.user, /^A download is stuck at 0%/)
  assert.match(sent.user, /HOUSE RULES[\s\S]*PLAYBOOKS[\s\S]*LIVE READINGS/)
  assert.ok((sent.user.length + sent.system.length) / 3.5 < 6000, 'under 6,000 tokens of 16,000')
  assert.doesNotMatch(sent.user, /Office printer|Backup disk/, 'unrelated playbooks stay out')
})

test('the classifier calls a matching question "known" so it starts on the local model', async () => {
  const r = await rig({ live: [ARR_READING] })
  const res = await ask(r, BASELINE)
  assert.equal(res.status === 'answered' && res.problemClass, 'known')
  assert.equal(res.status === 'answered' && res.classifiedBy, 'playbook')
})

test('without the handbook a question goes alone, as before, and a failing handbook never stops it', async () => {
  const r = await rig()
  delete r.deps.context
  const plain = await ask(r, 'why is the nightly job slow')
  assert.equal(plain.status, 'answered')
  assert.equal(r.calls.find(c => c.name === 'operator_answer')!.user, 'why is the nightly job slow')
  const r2 = await rig()
  r2.deps.context = async () => { throw new Error('db down') }
  const res = await ask(r2, 'why is the nightly job slow')
  assert.equal(res.status, 'answered')
  assert.ok(res.status === 'answered' && res.notes.some(n => /could not be read/.test(n)))
})

test('a cloud tier gets the same context with addresses and names hidden, and the reply is mapped back', async () => {
  const live: LiveReading = { id: 'x', title: 'Arr Stack', lines: ['Example Show waiting on host media-box at 10.1.2.3:8080 (0% done)'] }
  const r = await rig({ live: [live], scripted: a => ({ answer: `Check ${/host-\d+/.exec(a.user)?.[0]} at ${/addr-\d+/.exec(a.user)?.[0]}.`, confidence: 'high', verified: null, used: [1] }) })
  r.deps.knownHosts = async () => ['media-box']
  const res = await ask(r, BASELINE, { force: 'haiku' })
  assert.equal(res.status, 'answered')
  const sent = r.calls.find(c => c.tier === 'haiku' && c.name === 'operator_answer')!
  assert.doesNotMatch(sent.user, /10\.1\.2\.3|media-box/)
  assert.match(sent.user, /LIVE READINGS/)
  if (res.status === 'answered') assert.match(res.answer, /Check media-box at 10\.1\.2\.3\./)
})

test('a cloud answer to a new fault also drafts a playbook, unapproved, and the drafts are not used until approved', async () => {
  const draft = {
    title: 'Scheduler stops after midnight', tags: ['scheduler'], symptoms: ['the nightly scheduler stops after midnight'], severity: 'medium', area: 'jobs',
    checks: 'Read the scheduler log.', cause: 'The log volume filled up.', fix: 'Clear old logs and restart the scheduler.', safety: 'Never delete the current log.', testScenario: 'Situation: log volume full. Expected: clear old logs first.',
  }
  const r = await rig({ scripted: a => ({ answer: 'Clear the old logs.', confidence: 'high', verified: null, used: [], ...(a.schema as any).properties.draft ? { draft } : {} }) })
  const res = await ask(r, 'why does the scheduler stop after midnight', { force: 'sonnet' })
  assert.equal(res.status, 'answered')
  if (res.status !== 'answered') return
  assert.equal(res.tier, 'sonnet')
  assert.equal(res.drafted?.title, 'Scheduler stops after midnight')
  const row = (await r.book.list()).find(p => p.title === 'Scheduler stops after midnight')!
  assert.equal(row.approved, false)
  assert.equal(row.source, 'cloud-draft')
  assert.ok(r.audits.some(a => a.action === 'ai.playbook.draft'))
  // Asked again: the draft is not offered (it waits for a person), and a second identical draft is not piled up.
  const again = await ask(r, 'why does the scheduler stop after midnight', { force: 'sonnet' })
  assert.ok(again.status === 'answered' && !again.drafted && again.used.playbooks.length === 0)
  assert.equal((await r.book.list()).filter(p => p.title === 'Scheduler stops after midnight').length, 1)
})

test('no draft when a playbook was used, when the local model answered, for a build request, or when unsure', async () => {
  const draft = { title: 'Should not exist', symptoms: ['s'], cause: 'c', fix: 'f', safety: 'x' }
  const mk = (extra: object = {}) => rig({ live: [ARR_READING], scripted: a => ({ answer: 'ok', confidence: 'high', verified: null, used: [], draft, ...extra }) })
  const used = await mk({ used: [1] })
  await ask(used, BASELINE, { force: 'haiku' })
  const local = await mk()
  await ask(local, 'why does the scheduler stop after midnight')
  const build = await mk()
  await ask(build, 'write a script that rotates the scheduler logs', { force: 'sonnet' })
  const low = await mk({ confidence: 'low' })
  await ask(low, 'why does the scheduler stop after midnight', { force: 'haiku' })
  for (const r of [used, local, build, low]) assert.ok(!(await r.book.list()).some(p => p.title === 'Should not exist'))
})

test('the drafts a model writes are cleaned like anything else a person submits', async () => {
  const r = await rig({ scripted: () => ({ answer: 'x', confidence: 'high', verified: null, draft: { title: 'T'.repeat(500), symptoms: 'one, two', severity: 'catastrophic', cause: 'c', fix: 'f', safety: 's', approved: true, source: 'user' } }) })
  await ask(r, 'why does the scheduler stop', { force: 'haiku' })
  const row = (await r.book.list()).find(p => p.source === 'cloud-draft')!
  assert.ok(row, 'saved')
  assert.equal(row.approved, false, 'a model cannot approve its own draft')
  assert.equal(row.title.length, 160)
  assert.equal(row.severity, 'medium')
  assert.deepEqual(row.symptoms, ['one', 'two'])
})

test('Opus asks first, shows everything it would send (handbook and readings included), and sends nothing before approval', async () => {
  const r = await rig({ live: [ARR_READING] })
  const res = await ask(r, BASELINE, { force: 'opus' })
  assert.equal(res.status, 'needs_approval')
  assert.equal(r.calls.filter(c => c.tier === 'opus').length, 0, 'nothing is sent before approval')
  if (res.status === 'needs_approval') assert.match(res.promptPreview, /HOUSE RULES[\s\S]*PLAYBOOKS[\s\S]*LIVE READINGS/)
})

test('a keep-it-local topic in the readings or rules keeps the question on the local model', async () => {
  const r = await rig({ live: [{ id: 'x', title: 'Arr Stack', lines: ['payroll export is waiting'] }], settings: { localOnlyTopics: ['payroll'] } })
  const res = await ask(r, BASELINE, { force: 'haiku' })
  assert.equal(res.status, 'answered')
  assert.equal(res.status === 'answered' && res.tier, 'local')
  assert.equal(r.calls.filter(c => c.tier === 'haiku').length, 0)
})

// ── Routes ──────────────────────────────────────────────────────────────────

function app(role: 'viewer' | 'admin', store = new MemoryPlaybookStore()) {
  const audits: any[] = []
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req: any) => { req.session = { sid: 's1', email: 'admin@example.org', role } })
  a.register(makeHandbookRoutes({ store: () => store, audit: async (action, res, d) => { audits.push({ action, res, d }) } }), { prefix: '/api/ai/handbook' })
  setAuditSink({ async write() {} })
  return { a, store, audits }
}

test('handbook roles: viewers read, admins write, API tokens cannot write', () => {
  for (const p of ['/api/ai/handbook/playbooks', '/api/ai/handbook/playbooks/x', '/api/ai/handbook/rules', '/api/ai/handbook/match']) assert.equal(requiredRole('GET', p), 'viewer', p)
  for (const [m, p] of [['POST', '/api/ai/handbook/playbooks'], ['PUT', '/api/ai/handbook/playbooks/x'], ['DELETE', '/api/ai/handbook/playbooks/x'], ['POST', '/api/ai/handbook/playbooks/x/approve'], ['PUT', '/api/ai/handbook/rules'], ['POST', '/api/ai/handbook/playbooks/import']] as const) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(tokenForbidden(m, p), true, `${m} ${p}`)
  }
  assert.equal(tokenForbidden('GET', '/api/ai/handbook/playbooks'), false)
})

test('routes: add, edit, approve, export, import, delete, and every write is audited without the body', async () => {
  const { a, store, audits } = app('admin')
  const made = await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks', payload: { title: 'Sample fix', tags: ['a'], fix: 'secret-looking body text', approved: true, source: 'seed' } })
  assert.equal(made.statusCode, 201)
  const pb = made.json().playbook as Playbook
  assert.equal(pb.approved, true, 'an admin who adds a playbook may approve it in the same step')
  assert.equal(pb.source, 'user', 'a person cannot pass themselves off as the seed set')
  const plain = await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks', payload: { title: 'Another' } })
  assert.equal(plain.json().playbook.approved, false, 'approval is off unless asked for')
  assert.equal((await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks', payload: { title: '  ' } })).statusCode, 400)

  const edited = await a.inject({ method: 'PUT', url: `/api/ai/handbook/playbooks/${pb.id}`, payload: { cause: 'Because.', approved: true, source: 'seed' } })
  assert.equal(edited.statusCode, 200)
  assert.equal(edited.json().playbook.cause, 'Because.')
  assert.equal(edited.json().playbook.approved, true, 'editing keeps the approval it had')
  const draftId = (await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks', payload: { title: 'Draft one' } })).json().playbook.id
  assert.equal((await a.inject({ method: 'PUT', url: `/api/ai/handbook/playbooks/${draftId}`, payload: { fix: 'x', approved: true } })).json().playbook.approved, false, 'editing never approves an unapproved one')
  assert.equal(edited.json().playbook.source, 'user')
  assert.equal(edited.json().playbook.fix, 'secret-looking body text', 'an edit keeps the fields it did not send')

  const ok = await a.inject({ method: 'POST', url: `/api/ai/handbook/playbooks/${pb.id}/approve`, payload: { approved: true } })
  assert.equal(ok.json().playbook.approved, true)
  assert.equal((await a.inject({ method: 'POST', url: `/api/ai/handbook/playbooks/${pb.id}/approve`, payload: {} })).statusCode, 400)

  const exp = (await a.inject({ method: 'GET', url: `/api/ai/handbook/playbooks/${pb.id}/export` })).json()
  assert.match(exp.markdown, /^---\ntitle: Sample fix/)
  const imp = await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks/import', payload: { markdown: QUEUED_MD } })
  assert.equal(imp.statusCode, 201)
  assert.equal(imp.json().playbook.approved, false)
  assert.equal((await a.inject({ method: 'POST', url: '/api/ai/handbook/playbooks/import', payload: { markdown: 'nope' } })).statusCode, 400)

  const list = (await a.inject({ method: 'GET', url: '/api/ai/handbook/playbooks?approved=false' })).json().playbooks as Playbook[]
  assert.deepEqual(list.map(p => p.title).sort(), ['Another', 'Draft one', 'Queued downloads show zero seeds'])

  const first = await a.inject({ method: 'DELETE', url: `/api/ai/handbook/playbooks/${pb.id}` })
  assert.equal(first.statusCode, 403, 'a delete is confirmed first')
  assert.equal((await store.list()).length, 4)
  assert.equal((await injectConfirmed(a, { method: 'DELETE', url: `/api/ai/handbook/playbooks/${pb.id}` })).statusCode, 200)
  assert.equal((await store.list()).length, 3)
  assert.equal((await a.inject({ method: 'GET', url: `/api/ai/handbook/playbooks/${pb.id}` })).statusCode, 404)

  const names = audits.map(x => x.action)
  for (const n of ['ai.playbook.create', 'ai.playbook.update', 'ai.playbook.approve', 'ai.playbook.import', 'ai.playbook.delete']) assert.ok(names.includes(n), n)
  assert.doesNotMatch(JSON.stringify(audits), /secret-looking body text|Because\./, 'the audit names the playbook, never its text')
})

test('routes: house rules are saved whole and audited; the match test says why a playbook was picked', async () => {
  const { a, store, audits } = app('admin', await seeded())
  const put = await a.inject({ method: 'PUT', url: '/api/ai/handbook/rules', payload: { text: 'Be careful.', rules: ['Rule one', '  ', 'Rule two'] } })
  assert.equal(put.statusCode, 200)
  assert.deepEqual((await store.getRules()).rules, ['Rule one', 'Rule two'])
  assert.equal((await a.inject({ method: 'PUT', url: '/api/ai/handbook/rules', payload: { rules: 'x' } })).statusCode, 400)
  assert.ok(audits.some(x => x.action === 'ai.houserules.update' && x.d.rules === 2))
  assert.doesNotMatch(JSON.stringify(audits), /Rule one|Be careful/)
  const got = (await a.inject({ method: 'GET', url: '/api/ai/handbook/rules' })).json()
  assert.equal(got.rules.text, 'Be careful.')
  const m = (await a.inject({ method: 'GET', url: `/api/ai/handbook/match?q=${encodeURIComponent(BASELINE)}` })).json()
  assert.equal(m.matches[0].title, 'Queued downloads show zero seeds')
  assert.ok(m.matches[0].words.length > 0)
  assert.equal((await a.inject({ method: 'GET', url: '/api/ai/handbook/match?q=' })).statusCode, 400)
})

test('routes: a viewer can read the handbook (the role gate itself is lib/roles.ts, tested above)', async () => {
  const { a } = app('viewer', await seeded())
  assert.equal((await a.inject({ method: 'GET', url: '/api/ai/handbook/playbooks' })).json().playbooks.length, 3)
})
