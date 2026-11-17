// In-page confirmation, client side: reading the API's confirm_required answer, the dialog, and the fetch wrapper
// sending the action again with its token only when the person confirms.
import './css-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { askConfirm, cancelledResponse, confirmAsked, setConfirmAsker, CANCELLED_CODE, IN_PAGE, IN_PAGE_HEADER } from '../lib/confirm-bus'
import { ConfirmDialog } from '../components/vault/ConfirmDialog'

const asked = { ok: false, code: 'confirm_required', error: 'Reboot n2?', confirm: { token: 'tok-1', summary: 'Reboot n2? Its HA guests move first.', expiresAt: 'x' } }

test('a confirm_required answer is read; anything else is not', () => {
  assert.deepEqual(confirmAsked(403, asked), { token: 'tok-1', summary: 'Reboot n2? Its HA guests move first.' })
  assert.equal(confirmAsked(200, asked), null)
  assert.equal(confirmAsked(403, { code: 'reconfirm_required' }), null, 'the master password is a different answer')
  assert.equal(confirmAsked(403, { code: 'confirm_required' }), null, 'no token, nothing to send')
  assert.equal(confirmAsked(403, { ...asked, confirm: { token: 't' } })!.summary, 'Reboot n2?', 'falls back to the error')
})

test('with no dialog mounted the answer is no; a mounted one decides', async () => {
  assert.equal(await askConfirm({ summary: 'x' }), false)
  const off = setConfirmAsker(async r => r.summary === 'yes')
  assert.equal(await askConfirm({ summary: 'yes' }), true)
  assert.equal(await askConfirm({ summary: 'no' }), false)
  off()
  assert.equal(await askConfirm({ summary: 'yes' }), false)
})

test('Cancel comes back as a plain refusal that says nothing was done', async () => {
  const r = cancelledResponse()
  assert.equal(r.status, 499)
  const b = await r.json()
  assert.equal(b.code, CANCELLED_CODE)
  assert.match(b.error, /Nothing was done/)
  assert.equal(IN_PAGE[IN_PAGE_HEADER], '1')
})

test('the dialog says what will happen, with Confirm and Cancel; a typed name keeps Confirm off', () => {
  const html = renderToStaticMarkup(<ConfirmDialog message="Reboot n2? Its HA guests move first." onConfirm={() => {}} onCancel={() => {}} />)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /Reboot n2\? Its HA guests move first\./)
  assert.match(html, />Cancel</)
  assert.match(html, />Confirm</)
  assert.ok(!/password/i.test(html), 'no password field')
  const typed = renderToStaticMarkup(<ConfirmDialog message="Delete web?" typeName="web" danger onConfirm={() => {}} onCancel={() => {}} />)
  assert.match(typed, /Type web to confirm/)
  assert.match(typed, /disabled=""[^>]*>Confirm</)
})

test('the fetch wrapper asks once, then sends the identical request with the token; Cancel sends nothing more', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const answers: Response[] = []
  const g = globalThis as any
  const saved = { window: g.window, fetch: g.fetch }
  const fakeFetch = async (input: any, init?: RequestInit) => {
    const h: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { h[k] = v })
    calls.push({ url: String(input), headers: h, body: init?.body })
    return answers.shift()!
  }
  g.window = { location: { origin: 'https://hpx.example', pathname: '/updates', search: '' }, fetch: fakeFetch, addEventListener() {}, dispatchEvent() {} }
  try {
    const { installAuthInterceptor } = await import('../lib/api')
    installAuthInterceptor()
    const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

    let shown: string[] = []
    const off = setConfirmAsker(async r => { shown.push(r.summary); return true })
    answers.push(json(asked, 403), json({ ok: true }, 200))
    const r = await g.window.fetch('/api/updates/nodes/n2/reboot', { method: 'POST', body: '{"a":1}' })
    assert.equal(r.status, 200)
    assert.deepEqual(shown, ['Reboot n2? Its HA guests move first.'])
    assert.equal(calls.length, 2)
    assert.equal(calls[1].headers['x-hyperprox-confirm'], 'tok-1')
    assert.equal(calls[1].body, '{"a":1}', 'the same body')

    // Already confirmed on the page: no second dialog, and the marker never leaves the browser.
    calls.length = 0; shown = []
    answers.push(json(asked, 403), json({ ok: true }, 200))
    await g.window.fetch('/api/updates/nodes/n2/reboot', { method: 'POST', headers: IN_PAGE })
    assert.deepEqual(shown, [])
    assert.equal(calls[0].headers[IN_PAGE_HEADER.toLowerCase()], undefined)
    assert.equal(calls[1].headers['x-hyperprox-confirm'], 'tok-1')
    off()

    // Cancel: nothing more is sent.
    calls.length = 0
    const off2 = setConfirmAsker(async () => false)
    answers.push(json(asked, 403))
    const c = await g.window.fetch('/api/updates/nodes/n2/reboot', { method: 'POST' })
    assert.equal(calls.length, 1)
    assert.equal((await c.json()).code, CANCELLED_CODE)
    off2()
  } finally {
    g.window = saved.window
  }
})
