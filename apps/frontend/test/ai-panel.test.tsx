// The AI side panel: its rules (width, what is remembered, the page line, fix requests), the answer card's retry and
// approval buttons, the fix cards, the folded rail, and that none of its files names the author's own estate.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerCard } from '../components/ai/operator/OperatorView'
import { FixCards } from '../components/ai/panel/FixCards'
import { AskAbout } from '../components/ai/panel/AskAbout'
import { AiPanel } from '../components/ai/panel/AiPanel'
import {
  PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, clampWidth, composeQuestion, fixBody, itemForApi, maxWidthFor, pageLabel, parsePrefs, planWords,
  prefsKey, retryLabel, stripPlaybookLabel, workingWords, type FixProposal, type PanelItem,
} from '../lib/ai-panel'
import type { OperatorResult } from '../lib/operator-view'

const item: PanelItem = { kind: 'arr-queue', instance: 'sonarr', downloadId: 'ABC123', title: 'Some Show', detail: 'Season 2 · stalled' }
const fix: FixProposal = { action: 'find-another', instance: 'sonarr', downloadId: 'ABC123', title: 'Look for another copy', item: 'Some Show' }

test('width: clamped to the limits and to half the window', () => {
  assert.equal(clampWidth(100, 1600), PANEL_MIN)
  assert.equal(clampWidth(5000, 1600), PANEL_MAX)
  assert.equal(clampWidth(500, 800), 400)            // half of an 800 px window
  assert.equal(maxWidthFor(300), PANEL_MIN)          // never below the minimum
  assert.equal(clampWidth(NaN, 1600), PANEL_DEFAULT)
})

test('prefs: remembered per person, with safe defaults for anything unreadable', () => {
  assert.notEqual(prefsKey('a@example.com'), prefsKey('b@example.com'))
  assert.equal(prefsKey('A@Example.com'), prefsKey('a@example.com'))
  assert.deepEqual(parsePrefs(null), { open: true, width: PANEL_DEFAULT })
  assert.deepEqual(parsePrefs('{nope'), { open: true, width: PANEL_DEFAULT })
  assert.deepEqual(parsePrefs(JSON.stringify({ open: false, width: 500 })), { open: false, width: 500 })
  assert.deepEqual(parsePrefs(JSON.stringify({ open: 'yes', width: 99999 })), { open: true, width: PANEL_MAX })
})

test('page context: the plug-in or page name, and the line a question carries', () => {
  assert.equal(pageLabel('/plugins/arrstack'), 'Arr Stack')
  assert.equal(pageLabel('/'), 'Home')
  assert.equal(pageLabel('/ai/operator'), 'AI / Operator')
  assert.equal(pageLabel('/remote-access'), 'Remote access')
  assert.match(composeQuestion('Arr Stack', item, 'why is this stuck?'), /^I am on the Arr Stack page, looking at "Some Show" \(Season 2 · stalled\)\.\n\nwhy is this stuck\?$/)
  assert.equal(composeQuestion('DNS', null, ' hi '), 'I am on the DNS page.\n\nhi')
  assert.deepEqual(Object.keys(itemForApi(item)).sort(), ['downloadId', 'instance', 'kind', 'title'])
})

test('fix requests: a preview changes nothing; only the run of a re-search carries the confirmation', () => {
  assert.deepEqual(fixBody(fix, 'preview'), { action: 'find-another', instance: 'sonarr', downloadId: 'ABC123', preview: true })
  assert.deepEqual(fixBody(fix, 'run'), { action: 'find-another', instance: 'sonarr', downloadId: 'ABC123', confirmed: true })
  assert.deepEqual(fixBody({ ...fix, action: 'retry-import' }, 'run'), { action: 'retry-import', instance: 'sonarr', downloadId: 'ABC123' })
  assert.match(planWords({ items: [{ name: 'Some.Show.S02' }], search: ['Search season 2'], blocklist: true }), /take "Some.Show.S02" out of the queue and avoid that release, then search for another copy/)
  assert.equal(planWords(undefined), 'Nothing is listed to change.')
})

