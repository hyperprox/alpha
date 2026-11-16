// The Plex install's pieces on the wizard's side: the sign-in's states drawn in words (a waiting code, signed in, an
// ended sign-in, no sign-in at all), the picker knowing Plex as a transcode-stack recipe with a library, and the
// review lines for the plan.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './css-stub'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlexClaimView, type ClaimFlow } from '../components/catalogue/PlexClaim'
import { TC_KINDS, isTcRecipe, tcMissing } from '../components/catalogue/TranscodePicker'

const noop = () => {}
const flow = (o: Partial<ClaimFlow> = {}): ClaimFlow => ({ id: 'f1', state: 'waiting', code: 'K7QX', linkUrl: 'https://plex.tv/link', authUrl: 'https://app.plex.tv/auth#?x=1', expiresAt: 1_000_000 + 12 * 60_000, ...o })
const view = (f: ClaimFlow | null, o: { error?: string | null; busy?: boolean } = {}) =>
  renderToStaticMarkup(<PlexClaimView flow={f} error={o.error ?? null} busy={o.busy ?? false} now={1_000_000} onStart={noop} onCancel={noop} />)

test('no sign-in yet: a button, and what skipping it means, in words', () => {
  const html = view(null)
  assert.match(html, /Sign in with Plex/)
  assert.match(html, /Claims the new server to your account for you/)
  assert.match(html, /left unclaimed on your network/)
  assert.match(view(null, { busy: true }), /Starting…/)
})

test('waiting: the code to type at plex.tv/link, read out letter by letter, with the time left and a way out', () => {
  const html = view(flow())
  assert.match(html, /plex\.tv\/link/)
  assert.match(html, /aria-label="Code K 7 Q X"/)
  assert.match(html, />K7QX</)
  assert.match(html, /about 12 minutes/)
  assert.match(html, /Cancel/)
  assert.match(html, /href="https:\/\/app\.plex\.tv\/auth#\?x=1" target="_blank" rel="noreferrer noopener"/)
})

test('signed in: names the account, says what the install will do, and offers another account', () => {
  const html = view(flow({ state: 'signed-in', user: 'casey' }))
  assert.match(html, /Signed in as <b>casey<\/b>/)
  assert.match(html, /claim the new server to this account and connect the Plex plug-in/)
  assert.match(html, /about 25 minutes/)
  assert.match(html, /Use another account/)
  assert.ok(!/K7QX/.test(html), 'the code is gone once it has been used')
})

test('an expired code or a plex.tv error is an alert with a new-code button; an error line is an alert too', () => {
  const html = view(flow({ state: 'expired', error: 'The code expired before it was used. Get a new code and try again.' }))
  assert.match(html, /role="alert"/); assert.match(html, /Get a new code/); assert.match(html, /expired before it was used/)
  assert.match(view(null, { error: 'That Plex sign-in has ended. Sign in again.' }), /role="alert"[\s\S]*has ended/)
})

test('no token of any kind is drawn: the view takes only the sign-in id, code and links', () => {
  const html = view(flow({ state: 'signed-in', user: 'casey' }))
  assert.ok(!/token/i.test(html.replace(/the Plex plug-in/g, '')), html)
})

test('the picker knows Plex as a transcode-stack recipe that needs a library, and nothing else', () => {
  assert.ok(TC_KINDS.includes('plex'))
  assert.equal(isTcRecipe({ id: 'plex', stack: 'transcode' }), true)
  assert.equal(isTcRecipe({ id: 'plex', stack: null }), false)
  assert.deepEqual(tcMissing('plex', { TC_MEDIA: 'path', TC_HOST_PATH: '' }), ['the folder on the node'])
  assert.deepEqual(tcMissing('plex', { TC_MEDIA: 'disk', TC_MEDIA_GB: '200' }), [])
})
