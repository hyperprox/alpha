// Seerr's media server: Plex or Jellyfin. Which one is chosen (the owner's choice, Plex when both and no choice), how
// Seerr is signed in and set up for each through its own settings API (recorded with fake answers, nothing real is
// called), that a Jellyfin without an administrator sign-in leaves Seerr unstarted instead of unclaimed, and that no
// secret reaches a step's words. Addresses are in documentation ranges.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectSeerr, seerrBlocker, SEERR_NEEDS_JELLYFIN_LOGIN, SEERR_WAITING, type ArrSetupDeps, type HttpRequest } from '../src/lib/arr/setup'
import { arrFinishSeerr, checkArrOptions, mediaPreferOf } from '../src/lib/arr/catalogue'
import { hostParts, mediaSettingsBody, pickMediaServer, serversFromSettings, type JellyfinServer, type PlexServer } from '../src/lib/arr/media-server'
import { ARR_RECIPE } from '../src/lib/arr/recipe'
import { APPS } from '../src/lib/arr/components'
import type { Selection } from '../src/lib/arr/components'

const PLEX: PlexServer = { kind: 'plex', url: 'http://192.0.2.10:32400', token: 'plex-token-xyz' }
const JELLY: JellyfinServer = { kind: 'jellyfin', url: 'http://192.0.2.20:8096', apiKey: 'jelly-api-key-123', user: 'sam', password: 'jelly-pass-456' }
const SEL: Selection = { apps: ['radarr', 'seerr'], vpn: false }

test('which server: the owner\'s choice wins, Plex when both and no choice, the only one otherwise, none is none', () => {
  assert.equal(pickMediaServer('', PLEX, JELLY), PLEX)
  assert.equal(pickMediaServer(undefined, PLEX, JELLY), PLEX)
  assert.equal(pickMediaServer('jellyfin', PLEX, JELLY), JELLY)
  assert.equal(pickMediaServer('plex', PLEX, JELLY), PLEX)
  assert.equal(pickMediaServer('jellyfin', PLEX, null), PLEX, 'a choice HyperProx cannot honour falls back to the one it knows')
  assert.equal(pickMediaServer('', null, JELLY), JELLY)
  assert.equal(pickMediaServer('plex', null, null), null)
})

test('the plug-in settings become servers; a Jellyfin without a key is not one, and a sign-in is optional', () => {
  const k = serversFromSettings({ plex_url: PLEX.url, plex_token: PLEX.token }, { jellyfin_url: JELLY.url, jellyfin_key: JELLY.apiKey })
  assert.deepEqual(k.plex, PLEX)
  assert.deepEqual(k.jellyfin, { kind: 'jellyfin', url: JELLY.url, apiKey: JELLY.apiKey })
  assert.equal(serversFromSettings({}, { jellyfin_url: JELLY.url }).jellyfin, null)
  assert.equal(serversFromSettings({ plex_url: PLEX.url }, {}).plex, null)
  assert.equal(serversFromSettings({}, { jellyfin_url: JELLY.url, jellyfin_key: 'k', jellyfin_user: 'sam', jellyfin_password: 'p' }).jellyfin?.user, 'sam')
})

test('Seerr\'s host parts: ports by default, TLS, a URL base for Jellyfin only', () => {
  assert.deepEqual(hostParts('http://192.0.2.10', 'plex'), { ip: '192.0.2.10', port: 32400, useSsl: false, urlBase: '' })
  assert.deepEqual(hostParts('https://plex.example.net', 'plex'), { ip: 'plex.example.net', port: 443, useSsl: true, urlBase: '' })
  assert.deepEqual(hostParts('http://192.0.2.20/jelly/', 'jellyfin'), { ip: '192.0.2.20', port: 8096, useSsl: false, urlBase: '/jelly' })
  assert.throws(() => hostParts('not a url', 'jellyfin'), /Jellyfin address is not a web address/)
  assert.deepEqual(mediaSettingsBody(PLEX), { ip: '192.0.2.10', port: 32400, useSsl: false })
  assert.deepEqual(mediaSettingsBody(JELLY), { ip: '192.0.2.20', port: 8096, useSsl: false, urlBase: '', apiKey: 'jelly-api-key-123' })
})

