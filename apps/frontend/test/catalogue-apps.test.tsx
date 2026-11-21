// The Catalogue's three new apps on the page side: the search (plain words find the app: "google photos", "chatgpt",
// "smart home"), the wizard's questions (menus, answers that hide others, the preview's own fields never asked), the USB
// picker's codes, and the Immich and Open WebUI plug-in pages' pieces: problems worst first with a fix button each, queues
// and models as bars, and the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { matchesSearch } from '../components/catalogue/search'
import { visibleOptions, type RecipeOption } from '../components/catalogue/InstallWizard'
import { UsbPicker, usbCodes, usbValue } from '../components/catalogue/UsbPicker'
import { ProblemList, QueueList, Bar } from '../components/plugins/immich/ImmichPage'
import { headline, photoShare, queueFill, queueOrder, size, plural, type Overview, type QueueRow, type Problem } from '../components/plugins/immich/logic'
import { ProblemList as WebuiProblems, Models } from '../components/plugins/openwebui/OpenWebuiPage'
import { modelSize, modelsBySize, ollamaState } from '../components/plugins/openwebui/logic'

const recipe = (id: string, name: string, summary: string, keywords: string[] = [], category = 'apps') => ({ id, name, summary, category, keywords })
const immich = recipe('immich', 'Immich', 'Your own photo and video library.', ['photos', 'google photos', 'photo backup'], 'media')
const webui = recipe('open-webui', 'Open WebUI', 'A chat page for the models you run yourself.', ['chatgpt', 'ai chat', 'llm'], 'ai')
const ha = recipe('home-assistant', 'Home Assistant', 'Your smart home in one place.', ['smart home', 'zigbee', 'home automation'])
const kuma = recipe('uptime-kuma', 'Uptime Kuma', 'Watches your services.', [], 'monitoring')

test('search: what people type finds the app, whatever it is called', () => {
  const all = [immich, webui, ha, kuma]
  const find = (q: string) => all.filter(r => matchesSearch(r, q)).map(r => r.id)
  assert.deepEqual(find('google photos'), ['immich'])
  assert.deepEqual(find('chatgpt'), ['open-webui'])
  assert.deepEqual(find('smart home'), ['home-assistant'])
  assert.deepEqual(find('Photo Backup'), ['immich'], 'case and spacing do not matter')
  assert.deepEqual(find('zigbee'), ['home-assistant'])
  assert.deepEqual(find('photo  backup!!'), ['immich'], 'punctuation does not matter')
  assert.deepEqual(find(''), ['immich', 'open-webui', 'home-assistant', 'uptime-kuma'], 'no search shows everything')
  assert.deepEqual(find('   '), ['immich', 'open-webui', 'home-assistant', 'uptime-kuma'])
  assert.deepEqual(find('kuma'), ['uptime-kuma'], 'the name still works')
  assert.deepEqual(find('watches'), ['uptime-kuma'], 'so does the summary')
  assert.deepEqual(find('photos chatgpt'), [], 'every word must match')
  assert.deepEqual(find('media'), ['immich'], 'and the category')
  assert.deepEqual(find('xyzzy'), [])
})

const opts: RecipeOption[] = [
  { key: 'LIB', label: 'Where', kind: 'text', default: 'disk', choices: [{ value: 'disk', label: 'A disk' }, { value: 'nfs', label: 'A NAS' }] },
  { key: 'GB', label: 'Size', kind: 'number', showWhen: { key: 'LIB', value: 'disk' } },
  { key: 'HOST', label: 'NAS', kind: 'text', showWhen: { key: 'LIB', value: ['nfs', 'smb'] } },
  { key: 'SECRET_FROM_PREVIEW', label: 'Resolved', kind: 'text', hidden: true },
]

test('questions: an answer shows or hides the ones that depend on it, and the preview\'s own fields are never asked', () => {
  assert.deepEqual(visibleOptions(opts, { LIB: 'disk' }).map(o => o.key), ['LIB', 'GB'])
  assert.deepEqual(visibleOptions(opts, { LIB: 'nfs' }).map(o => o.key), ['LIB', 'HOST'])
  assert.deepEqual(visibleOptions(opts, {}).map(o => o.key), ['LIB'], 'an unanswered question shows none of its followers')
  assert.ok(!visibleOptions(opts, { LIB: 'disk' }).some(o => o.hidden))
})

test('USB picker: codes round-trip and stay lowercase and unique', () => {
  assert.deepEqual(usbCodes('10C4:EA60, 1a86:7523,,'), ['10c4:ea60', '1a86:7523'])
  assert.equal(usbValue(['10c4:ea60', '1a86:7523']), '10c4:ea60,1a86:7523')
  assert.equal(usbValue([]), '')
  const html = renderToStaticMarkup(<UsbPicker node="node-a" value="" onChange={() => {}} />)
  assert.match(html, /USB devices on node-a/)
  assert.match(html, /Optional\. A device passed in ties the machine to this node\./)
})

const q = (o: Partial<QueueRow>): QueueRow => ({ name: 'search', label: 'Search index', paused: false, active: 0, waiting: 0, failed: 0, delayed: 0, ...o })
const prob = (o: Partial<Problem>): Problem => ({ id: 'p', severity: 'warn', title: 'A problem', detail: 'Why.', fix: null, ...o })

