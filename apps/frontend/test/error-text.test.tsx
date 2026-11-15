// What a person reads when something failed: the API's own sentence when it sent one, otherwise a plain one made
// from what went wrong; nginx's api_down answer recognised; never a stack, an HTML page or a browser's message.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import './css-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { errorText, failureText, looksTechnical, requestIdOf, API_DOWN_TEXT, NO_CONNECTION_TEXT, SERVER_ERROR_TEXT } from '../lib/api'
import { summaryProblem, feedProblem, SERVER_DOWN_TEXT, PROXMOX_UNREACHABLE_TEXT } from '../lib/dashboard-problem'
import { dnsLoadState } from '../lib/dns-state'
import { ErrorNotice } from '../components/layout/ErrorNotice'
import { PageError, PAGE_ERROR_TEXT } from '../components/layout/PageError'

test('errorText: the API sentence wins; a 5xx without one becomes a plain sentence', () => {
  assert.equal(errorText({ ok: false, error: "HyperProx's database is not answering. Try again in a minute." }, 'x', 503), "HyperProx's database is not answering. Try again in a minute.")
  assert.equal(errorText(null, 'fallback', 502), API_DOWN_TEXT)
  assert.equal(errorText(null, 'fallback', 500), SERVER_ERROR_TEXT)
  assert.equal(errorText({}, 'fallback', 503), SERVER_ERROR_TEXT)
  assert.equal(errorText(null, 'fallback', 0), NO_CONNECTION_TEXT)
  assert.equal(errorText(null, 'fallback', 404), 'fallback')
  assert.equal(errorText({ error: 'Not allowed' }, 'fallback', 403), 'Not allowed')
})

test("errorText: nginx's api_down body is recognised", () => {
  const body = { ok: false, code: 'api_down', error: "HyperProx's server is restarting or stopped. This page will reconnect by itself." }
  assert.equal(errorText(body, 'x', 503), API_DOWN_TEXT)
})

test('errorText: technical text is never shown', () => {
  for (const raw of [
    'TypeError: Cannot read properties of null (reading \'map\')',
    'Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect (node:net:1555:16)',
    '<html><body>502 Bad Gateway</body></html>',
    '{"errors":[{"message":"invalid"}]}',
    'HTTP 500',
    'Unexpected token < in JSON at position 0',
    'at Object.<anonymous> (/opt/app/dist/index.js:12:5)',
  ]) {
    assert.equal(looksTechnical(raw), true, raw)
    assert.equal(errorText({ error: raw }, 'fallback', 500), SERVER_ERROR_TEXT, raw)
  }
  assert.equal(looksTechnical('The backup ran at 02:00:00 and failed.'), false)
  assert.equal(looksTechnical("Proxmox refused HyperProx's access key. Check the token in Settings → Proxmox."), false)
})

test('failureText: browser failures in words, own messages kept', () => {
  assert.equal(failureText(new TypeError('Failed to fetch')), NO_CONNECTION_TEXT)
  assert.equal(failureText(new SyntaxError('Unexpected token < in JSON at position 0')), API_DOWN_TEXT)
  assert.equal(failureText(new Error('The proxy refused that name.')), 'The proxy refused that name.')
  assert.equal(failureText(new Error('HTTP 502'), 'Could not save.'), 'Could not save.')
  assert.equal(failureText(undefined, 'Could not save.'), 'Could not save.')
})

test('requestIdOf: only a plausible id', () => {
  assert.equal(requestIdOf({ requestId: '3f6c1f5e-8f0a-4c9b-9d55-2f7d1d0e6a11' }), '3f6c1f5e-8f0a-4c9b-9d55-2f7d1d0e6a11')
  assert.equal(requestIdOf({ requestId: '<script>' }), undefined)
  assert.equal(requestIdOf(null), undefined)
})

test('dashboard: a refused token, Proxmox not answering and the server not answering are told apart', () => {
  assert.equal(summaryProblem(200, { success: true, data: {} }), null)
  const auth = summaryProblem(502, { ok: false, code: 'proxmox_auth', error: "Proxmox refused HyperProx's access key. Check the token in Settings → Proxmox.", requestId: 'abcd1234-0000' })!
  assert.equal(auth.kind, 'proxmox_auth')
  assert.match(auth.message, /Settings → Proxmox/)
  assert.equal(auth.requestId, 'abcd1234-0000')
  assert.deepEqual(summaryProblem(504, { ok: false, code: 'proxmox_unreachable', error: 'x' }), { kind: 'proxmox_unreachable', message: PROXMOX_UNREACHABLE_TEXT, requestId: undefined })
  assert.equal(summaryProblem(0, null)!.message, SERVER_DOWN_TEXT)
  assert.equal(summaryProblem(502, null)!.kind, 'server')
  assert.equal(summaryProblem(503, { ok: false, code: 'api_down', error: 'x' })!.message, API_DOWN_TEXT)
  assert.equal(feedProblem({ code: 'proxmox_auth', error: 'refused' })!.kind, 'proxmox_auth')
  assert.equal(feedProblem({ code: 'proxmox_unreachable', error: 'x' })!.message, PROXMOX_UNREACHABLE_TEXT)
  assert.equal(feedProblem(undefined), null)
})

test('DNS: a provider failure with no sentence reads plainly, not as an HTTP status', () => {
  assert.deepEqual(dnsLoadState(502, null), { kind: 'error', message: API_DOWN_TEXT })
  assert.deepEqual(dnsLoadState(500, { success: false }), { kind: 'error', message: SERVER_ERROR_TEXT })
})

test('ErrorNotice shows the sentence and the reference; PageError never the error text', () => {
  const html = renderToStaticMarkup(<ErrorNotice message="Couldn't load your websites — the server did not answer." reference="3f6c1f5e-8f0a" />)
  assert.match(html, /Couldn&#x27;t load your websites/)
  assert.match(html, /Reference: 3f6c1f5e-8f0a/)
  assert.match(html, /role="alert"/)
  assert.doesNotMatch(renderToStaticMarkup(<ErrorNotice message="x" />), /Reference/)
  const page = renderToStaticMarkup(<PageError digest="12345" />)
  assert.ok(page.includes(PAGE_ERROR_TEXT))
  assert.match(page, /Reference: 12345/)
})