/** A Seerr that answers like the real one, recording every request. */
function rig() {
  const calls: HttpRequest[] = []
  const shs: string[] = []
  const http: ArrSetupDeps['http'] = async r => {
    calls.push(r)
    const u = new URL(r.url)
    const ok = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers, body: JSON.stringify(body) })
    if (u.pathname === '/api/v1/status') return ok({ version: '3.5.1' })
    if (u.pathname.startsWith('/api/v1/auth/')) return ok({ id: 1 }, { 'set-cookie': 'connect.sid=abc; Path=/; HttpOnly' })
    // Seerr's real routes: POST .../library/sync lists what the server has, PUT .../library/{id} switches one on.
    if (u.pathname.endsWith('/library/sync') && r.method === 'POST') return ok([{ id: 'lib1', name: 'Films', enabled: false }, { id: 'lib2', name: 'Shows', enabled: false }])
    if (/\/library\/lib\d$/.test(u.pathname) && r.method === 'PUT') return ok({ id: u.pathname.split('/').pop(), enabled: true })
    if (u.pathname.endsWith('/library')) return { status: 404, headers: {}, body: '{}' }
    if (u.pathname === '/api/v1/settings/radarr' && r.method === 'GET') return ok(calls.filter(c => c.method === 'POST' && c.url.endsWith('/settings/radarr')).length ? [{ id: 0, hostname: 'radarr', apiKey: 'radarr-key' }] : [])
    if (u.pathname === '/api/v1/settings/public') return ok({ initialized: true })
    if (u.port === '7878') return ok([{ id: 4, name: 'HD-1080p' }])
    return ok({})
  }
  const d: ArrSetupDeps = {
    http,
    sh: async script => { shs.push(script); return { code: 0, output: /apiKey/.test(script) ? '@@key seerr seerr-key-999\n' : '@@up seerr yes\n' } },
    saveSecrets: async () => {}, readSecrets: async () => ({}), pluginSettings: async () => ({}), savePluginSettings: async () => {},
    localAddressTo: async () => null, mediaServer: async () => null, wait: async () => {},
  }
  return { d, calls, shs }
}

test('Plex: signs in with the Plex token, then Plex settings, libraries, Radarr; no Jellyfin call', async () => {
  const { d, calls } = rig()
  const keys: Record<string, string> = { radarr: 'radarr-key' }
  const detail = await connectSeerr('192.0.2.5', SEL, keys, PLEX, d)
  const paths = calls.map(c => `${c.method} ${new URL(c.url).pathname}`)
  assert.ok(paths.includes('POST /api/v1/auth/plex')); assert.ok(!paths.some(p => /jellyfin/.test(p)))
  assert.deepEqual(calls.find(c => c.url.endsWith('/auth/plex'))!.json, { authToken: 'plex-token-xyz' })
  assert.deepEqual(calls.find(c => c.url.endsWith('/settings/plex'))!.json, { ip: '192.0.2.10', port: 32400, useSsl: false })
  assert.deepEqual(paths.filter(p => /library/.test(p)), ['POST /api/v1/settings/plex/library/sync', 'PUT /api/v1/settings/plex/library/lib1', 'PUT /api/v1/settings/plex/library/lib2'], 'the same two real routes for Plex')
  assert.match(detail, /Signed in with your Plex account/); assert.equal(keys.seerr, 'seerr-key-999')
  assert.doesNotMatch(detail, /plex-token-xyz/)
})

test('Jellyfin: signs in with the administrator\'s sign-in, then Jellyfin settings with the API key, libraries, Radarr; no Plex call', async () => {
  const { d, calls } = rig()
  const keys: Record<string, string> = { radarr: 'radarr-key' }
  const detail = await connectSeerr('192.0.2.5', SEL, keys, JELLY, d)
  const paths = calls.map(c => `${c.method} ${new URL(c.url).pathname}`)
  assert.ok(paths.includes('POST /api/v1/auth/jellyfin')); assert.ok(!paths.some(p => /plex/.test(p)))
  assert.deepEqual(calls.find(c => c.url.endsWith('/auth/jellyfin'))!.json, { username: 'sam', password: 'jelly-pass-456', hostname: '192.0.2.20', port: 8096, useSsl: false, urlBase: '' })
  const set = calls.find(c => c.method === 'POST' && c.url.endsWith('/settings/jellyfin'))!
  assert.deepEqual(set.json, { ip: '192.0.2.20', port: 8096, useSsl: false, urlBase: '', apiKey: 'jelly-api-key-123' })
  assert.equal(set.headers!['X-Api-Key'], 'seerr-key-999'); assert.match(set.headers!.Cookie, /connect\.sid=abc/)
  assert.ok(!calls.some(c => /library\?/.test(c.url)), 'no GET with sync or enable: those routes do not exist')
  const order = calls.map(c => `${c.method} ${new URL(c.url).pathname}`).filter(p => /library/.test(p))
  assert.deepEqual(order, ['POST /api/v1/settings/jellyfin/library/sync', 'PUT /api/v1/settings/jellyfin/library/lib1', 'PUT /api/v1/settings/jellyfin/library/lib2'])
  assert.deepEqual(calls.filter(c => c.method === 'PUT').map(c => c.json), [{ enabled: true }, { enabled: true }])
  assert.match(detail, /Signed in with your Jellyfin account/); assert.match(detail, /Radarr/)
  assert.doesNotMatch(detail, /jelly-pass-456|jelly-api-key-123/)
  assert.ok(paths.includes('POST /api/v1/settings/initialize'))
})