test('Immich logic: sizes in words, queues with trouble first, the fill of a queue, the share of photos', () => {
  assert.equal(size(5 * 1024 ** 3), '5.0 GB'); assert.equal(size(2 * 1024 ** 4), '2.0 TB'); assert.equal(size(3 * 1024 ** 2), '3.0 MB'); assert.equal(size(2048), '2 KB')
  assert.equal(plural(1, 'job'), '1 job'); assert.equal(plural(2, 'job'), '2 jobs')
  const order = queueOrder([q({ label: 'Z idle' }), q({ label: 'B waiting', waiting: 3 }), q({ label: 'A busy', active: 1 }), q({ label: 'P paused', paused: true }), q({ label: 'F failed', failed: 2 })])
  assert.deepEqual(order.map(x => x.label), ['F failed', 'P paused', 'A busy', 'B waiting', 'Z idle'])
  assert.equal(queueFill(q({})), 0); assert.equal(queueFill(q({ active: 1, waiting: 3 })), 0.25)
  assert.equal(photoShare({ photoBytes: 3, videoBytes: 1 }), 0.75); assert.equal(photoShare({ photoBytes: 0, videoBytes: 0 }), 0)
  const o = { photos: 1200, videos: 30, problems: [] as Problem[] } as Overview
  assert.equal(headline(o), '1,200 photos, 30 videos')
  assert.equal(headline({ ...o, problems: [prob({ severity: 'bad' })] }), '1 problem to fix')
})

test('Immich page: each problem has its fix button, the queues are bars, and an empty list says all is well', () => {
  const html = renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[
    prob({ id: 'failed:videoConversion', severity: 'bad', title: 'Video conversion: 3 jobs failed', fix: { action: 'clear-failed', queue: 'videoConversion', label: 'Clear the failed jobs', confirm: 'x' } }),
    prob({ id: 'update', title: 'Immich v3.5.0 is available' }),
  ]} />)
  assert.match(html, /Video conversion: 3 jobs failed/); assert.match(html, /Clear the failed jobs/)
  assert.equal((html.match(/<button/g) ?? []).length, 1, 'a problem with no fix has no button')
  assert.match(renderToStaticMarkup(<ProblemList busy="failed:videoConversion" onFix={() => {}} problems={[prob({ id: 'failed:videoConversion', fix: { action: 'clear-failed', queue: 'q', label: 'Clear', confirm: 'x' } })]} />), /Working…/)
  assert.match(renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[]} />), /No problems: every queue is running and nothing has failed/)
  const qs = renderToStaticMarkup(<QueueList queues={[q({ label: 'Video conversion', failed: 3 }), q({ label: 'Thumbnails', active: 2, waiting: 6 }), q({ label: 'Library' })]} />)
  assert.match(qs, /3 failed/); assert.match(qs, /2 running/); assert.match(qs, /idle/)
  assert.match(qs, /aria-label="Thumbnails: 2 running, 6 waiting, 0 failed"/)
  assert.ok(qs.indexOf('Video conversion') < qs.indexOf('Thumbnails') && qs.indexOf('Thumbnails') < qs.indexOf('Library'))
  assert.match(renderToStaticMarkup(<Bar value={2} label="over" />), /width:100%/, 'a bar never overflows')
  assert.match(renderToStaticMarkup(<QueueList queues={[]} />), /reported no queues/)
})

test('Open WebUI page: the Ollama state in words, models largest first as bars, and a reconnect button only on a problem that has one', () => {
  assert.deepEqual(ollamaState({ enabled: false, connected: false, answering: null, error: null }), { text: 'No Ollama connected', tone: 'warn' })
  assert.deepEqual(ollamaState({ enabled: true, connected: true, answering: false, error: 'x' }), { text: 'The Ollama does not answer', tone: 'crit' })
  assert.deepEqual(ollamaState({ enabled: true, connected: true, answering: true, error: null }), { text: 'Connected and answering', tone: 'good' })
  assert.equal(modelSize(5 * 1024 ** 3), '5.0 GB'); assert.equal(modelSize(700 * 1024 ** 2), '700 MB'); assert.equal(modelSize(null), '—')
  assert.deepEqual(modelsBySize([{ name: 'b', sizeBytes: 1 }, { name: 'a', sizeBytes: 9 }, { name: 'c', sizeBytes: null }]).map(m => m.name), ['a', 'b', 'c'])
  const m = renderToStaticMarkup(<Models models={[{ name: 'tiny:1b', sizeBytes: 700 * 1024 ** 2 }, { name: 'llama3:8b', sizeBytes: 5 * 1024 ** 3 }]} />)
  assert.ok(m.indexOf('llama3:8b') < m.indexOf('tiny:1b')); assert.match(m, /5\.0 GB/)
  assert.match(renderToStaticMarkup(<Models models={[]} />), /No models yet/)
  const html = renderToStaticMarkup(<WebuiProblems busy={null} onFix={() => {}} problems={[
    { id: 'ollama-down', severity: 'bad', title: 'The Ollama does not answer', detail: 'd', fix: { action: 'reconnect-ollama', label: 'Reconnect', confirm: 'x' } },
    { id: 'ollama-off', severity: 'warn', title: 'No Ollama is connected', detail: 'd', fix: null },
  ]} />)
  assert.match(html, /Reconnect/); assert.equal((html.match(/<button/g) ?? []).length, 1)
  assert.match(renderToStaticMarkup(<WebuiProblems busy={null} onFix={() => {}} problems={[]} />), /the Ollama answers and sign-up is closed/)
})
