// The run-steps checklist: a row of stages up to six steps, a vertical checklist beyond, every state drawn
// with its words, times per step, a summary line and a progress bar.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { RunSteps, fmtElapsed, normStatus, summarise, type RunStep } from '../components/visual/RunSteps'

const mk = (n: number, over: Record<number, Partial<RunStep>> = {}): RunStep[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Step label ${i + 1}`, status: 'pending', ...over[i] }))
const T = 1_000_000

test('six steps or fewer stay a row of stages; seven or more become the checklist', () => {
  assert.match(renderToStaticMarkup(<RunSteps label="Run" steps={mk(6)} now={T} />), /data-layout="row"/)
  const long = renderToStaticMarkup(<RunSteps label="Run" steps={mk(7)} now={T} />)
  assert.match(long, /data-layout="list"/)
  assert.doesNotMatch(long, /data-layout="row"/)
})

test('every state is drawn in the checklist, with its word for screen readers', () => {
  const steps = mk(8, {
    0: { status: 'done', startedAt: T - 200_000, endedAt: T - 100_000 }, 1: { status: 'completed', startedAt: T - 100_000, endedAt: T - 90_000 },
    2: { status: 'running', startedAt: T - 130_000, detail: 'Waiting for Ghost to answer' },
    3: { status: 'failed', startedAt: T - 5000, detail: 'certificate refused: DNS has not propagated' }, 4: { status: 'skipped' },
  })
  const h = renderToStaticMarkup(<RunSteps label="Run" steps={steps} now={T} />)
  for (const st of ['done', 'running', 'failed', 'skipped', 'pending']) assert.match(h, new RegExp(`data-state="${st}"`))
  assert.match(h, /, done</); assert.match(h, /, failed</); assert.match(h, /, skipped</); assert.match(h, /, waiting</); assert.match(h, /, running</)
  assert.match(h, /Waiting for Ghost to answer/)
  assert.match(h, /certificate refused: DNS has not propagated/)
  assert.match(h, /aria-current="step"/)
  assert.match(h, /<time[^>]*>1m 40s<\/time>/)
  assert.match(h, /<time[^>]*>10s<\/time>/)
  assert.match(h, /<time[^>]*>2m 10s<\/time>/)
})

test('the summary says which step, what it is doing and how long the run has taken, and the bar counts finished steps', () => {
  const steps = mk(15, { 0: { status: 'done', startedAt: T - 130_000, endedAt: T - 120_000 }, 1: { status: 'done', startedAt: T - 120_000, endedAt: T - 100_000 },
    2: { status: 'running', label: 'Waiting for Ghost to start', startedAt: T - 100_000 } })
  const h = renderToStaticMarkup(<RunSteps label="Run" steps={steps} now={T} />)
  assert.match(h, /Step 3 of 15 · Waiting for Ghost to start/)
  assert.match(h, /· 2m 10s/)
  assert.match(h, /aria-valuenow="2"/); assert.match(h, /aria-valuemax="15"/)
  assert.deepEqual(summarise(mk(3, { 0: { status: 'done' }, 1: { status: 'done' }, 2: { status: 'done' } })).text, 'All 3 steps done')
  assert.match(summarise(mk(9, { 6: { status: 'failed' } })).text, /^Step 7 of 9 failed · Step label 7$/)
})

test('the row layout shows the same states', () => {
  const h = renderToStaticMarkup(<RunSteps label="Run" steps={mk(4, { 0: { status: 'done' }, 1: { status: 'running' }, 2: { status: 'failed' } })} now={T} />)
  assert.match(h, /✓/); assert.match(h, /✕/); assert.match(h, /…/)
})

test('helpers: times and the two spellings of done', () => {
  assert.equal(fmtElapsed(45_000), '45s'); assert.equal(fmtElapsed(130_000), '2m 10s'); assert.equal(fmtElapsed(3_720_000), '1h 02m')
  assert.equal(normStatus('completed'), 'done'); assert.equal(normStatus('queued'), 'pending')
})

test('the checklist cannot widen the page: it scrolls inside, rows shrink, labels break between words only', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'components/visual/run-steps.module.css'), 'utf8')
  assert.match(css, /\.list \{[^}]*overflow-y: auto[^}]*overflow-x: hidden/)
  assert.match(css, /\.list \{[^}]*max-height/)
  assert.match(css, /\.row \{[^}]*minmax\(0, 1fr\)/)
  assert.doesNotMatch(/\.body b \{[^}]*\}/.exec(css)![0], /overflow-wrap:\s*anywhere|word-break:\s*break/)
})