test('a Jellyfin with no administrator sign-in is never signed in: Seerr stays unstarted, with a plain reason', async () => {
  const noLogin: JellyfinServer = { kind: 'jellyfin', url: JELLY.url, apiKey: JELLY.apiKey }
  assert.equal(seerrBlocker(noLogin), SEERR_NEEDS_JELLYFIN_LOGIN)
  assert.equal(seerrBlocker(null), SEERR_WAITING)
  assert.equal(seerrBlocker(JELLY), null); assert.equal(seerrBlocker(PLEX), null)
  assert.match(SEERR_WAITING, /Plex or Jellyfin/)
  const { d, calls, shs } = rig()
  await assert.rejects(connectSeerr('192.0.2.5', SEL, {}, noLogin, d), /no administrator sign-in saved/)
  assert.equal(calls.length, 0); assert.equal(shs.length, 0, 'Seerr was not even started')
})

test('"Finish Seerr" asks for the owner\'s choice, explains a missing Jellyfin sign-in,', async () => {
  const seen: Array<string | undefined> = []
  const { d } = rig()
  const stops: string[] = []
  const base = (ms: any) => ({
    arr: () => ({ ...d, mediaServer: async (p?: any) => { seen.push(p); return ms } }) as any,
    sh: async (s: string, t: number) => { if (/compose stop/.test(s)) stops.push(s); return d.sh(s, t) },
    wait: async () => {}, readSecrets: async () => ({ radarr_api_key: 'radarr-key' }), saveSecrets: async () => {},
  })
  const o = { ip: '192.0.2.5', vault: { category: 'apps', provider: 'arr' }, prefer: 'jellyfin' as const }
  await assert.rejects(arrFinishSeerr(o, base(null)), /no Plex or Jellyfin server/)
  await assert.rejects(arrFinishSeerr(o, base({ kind: 'jellyfin', url: JELLY.url, apiKey: JELLY.apiKey })), /no administrator sign-in saved/)
  assert.deepEqual(seen, ['jellyfin', 'jellyfin'])
  assert.equal(stops.length, 0, 'nothing was started, so nothing to stop')
  const ok = await arrFinishSeerr(o, base(JELLY))
  assert.match(ok, /Jellyfin/)
})

test('the option: blank, plex or jellyfin; anything else is refused; it is never a secret', () => {
  assert.equal(mediaPreferOf({ ARR_MEDIA_SERVER: 'jellyfin' }), 'jellyfin'); assert.equal(mediaPreferOf({ ARR_MEDIA_SERVER: 'emby' }), ''); assert.equal(mediaPreferOf(undefined), '')
  const v = { ARR_SONARR: '1', ARR_SEERR: '1', ARR_PROWLARR: '1', ARR_MEDIA_SERVER: 'emby' }
  assert.ok(checkArrOptions(v).errors.some(e => /Plex or Jellyfin/.test(e)))
  assert.ok(!checkArrOptions({ ...v, ARR_MEDIA_SERVER: 'jellyfin' }).errors.some(e => /Plex or Jellyfin/.test(e)))
  assert.ok(ARR_RECIPE.options.some(o => o.key === 'ARR_MEDIA_SERVER' && o.kind === 'text'))
})

test('naming: Seerr is called "Seerr (formerly Jellyseerr and Overseerr)" where people read it, and the catalogue finds it by the old names', () => {
  assert.match(APPS.find(a => a.id === 'seerr')!.blurb, /^Seerr \(formerly Jellyseerr and Overseerr\)/)
  const kw = ARR_RECIPE.keywords ?? []
  for (const w of ['jellyseerr', 'overseerr', 'requests']) assert.ok(kw.includes(w), w)
})