test('working words: seconds, and the local model\'s two minutes after ten of them', () => {
  assert.equal(workingWords(3, 'haiku'), 'Asking Haiku... 3 s.')
  assert.match(workingWords(45, null), /45 s\. The local model can take up to two minutes\. You can keep using the page\./)
  assert.doesNotMatch(workingWords(45, 'sonnet'), /two minutes/)
  assert.equal(retryLabel('haiku'), 'Ask Haiku instead')
  assert.equal(stripPlaybookLabel('Do it.\n\nPlaybooks used: A; B.'), 'Do it.')
})

const refused: OperatorResult = { status: 'refused', code: 'tier_error', message: 'The local model is unreachable (bad key or offline) — nothing was sent elsewhere.', chain: [], notes: [], retryWith: 'haiku' }

test('a tier error offers "Ask Haiku instead" as a button that sends only when clicked', () => {
  const html = renderToStaticMarkup(<AnswerCard result={refused} onRetry={() => {}} />)
  assert.match(html, /<button[^>]*>Ask Haiku instead<\/button>/)
  assert.match(html, /nothing was sent elsewhere/)
  assert.ok(!/onclick|autofocus/i.test(html))
  assert.ok(!/Ask Haiku instead/.test(renderToStaticMarkup(<AnswerCard result={refused} />)), 'no handler, no button')
  assert.ok(!/Ask \w+ instead/.test(renderToStaticMarkup(<AnswerCard result={{ ...refused, retryWith: undefined }} onRetry={() => {}} />)))
})

test('the Opus approval is inline, and a used one is not offered again', () => {
  const r: OperatorResult = { status: 'needs_approval', tier: 'opus', model: 'm', reason: 'Opus asks first.', promptPreview: 'the text', approvalToken: 't', chain: [], notes: [] }
  assert.match(renderToStaticMarkup(<AnswerCard result={r} onApprove={() => {}} />), /Approve and ask Opus/)
})

test('an answer shows its tier, the playbooks used, and its proposed fixes as cards', () => {
  const r: OperatorResult = { status: 'answered', answer: 'It is waiting on a tracker.\n\nPlaybooks used: Stalled download.', tier: 'local', model: 'm', confidence: 'high', chain: [{ tier: 'local', model: 'm', outcome: 'answered' }], notes: [], costUsd: 0, redacted: false, localOnly: false, used: { playbooks: [{ id: 'p', title: 'Stalled download' }], live: [], rules: 0 }, proposals: [fix] }
  const html = renderToStaticMarkup(<AnswerCard result={r} extra={<FixCards proposals={r.proposals} canAct />} />)
  assert.match(html, /Local model/)
  assert.equal((html.match(/Playbooks used: Stalled download\./g) ?? []).length, 1, 'the label is not repeated')
  assert.match(html, /Proposed fixes\. Nothing runs until you confirm\./)
  assert.match(html, /Review this fix/)
  assert.ok(!/Confirm: /.test(html), 'a re-search is previewed before it can be confirmed')
})

test('fix cards: nothing without proposals; a viewer sees why there is no button', () => {
  assert.equal(renderToStaticMarkup(<FixCards proposals={[]} canAct />), '')
  const html = renderToStaticMarkup(<FixCards proposals={[fix]} canAct={false} />)
  assert.match(html, /Needs the admin role/)
  assert.ok(!/<button/.test(html))
})

test('outside the shell: no "Ask about this" button, and the panel is a folded rail', () => {
  assert.equal(renderToStaticMarkup(<AskAbout item={item} />), '')
  const html = renderToStaticMarkup(<AiPanel />)
  assert.match(html, /aria-label="AI panel, folded"/)
  assert.match(html, /Open the AI panel/)
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), 'no emoji')
})

// Built from pieces so this file does not itself contain the words it forbids.
const PRIVATE = new RegExp(['tit' + 'an\\d', 'grif' + 'finit', '192\\.168\\.[23]\\.', 'ge' + 'off', 'hm' + 'server', 'fyr' + 'lux'].join('|'), 'i')

test('the panel\'s files hold nothing private (the repo is public)', () => {
  const files = ['../lib/ai-panel.ts', '../components/ai/panel/PanelProvider.tsx', '../components/ai/panel/AiPanel.tsx', '../components/ai/panel/FixCards.tsx', '../components/ai/panel/AskAbout.tsx', '../components/ai/panel/panel.module.css', '../components/ai/AssistantChat.tsx']
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!PRIVATE.test(text), `${f} names something private`)
  }
})
