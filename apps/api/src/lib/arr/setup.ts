// =============================================================================
//  HyperProx — the Arr Stack's setup chores
//
//  After the apps start, everything a person would otherwise click through in
//  six web pages: read each app's API key into the vault, turn on sign-in
//  everywhere, add the library folders, connect the download clients, let
//  Prowlarr feed the others, connect Bazarr and Seerr, and point HyperProx's
//  own Arr Stack plug-in at the result.
//
//  Every step does its change and then reads it back from the app itself; a
//  step is "done" only when the read-back agrees. Sign-in is proved from the
//  outside: a request with no key and no cookie must be turned away.
//
//  Nothing secret is logged or put on a step's detail: keys and passwords go to
//  the vault, and the details name what was set, never the value.
// =============================================================================

import { APPS, CATEGORY, LIBRARY, appById, has, type ArrAppId, type Selection } from './components'
import { ARR_DIR, qbitHost } from './compose'

export interface HttpAnswer { status: number; headers: Record<string, string>; body: string }
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  timeoutMs?: number
}
export type Http = (r: HttpRequest) => Promise<HttpAnswer>

export interface StepRef { status: string; detail?: string }

export interface ArrSetupDeps {
  http: Http
  /** Run a script inside the container, as root. */
  sh(script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  readSecrets(category: string, provider: string): Promise<Record<string, string>>
  /** HyperProx's plug-in settings (secrets included), and saving them. */
  pluginSettings(id: string): Promise<Record<string, string>>
  savePluginSettings(id: string, values: Record<string, string>): Promise<void>
  /** The address HyperProx's own requests to ip:port come from, or null when it cannot tell. */
  localAddressTo(ip: string, port: number): Promise<string | null>
  /** A Plex server HyperProx knows a token for, for Seerr's sign-in. */
  mediaServer(): Promise<{ kind: 'plex'; url: string; token: string } | null>
  wait(ms: number): Promise<unknown>
}

export interface ArrSetupInput {
  ip: string
  selection: Selection
  admin: { user: string; password: string }
  vault: { category: string; provider: string }
  /** Port forwarding through the VPN: qBittorrent is told its port from inside the shared network. */
  vpnPortForwarding?: boolean
}

export interface ArrSetupResult { url: string; apps: Array<{ id: ArrAppId; name: string; url: string }>; notes: string[] }

/** The setup steps for a selection, in the order they run. */
export function setupSteps(s: Selection): Array<{ id: string; label: string }> {
  const arrs = s.apps.filter(a => a === 'sonarr' || a === 'radarr' || a === 'lidarr')
  return [
    { id: 'arr-start', label: 'Wait for every app to start' },
    { id: 'arr-storage', label: 'Check the downloads and the library share one filesystem' },
    { id: 'arr-keys', label: 'Keep each app\'s API key in the vault' },
    { id: 'arr-auth', label: 'Turn on sign-in for every app' },
    ...(has(s, 'qbittorrent') ? [{ id: 'arr-qbit', label: 'Set up qBittorrent' }] : []),
    ...(has(s, 'sabnzbd') ? [{ id: 'arr-sab', label: 'Set up SABnzbd' }] : []),
    ...(arrs.length ? [{ id: 'arr-folders', label: 'Add the library folders' }] : []),
    ...(arrs.length && (has(s, 'qbittorrent') || has(s, 'sabnzbd')) ? [{ id: 'arr-clients', label: 'Connect the download clients' }] : []),
    ...(has(s, 'prowlarr') && arrs.length ? [{ id: 'arr-prowlarr', label: 'Let Prowlarr share its indexers' }] : []),
    ...(has(s, 'bazarr') ? [{ id: 'arr-bazarr', label: 'Connect Bazarr' }] : []),
    ...(has(s, 'seerr') ? [{ id: 'arr-seerr', label: 'Connect Seerr' }] : []),
    { id: 'arr-plugin', label: 'Connect the Arr Stack plug-in' },
  ]
}

/** Seerr is left unstarted until it can be claimed: a Seerr nobody has signed in to belongs to whoever opens it first. */
export const SEERR_WAITING = 'Seerr is installed but not started: HyperProx knows no Plex server to sign it in with, and a Seerr nobody has signed in to belongs to whoever opens it first. Connect Plex in HyperProx, then press "Finish Seerr".'

/** v3 for Sonarr and Radarr, v1 for Prowlarr and Lidarr. */
const API: Partial<Record<ArrAppId, string>> = { sonarr: '/api/v3', radarr: '/api/v3', prowlarr: '/api/v1', lidarr: '/api/v1' }
const SERVARR: ArrAppId[] = ['sonarr', 'radarr', 'prowlarr', 'lidarr']

export const hostUrl = (ip: string, id: ArrAppId) => `http://${ip}:${appById(id)!.hostPort}`
/** How the apps reach each other inside the Docker network. */
export const innerUrl = (s: Selection, id: ArrAppId) => `http://${id === 'qbittorrent' ? qbitHost(s) : id}:${appById(id)!.port}`

class SetupError extends Error {}
const fail = (m: string): never => { throw new SetupError(m) }

const parse = (a: HttpAnswer): any => { try { return JSON.parse(a.body) } catch { return null } }

/** Pull one marker's values out of a script's output: "@@key sonarr abc" → { sonarr: 'abc' }. */
export function markers(out: string, tag: string): Record<string, string> {
  const r: Record<string, string> = {}
  for (const l of String(out ?? '').split('\n')) {
    const m = new RegExp(`^@@${tag} ([a-z]+) (\\S+)\\s*$`).exec(l.trim())
    if (m) r[m[1]] = m[2]
  }
  return r
}

/** The script that prints each app's API key from the file the app wrote on first start. */
export function keysScript(s: Selection): string {
  const c = `${ARR_DIR}/config`
  const lines = ['set -u']
  for (const id of SERVARR) if (has(s, id)) {
    lines.push(`k=$(sed -n 's:.*<ApiKey>\\([0-9a-f]\\{32\\}\\)</ApiKey>.*:\\1:p' ${c}/${id}/config.xml 2>/dev/null | head -n1); [ -n "$k" ] && echo "@@key ${id} $k"`)
  }
  if (has(s, 'bazarr')) lines.push(`k=$(awk '/^auth:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="apikey:"{print $2; exit}' ${c}/bazarr/config/config.yaml 2>/dev/null | tr -d "'\\""); [ -n "$k" ] && echo "@@key bazarr $k"`)
  if (has(s, 'sabnzbd')) lines.push(`k=$(sed -n 's/^api_key *= *\\([0-9a-zA-Z]\\{16,\\}\\).*/\\1/p' ${c}/sabnzbd/sabnzbd.ini 2>/dev/null | head -n1); [ -n "$k" ] && echo "@@key sabnzbd $k"`)
  lines.push('true')
  return lines.join('\n') + '\n'
}

/**
 * Run the chores. `step(id)` marks a step running and returns it; each one ends done (read back) or skipped
 * (with the reason), and anything that cannot be finished throws, which fails the install at that step.
 */
export async function runArrSetup(input: ArrSetupInput, step: (id: string) => StepRef, d: ArrSetupDeps): Promise<ArrSetupResult> {
  const s = input.selection
  const { ip } = input
  const keys: Partial<Record<ArrAppId, string>> = {}
  const notes: string[] = []
  const http = d.http
  const servarr = (id: ArrAppId, path: string, o: Partial<HttpRequest> = {}) =>
    http({ method: 'GET', ...o, url: `${hostUrl(ip, id)}${API[id]}${path}`, headers: { 'X-Api-Key': keys[id]!, ...(o.headers ?? {}) } })
  // Only the status reaches the job and its steps: an app's error page can echo a key or a password back.
  const ok = (a: HttpAnswer, what: string) => { if (a.status < 200 || a.status >= 300) fail(`${what} answered ${a.status}${a.status === 400 ? ' (the app refused the settings)' : a.status === 401 || a.status === 403 ? ' (it refused the key or sign-in)' : ''}.`); return parse(a) }

  // ── 1. Everything answers ────────────────────────────────────────────────
  let st = step('arr-start')
  const waiting = new Set(s.apps.filter(a => a !== 'seerr'))
  for (let i = 0; i < 60 && waiting.size; i++) {
    if (i) await d.wait(5000)
    for (const id of [...waiting]) {
      const a = appById(id)!
      if (a.internal) {
        // No port outside Docker: asked on its address inside the Compose network, from the container.
        const c = await d.sh(internalHealthScript(id), 30_000).catch(() => null)
        if (c && a.healthOk.map(String).includes(markers(c.output, 'code')[id] ?? '')) waiting.delete(id)
        continue
      }
      const r = await http({ method: 'GET', url: `${hostUrl(ip, id)}${a.health}`, timeoutMs: 4000 }).catch(() => null)
      if (r && a.healthOk.includes(r.status)) waiting.delete(id)
    }
  }
  if (waiting.size) fail(`${[...waiting].map(id => appById(id)!.name).join(', ')} did not answer within five minutes.`)
  st.status = 'done'; st.detail = `${s.apps.filter(a => a !== 'seerr').map(id => appById(id)!.name).join(', ')} answering`

  // ── 2. One filesystem for downloads and library, and the apps' user can write it ──
  st = step('arr-storage')
  const fs = await d.sh([
    'set -u',
    'for p in /data/media /data/torrents /data/usenet; do [ -d "$p" ] && echo "@@dev $(basename $p) $(stat -c %d "$p")"; done',
    `setpriv --reuid=1000 --regid=1000 --clear-groups sh -c ': > /data/media/.hpx-w && rm -f /data/media/.hpx-w' && echo "@@w media yes"`,
    'true',
  ].join('\n') + '\n', 30_000)
  const dev = markers(fs.output, 'dev'), writable = markers(fs.output, 'w')
  if (writable.media !== 'yes') fail('The apps\' user cannot write to /data/media.')
  const others = ['torrents', 'usenet'].filter(k => dev[k])
  const split = others.filter(k => dev[k] !== dev.media)
  if (split.length) {
    st.status = 'done'
    st.detail = `Warning: /data/${split.join(' and /data/')} ${split.length > 1 ? 'are' : 'is'} on a different filesystem from /data/media, so finished downloads are copied, not hardlinked.`
    notes.push(st.detail)
  } else { st.status = 'done'; st.detail = others.length ? 'Downloads and library are on one filesystem: hardlinks and instant moves work.' : 'The library is writable.' }

  // ── 3. API keys into the vault ───────────────────────────────────────────
  st = step('arr-keys')
  const wantKeys = s.apps.filter(a => SERVARR.includes(a) || a === 'bazarr' || a === 'sabnzbd')
  let got: Record<string, string> = {}
  for (let i = 0; i < 12; i++) {
    if (i) await d.wait(5000)
    got = markers((await d.sh(keysScript(s), 30_000)).output, 'key')
    if (wantKeys.every(id => got[id])) break
  }
  const missingKeys = wantKeys.filter(id => !got[id])
  if (missingKeys.length) fail(`No API key could be read for ${missingKeys.map(id => appById(id)!.name).join(', ')}.`)
  for (const id of wantKeys) keys[id] = got[id]
  // Proved before it is kept: the key really opens the app.
  for (const id of wantKeys) {
    const r = SERVARR.includes(id) ? await servarr(id, '/system/status')
      : id === 'bazarr' ? await http({ method: 'GET', url: `${hostUrl(ip, id)}/api/system/status`, headers: { 'X-API-KEY': keys[id]! } })
        : await http({ method: 'POST', url: `${hostUrl(ip, id)}/api`, form: { mode: 'queue', limit: '1', output: 'json', apikey: keys[id]! } })
    // SABnzbd answers a wrong key with 200 and an error in the body.
    if (r.status !== 200 || (id === 'sabnzbd' && /api key/i.test(r.body))) fail(`${appById(id)!.name}'s API key did not open its API (${r.status}).`)
  }
  const vaultKeys = Object.fromEntries(wantKeys.map(id => [`${id}_api_key`, keys[id]!]))
  if (wantKeys.length) {
    await d.saveSecrets(input.vault.category, input.vault.provider, vaultKeys)
    const back = await d.readSecrets(input.vault.category, input.vault.provider)
    const wrong = Object.keys(vaultKeys).filter(k => back[k] !== vaultKeys[k])
    if (wrong.length) fail(`The vault did not read back ${wrong.join(', ')}.`)
  }
  st.status = 'done'; st.detail = wantKeys.length ? `${wantKeys.map(id => appById(id)!.name).join(', ')}: keys checked and saved in the vault (${input.vault.category}/${input.vault.provider})` : 'No app here has an API key.'

  // ── 4. Sign-in everywhere ────────────────────────────────────────────────
  st = step('arr-auth')
  const user = input.admin.user, pw = input.admin.password
  const secured: string[] = []
  for (const id of s.apps.filter(a => SERVARR.includes(a))) {
    const h = ok(await servarr(id, '/config/host'), `${appById(id)!.name}'s host settings`)
    ok(await servarr(id, '/config/host', { method: 'PUT', json: {
      ...h, authenticationMethod: 'forms', authenticationRequired: 'enabled', username: user, password: pw, passwordConfirmation: pw,
    } }), `Saving ${appById(id)!.name}'s sign-in`)
    const back = ok(await servarr(id, '/config/host'), `${appById(id)!.name}'s host settings`)
    if (back?.authenticationMethod !== 'forms' || back?.authenticationRequired !== 'enabled' || back?.username !== user) fail(`${appById(id)!.name} did not keep its sign-in settings.`)
    await provedClosed(id, `${hostUrl(ip, id)}/`, d, () => d.sh(`docker restart ${id} >/dev/null`, 120_000))
    secured.push(appById(id)!.name)
  }
  if (has(s, 'bazarr')) {
    ok(await http({ method: 'POST', url: `${hostUrl(ip, 'bazarr')}/api/system/settings`, headers: { 'X-API-KEY': keys.bazarr! },
      form: { 'settings-auth-type': 'form', 'settings-auth-username': user, 'settings-auth-password': pw } }), 'Saving Bazarr\'s sign-in')
    const back = ok(await http({ method: 'GET', url: `${hostUrl(ip, 'bazarr')}/api/system/settings`, headers: { 'X-API-KEY': keys.bazarr! } }), 'Bazarr\'s settings')
    if (back?.auth?.type !== 'form' || back?.auth?.username !== user) fail('Bazarr did not keep its sign-in settings.')
    // Bazarr's API always wants its key, so a refused API call proves nothing. Its page is the test: signed out, the
    // page it serves must not carry the API key (with sign-in off it hands the key to anyone who opens it).
    await provedClosed('bazarr', `${hostUrl(ip, 'bazarr')}/`, d, () => d.sh('docker restart bazarr >/dev/null', 120_000), keys.bazarr)
    secured.push('Bazarr')
  }
  // qBittorrent and SABnzbd get theirs in their own steps, Seerr through its media server, FlareSolverr has none.
  st.status = 'done'
  st.detail = `${secured.length ? `${secured.join(', ')}: forms sign-in on, and a request without it is turned away. ` : ''}` +
    `User ${user}; the password is in the vault.${has(s, 'flaresolverr') ? ' FlareSolverr has no sign-in of its own and no page to open; only Prowlarr uses it.' : ''}`

  // ── 5. qBittorrent ───────────────────────────────────────────────────────
  if (has(s, 'qbittorrent')) {
    st = step('arr-qbit')
    const base = hostUrl(ip, 'qbittorrent')
    const login = async (u: string, p: string) => {
      const r = await http({ method: 'POST', url: `${base}/api/v2/auth/login`, form: { username: u, password: p } })
      // qBittorrent 5 answers 204 and names its cookie after the port (QBT_SID_8080); 4.x answered 200 "Ok." with SID.
      const cookie = (r.headers['set-cookie'] ?? '').split(';')[0]
      const good = r.status === 204 || (r.status === 200 && /^Ok/.test(r.body.trim()))
      return good && /^(QBT_)?SID[A-Za-z0-9_]*=/.test(cookie) ? cookie : null
    }
    let cookie = await login(user, pw)
    if (!cookie) {
      // First start: qBittorrent prints a one-session password in its log and nowhere else.
      const t = await d.sh('docker logs qbittorrent 2>&1 | sed -n \'s/.*temporary password is provided for this session: \\([^ ]*\\).*/@@tmp pw \\1/p\' | tail -n1\n', 30_000)
      const temp = /@@tmp pw (\S+)/.exec(t.output)?.[1]
      if (!temp) fail('qBittorrent\'s first-start password was not in its log.')
      cookie = await login('admin', temp!)
      if (!cookie) fail('qBittorrent refused its own first-start password.')
    }
    const hp = await d.localAddressTo(ip, appById('qbittorrent')!.hostPort).catch(() => null)
    const cats = s.apps.map(id => CATEGORY[id]).filter((c): c is string => Boolean(c))
    const prefs: Record<string, unknown> = {
      web_ui_username: user, web_ui_password: pw,
      save_path: '/data/torrents', temp_path_enabled: false,
      // Category paths decide where a download lands (tv → /data/torrents/tv), so moves stay on /data.
      auto_tmm_enabled: true, torrent_changed_tmm_enabled: true, save_path_changed_tmm_enabled: true, category_changed_tmm_enabled: true,
      bypass_local_auth: Boolean(input.vpnPortForwarding),
      // HyperProx's Arr Stack plug-in reads qBittorrent without a password, from its own address and no other.
      bypass_auth_subnet_whitelist_enabled: Boolean(hp), bypass_auth_subnet_whitelist: hp ? `${hp}/32` : '',
      ...(s.vpn ? { current_network_interface: 'tun0' } : { listen_port: 6881 }),
    }
    const auth = { Cookie: cookie! }
    ok(await http({ method: 'POST', url: `${base}/api/v2/app/setPreferences`, headers: auth, form: { json: JSON.stringify(prefs) } }), 'Saving qBittorrent\'s settings')
    for (const c of cats) {
      const r = await http({ method: 'POST', url: `${base}/api/v2/torrents/createCategory`, headers: auth, form: { category: c, savePath: `/data/torrents/${c}` } })
      if (r.status === 409) ok(await http({ method: 'POST', url: `${base}/api/v2/torrents/editCategory`, headers: auth, form: { category: c, savePath: `/data/torrents/${c}` } }), `qBittorrent's ${c} category`)
      else ok(r, `qBittorrent's ${c} category`)
    }
    // Read back with the new password: the old one must be gone, the settings kept.
    const fresh = await login(user, pw)
    if (!fresh) fail('qBittorrent did not accept the new password.')
    const p = ok(await http({ method: 'GET', url: `${base}/api/v2/app/preferences`, headers: { Cookie: fresh! } }), 'qBittorrent\'s settings')
    if (p?.save_path?.replace(/\/$/, '') !== '/data/torrents') fail(`qBittorrent's save path read back as ${p?.save_path}.`)
    if (s.vpn && p?.current_network_interface !== 'tun0') fail('qBittorrent is not bound to the VPN\'s interface.')
    const back = ok(await http({ method: 'GET', url: `${base}/api/v2/torrents/categories`, headers: { Cookie: fresh! } }), 'qBittorrent\'s categories') ?? {}
    const lost = cats.filter(c => String(back[c]?.savePath ?? '').replace(/\/$/, '') !== `/data/torrents/${c}`)
    if (lost.length) fail(`qBittorrent's ${lost.join(', ')} categor${lost.length > 1 ? 'ies' : 'y'} did not read back.`)
    // From anywhere but HyperProx's own address it must ask for the password.
    // (curl reads a -w format that starts with "@" as a file name, so the marker is printed around it.)
    const probe = await d.sh(`printf '@@code qbit %s\\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${appById('qbittorrent')!.hostPort}/api/v2/app/version)"\n`, 30_000)
    const code = markers(probe.output, 'code').qbit
    if (code !== '403' && code !== '401') fail(`qBittorrent answered ${code ?? 'nothing'} to a request with no password, so it is not closed.`)
    await d.saveSecrets(input.vault.category, input.vault.provider, { qbittorrent_user: user })
    st.status = 'done'
    st.detail = `Password changed (in the vault), downloads to /data/torrents, categories ${cats.join(', ') || 'none'}${s.vpn ? ', bound to the VPN (tun0)' : ''}. ` +
      (hp ? `HyperProx's address (${hp}) may read it without the password, for the Arr Stack plug-in.` : 'HyperProx could not tell its own address, so the plug-in cannot read qBittorrent.')
  }

  // ── 6. SABnzbd ───────────────────────────────────────────────────────────
  if (has(s, 'sabnzbd')) {
    st = step('arr-sab')
    const base = `${hostUrl(ip, 'sabnzbd')}/api`
    // By POST: the key and the new password never sit in a URL, which logs keep.
    const sab = (q: Record<string, string>) => http({ method: 'POST', url: base, form: { ...q, apikey: keys.sabnzbd!, output: 'json' } })
    const misc = ok(await sab({ mode: 'get_config', section: 'misc' }), 'SABnzbd\'s settings')?.config?.misc ?? {}
    // The other apps call it "sabnzbd" inside the Docker network; SABnzbd refuses names it does not know.
    const allow = [...new Set([...String(misc.host_whitelist ?? '').split(',').map((x: string) => x.trim()).filter(Boolean), 'sabnzbd'])].join(',')
    for (const [keyword, value] of Object.entries({
      host_whitelist: allow, download_dir: '/data/usenet/incomplete', complete_dir: '/data/usenet/complete', username: user, password: pw,
    })) ok(await sab({ mode: 'set_config', section: 'misc', keyword, value }), `SABnzbd's ${keyword}`)
    const cats = s.apps.map(id => CATEGORY[id]).filter((c): c is string => Boolean(c))
    for (const c of cats) ok(await sab({ mode: 'set_config', section: 'categories', keyword: c, name: c, dir: c }), `SABnzbd's ${c} category`)
    const back = ok(await sab({ mode: 'get_config', section: 'misc' }), 'SABnzbd\'s settings')?.config?.misc ?? {}
    if (back.username !== user || String(back.complete_dir).replace(/\/$/, '') !== '/data/usenet/complete') fail('SABnzbd did not keep its settings.')
    const bc = ok(await sab({ mode: 'get_config', section: 'categories' }), 'SABnzbd\'s categories')?.config?.categories ?? []
    const names = (Array.isArray(bc) ? bc : Object.values(bc)).map((x: any) => String(x?.name ?? ''))
    const lost = cats.filter(c => !names.includes(c))
    if (lost.length) fail(`SABnzbd's ${lost.join(', ')} categor${lost.length > 1 ? 'ies' : 'y'} did not read back.`)
    await provedClosed('sabnzbd', `${hostUrl(ip, 'sabnzbd')}/`, d, () => d.sh('docker restart sabnzbd >/dev/null', 120_000))
    await d.saveSecrets(input.vault.category, input.vault.provider, { sabnzbd_user: user })
    st.status = 'done'
    st.detail = `Sign-in on, downloads to /data/usenet, categories ${cats.join(', ') || 'none'}. Add your Usenet provider in SABnzbd: only you have that login.`
    notes.push('SABnzbd needs your Usenet provider\'s server and login, which only you have: add them under its Servers settings.')
  }

  // ── 7. Library folders ───────────────────────────────────────────────────
  const arrs = s.apps.filter(a => a === 'sonarr' || a === 'radarr' || a === 'lidarr')
  if (arrs.length) {
    st = step('arr-folders')
    for (const id of arrs) {
      const path = LIBRARY[id]!
      const list: any[] = ok(await servarr(id, '/rootfolder'), `${appById(id)!.name}'s folders`) ?? []
      if (!list.some(f => String(f.path).replace(/\/$/, '') === path)) {
        let body: any = { path }
        if (id === 'lidarr') {
          const qp: any[] = ok(await servarr(id, '/qualityprofile'), 'Lidarr\'s quality profiles') ?? []
          const mp: any[] = ok(await servarr(id, '/metadataprofile'), 'Lidarr\'s metadata profiles') ?? []
          if (!qp[0] || !mp[0]) fail('Lidarr has no quality or metadata profile to give its folder.')
          body = { name: 'Music', path, defaultQualityProfileId: qp[0].id, defaultMetadataProfileId: mp[0].id, defaultMonitorOption: 'all', defaultNewItemMonitorOption: 'all', defaultTags: [] }
        }
        ok(await servarr(id, '/rootfolder', { method: 'POST', json: body }), `Adding ${path} to ${appById(id)!.name}`)
      }
      const back: any[] = ok(await servarr(id, '/rootfolder'), `${appById(id)!.name}'s folders`) ?? []
      if (!back.some(f => String(f.path).replace(/\/$/, '') === path)) fail(`${appById(id)!.name} did not keep ${path}.`)
    }
    st.status = 'done'; st.detail = arrs.map(id => `${appById(id)!.name} → ${LIBRARY[id]}`).join(', ')
  }

  // ── 8. Download clients ──────────────────────────────────────────────────
  if (arrs.length && (has(s, 'qbittorrent') || has(s, 'sabnzbd'))) {
    st = step('arr-clients')
    const made: string[] = []
    for (const id of arrs) {
      const schema: any[] = ok(await servarr(id, '/downloadclient/schema'), `${appById(id)!.name}'s download client list`) ?? []
      const existing: any[] = ok(await servarr(id, '/downloadclient'), `${appById(id)!.name}'s download clients`) ?? []
      for (const client of (['qbittorrent', 'sabnzbd'] as const).filter(c => has(s, c))) {
        const impl = client === 'qbittorrent' ? 'QBittorrent' : 'Sabnzbd'
        const name = client === 'qbittorrent' ? 'qBittorrent' : 'SABnzbd'
        if (!existing.some(x => x.implementation === impl)) {
          const sc = schema.find(x => x.implementation === impl) ?? fail(`${appById(id)!.name} does not offer ${name}.`)
          const values: Record<string, unknown> = {
            host: client === 'qbittorrent' ? qbitHost(s) : 'sabnzbd', port: appById(client)!.port, useSsl: false, urlBase: '',
            username: user, password: pw, ...(client === 'sabnzbd' ? { apiKey: keys.sabnzbd } : {}),
            tvCategory: CATEGORY[id], movieCategory: CATEGORY[id], musicCategory: CATEGORY[id],
          }
          const fields = (sc.fields ?? []).map((f: any) => (f.name in values && values[f.name] !== undefined ? { ...f, value: values[f.name] } : f))
          // Saving tests the connection first: a client that cannot be reached is refused, not saved.
          ok(await servarr(id, '/downloadclient', { method: 'POST', json: { ...sc, name, enable: true, priority: 1, fields } }), `Adding ${name} to ${appById(id)!.name}`)
        }
        const back: any[] = ok(await servarr(id, '/downloadclient'), `${appById(id)!.name}'s download clients`) ?? []
        const row = back.find(x => x.implementation === impl)
        if (!row) fail(`${appById(id)!.name} did not keep ${name}.`)
        const t = await servarr(id, '/downloadclient/test', { method: 'POST', json: row })
        if (t.status < 200 || t.status >= 300) fail(`${appById(id)!.name} cannot reach ${name} (${t.status}).`)
        made.push(`${appById(id)!.name} → ${name} (${CATEGORY[id]})`)
      }
    }
    st.status = 'done'; st.detail = `${made.join(', ')}; each tested from the app itself.`
  }

  // ── 9. Prowlarr feeds the others ─────────────────────────────────────────
  if (has(s, 'prowlarr') && arrs.length) {
    st = step('arr-prowlarr')
    const schema: any[] = ok(await servarr('prowlarr', '/applications/schema'), 'Prowlarr\'s app list') ?? []
    const existing: any[] = ok(await servarr('prowlarr', '/applications'), 'Prowlarr\'s apps') ?? []
    for (const id of arrs) {
      const impl = appById(id)!.name
      if (existing.some(x => x.implementation === impl)) continue
      const sc = schema.find(x => x.implementation === impl) ?? fail(`Prowlarr does not offer ${impl}.`)
      const values: Record<string, unknown> = { prowlarrUrl: innerUrl(s, 'prowlarr'), baseUrl: innerUrl(s, id), apiKey: keys[id] }
      const fields = (sc.fields ?? []).map((f: any) => (f.name in values ? { ...f, value: values[f.name] } : f))
      ok(await servarr('prowlarr', '/applications', { method: 'POST', json: { ...sc, name: impl, syncLevel: 'fullSync', fields } }), `Adding ${impl} to Prowlarr`)
    }
    const back: any[] = ok(await servarr('prowlarr', '/applications'), 'Prowlarr\'s apps') ?? []
    const lost = arrs.filter(id => !back.some(x => x.implementation === appById(id)!.name))
    if (lost.length) fail(`Prowlarr did not keep ${lost.map(id => appById(id)!.name).join(', ')}.`)
    let flare = ''
    if (has(s, 'flaresolverr')) {
      const tags: any[] = ok(await servarr('prowlarr', '/tag'), 'Prowlarr\'s tags') ?? []
      const tag = tags.find(t => t.label === 'flaresolverr') ?? ok(await servarr('prowlarr', '/tag', { method: 'POST', json: { label: 'flaresolverr' } }), 'Prowlarr\'s flaresolverr tag')
      const proxies: any[] = ok(await servarr('prowlarr', '/indexerProxy'), 'Prowlarr\'s indexer proxies') ?? []
      if (!proxies.some(p => p.implementation === 'FlareSolverr')) {
        const ps: any[] = ok(await servarr('prowlarr', '/indexerProxy/schema'), 'Prowlarr\'s proxy list') ?? []
        const sc = ps.find(x => x.implementation === 'FlareSolverr') ?? fail('Prowlarr does not offer FlareSolverr.')
        const fields = (sc.fields ?? []).map((f: any) => (f.name === 'host' ? { ...f, value: `${innerUrl(s, 'flaresolverr')}/` } : f.name === 'requestTimeout' ? { ...f, value: 60 } : f))
        ok(await servarr('prowlarr', '/indexerProxy', { method: 'POST', json: { ...sc, name: 'FlareSolverr', tags: [tag.id], fields } }), 'Adding FlareSolverr to Prowlarr')
      }
      const pb: any[] = ok(await servarr('prowlarr', '/indexerProxy'), 'Prowlarr\'s indexer proxies') ?? []
      if (!pb.some(p => p.implementation === 'FlareSolverr')) fail('Prowlarr did not keep FlareSolverr.')
      flare = ' FlareSolverr is set up for indexers tagged "flaresolverr": add that tag to an indexer that shows a browser check.'
    }
    st.status = 'done'
    st.detail = `${arrs.map(id => appById(id)!.name).join(', ')} ${arrs.length > 1 ? 'get' : 'gets'} every indexer you add to Prowlarr.${flare}`
    notes.push('Add your indexers in Prowlarr: it shares each one with the others by itself.')
  }

  // ── 10. Bazarr ───────────────────────────────────────────────────────────
  if (has(s, 'bazarr')) {
    st = step('arr-bazarr')
    const form: Record<string, string> = {}
    for (const id of (['sonarr', 'radarr'] as const)) {
      if (!has(s, id)) continue
      Object.assign(form, {
        [`settings-general-use_${id}`]: 'true', [`settings-${id}-ip`]: id, [`settings-${id}-port`]: String(appById(id)!.port),
        [`settings-${id}-apikey`]: keys[id]!, [`settings-${id}-base_url`]: '/', [`settings-${id}-ssl`]: 'false',
      })
    }
    ok(await http({ method: 'POST', url: `${hostUrl(ip, 'bazarr')}/api/system/settings`, headers: { 'X-API-KEY': keys.bazarr! }, form }), 'Saving Bazarr\'s connections')
    const back = ok(await http({ method: 'GET', url: `${hostUrl(ip, 'bazarr')}/api/system/settings`, headers: { 'X-API-KEY': keys.bazarr! } }), 'Bazarr\'s settings')
    const lost = (['sonarr', 'radarr'] as const).filter(id => has(s, id) && !(back?.general?.[`use_${id}`] === true && back?.[id]?.ip === id && back?.[id]?.apikey === keys[id]))
    if (lost.length) fail(`Bazarr did not keep its ${lost.join(' and ')} connection.`)
    st.status = 'done'
    st.detail = `Connected to ${(['sonarr', 'radarr'] as const).filter(id => has(s, id)).map(id => appById(id)!.name).join(' and ')}. Pick the subtitle languages and providers you want in Bazarr.`
    notes.push('Bazarr needs to know which subtitle languages you want and where to get them: set that in Bazarr.')
  }

  // ── 11. Seerr ────────────────────────────────────────────────────────────
  if (has(s, 'seerr')) {
    st = step('arr-seerr')
    const ms = await d.mediaServer().catch(() => null)
    if (!ms) {
      st.status = 'skipped'
      st.detail = SEERR_WAITING
      notes.push(st.detail)
    } else {
      st.detail = await connectSeerr(ip, s, keys, ms, d)
      st.status = 'done'
      await d.saveSecrets(input.vault.category, input.vault.provider, { seerr_api_key: keys.seerr! })
    }
  }

  // ── 12. HyperProx's own plug-in ──────────────────────────────────────────
  st = step('arr-plugin')
  const current = await d.pluginSettings('arrstack').catch(() => ({} as Record<string, string>))
  if (!has(s, 'sonarr')) { st.status = 'skipped'; st.detail = 'The Arr Stack plug-in starts from Sonarr, which was not picked.' }
  else if (current.sonarr_url) {
    st.status = 'skipped'; st.detail = `The Arr Stack plug-in already reads ${current.sonarr_url}, so it was left as it is.`
    // Lidarr is new to a plug-in that already reads Sonarr: fill in only its own two blanks, change nothing else.
    if (has(s, 'lidarr') && !current.lidarr_url && !current.lidarr_key) {
      const values = { lidarr_url: hostUrl(ip, 'lidarr'), lidarr_key: keys.lidarr! }
      await d.savePluginSettings('arrstack', values)
      const back = await d.pluginSettings('arrstack')
      const lost = Object.keys(values).filter(k => back[k] !== (values as Record<string, string>)[k])
      if (lost.length) fail(`The Arr Stack plug-in did not read back ${lost.join(', ')}.`)
      st.status = 'done'; st.detail += ' Lidarr was added to it.'
    }
  }
  else {
    const values: Record<string, string> = { sonarr_url: hostUrl(ip, 'sonarr'), sonarr_key: keys.sonarr! }
    if (has(s, 'radarr')) Object.assign(values, { radarr_url: hostUrl(ip, 'radarr'), radarr_key: keys.radarr! })
    if (has(s, 'lidarr')) Object.assign(values, { lidarr_url: hostUrl(ip, 'lidarr'), lidarr_key: keys.lidarr! })
    if (has(s, 'prowlarr')) Object.assign(values, { prowlarr_url: hostUrl(ip, 'prowlarr'), prowlarr_key: keys.prowlarr! })
    if (has(s, 'qbittorrent')) values.qbit_url = hostUrl(ip, 'qbittorrent')
    await d.savePluginSettings('arrstack', values)
    const back = await d.pluginSettings('arrstack')
    const lost = Object.keys(values).filter(k => back[k] !== values[k])
    if (lost.length) fail(`The Arr Stack plug-in did not read back ${lost.join(', ')}.`)
    st.status = 'done'; st.detail = `Reads ${Object.keys(values).filter(k => k.endsWith('_url')).map(k => k.replace('_url', '').replace('qbit', 'qBittorrent')).join(', ')} here.`
  }

  const apps = s.apps.filter(a => a !== 'flaresolverr').map(id => ({ id, name: appById(id)!.name, url: hostUrl(ip, id) }))
  return { url: apps[0]?.url ?? `http://${ip}`, apps, notes }
}

/**
 * Prove an app turns a stranger away: no key and no cookie must get a 401, a 403 or a redirect to its login page.
 * Some apps apply a new sign-in method only after a restart; one restart is allowed, then it must hold.
 */
async function provedClosed(id: ArrAppId, url: string, d: ArrSetupDeps, restart: () => Promise<unknown>, pageMustNotHold?: string): Promise<void> {
  const closed = async () => {
    const r = await d.http({ method: 'GET', url, timeoutMs: 5000 }).catch(() => null)
    if (!r) return null
    if (pageMustNotHold) return r.status === 200 ? !r.body.includes(pageMustNotHold) : r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)
    if (r.status === 401 || r.status === 403) return true
    if (r.status >= 300 && r.status < 400) return /login/i.test(r.headers.location ?? '')
    return false
  }
  if (await closed()) return
  await restart()
  for (let i = 0; i < 24; i++) {
    await d.wait(5000)
    const c = await closed()
    if (c === true) return
    if (c === false && i > 3) break
  }
  fail(`${appById(id)!.name} still answers without signing in.`)
}

/** Seerr: its admin is the Plex account, then Plex, Sonarr and Radarr. Returns the step's detail. */
export async function connectSeerr(ip: string, s: Selection, keys: Partial<Record<ArrAppId, string>>, ms: { url: string; token: string },
  d: ArrSetupDeps): Promise<string> {
  const base = hostUrl(ip, 'seerr')
  const start = await d.sh(`cd ${ARR_DIR} && docker compose up -d seerr >/dev/null && echo "@@up seerr yes"\n`, 180_000)
  if (!/@@up seerr yes/.test(start.output)) fail('Seerr did not start.')
  let up = false
  for (let i = 0; i < 36 && !up; i++) { await d.wait(5000); up = (await d.http({ method: 'GET', url: `${base}/api/v1/status` }).catch(() => null))?.status === 200 }
  if (!up) fail('Seerr did not answer within three minutes.')
  // Signing in with the Plex token makes that Plex account Seerr's owner. Done at once, before anyone else can.
  const auth = await d.http({ method: 'POST', url: `${base}/api/v1/auth/plex`, json: { authToken: ms.token } })
  if (auth.status !== 200) fail(`Seerr did not accept the Plex sign-in (${auth.status}).`)
  const cookie = (auth.headers['set-cookie'] ?? '').split(';')[0]
  const key = markers((await d.sh(`grep -o '"apiKey": *"[^"]*"' ${ARR_DIR}/config/seerr/settings.json | head -n1 | sed 's/.*"\\([^"]*\\)"$/@@key seerr \\1/'\n`, 30_000)).output, 'key').seerr
  if (!key) fail('Seerr\'s API key could not be read.')
  keys.seerr = key
  const h = { 'X-Api-Key': key, ...(cookie ? { Cookie: cookie } : {}) }
  const pu = new URL(ms.url)
  const ok = (a: HttpAnswer, what: string) => { if (a.status < 200 || a.status >= 300) fail(`${what} answered ${a.status}`); return parse(a) }
  ok(await d.http({ method: 'POST', url: `${base}/api/v1/settings/plex`, headers: h, json: { ip: pu.hostname, port: Number(pu.port || (pu.protocol === 'https:' ? 443 : 32400)), useSsl: pu.protocol === 'https:' } }), 'Seerr\'s Plex settings')
  const libs: any[] = ok(await d.http({ method: 'GET', url: `${base}/api/v1/settings/plex/library?sync=true`, headers: h }), 'Seerr\'s Plex libraries') ?? []
  if (libs.length) ok(await d.http({ method: 'GET', url: `${base}/api/v1/settings/plex/library?enable=${libs.map(l => encodeURIComponent(String(l.id))).join(',')}`, headers: h }), 'Seerr\'s Plex libraries')
  const linked: string[] = []
  for (const id of (['sonarr', 'radarr'] as const)) {
    if (!has(s, id)) continue
    const profiles: any[] = ok(await d.http({ method: 'GET', url: `${hostUrl(ip, id)}${API[id]}/qualityprofile`, headers: { 'X-Api-Key': keys[id]! } }), `${appById(id)!.name}'s quality profiles`) ?? []
    if (!profiles[0]) fail(`${appById(id)!.name} has no quality profile for Seerr to use.`)
    const body = {
      name: appById(id)!.name, hostname: id, port: appById(id)!.port, apiKey: keys[id], useSsl: false, baseUrl: '',
      activeProfileId: profiles[0].id, activeProfileName: profiles[0].name, activeDirectory: LIBRARY[id],
      is4k: false, isDefault: true, syncEnabled: false, preventSearch: false, tags: [], externalUrl: '',
      ...(id === 'sonarr' ? { enableSeasonFolders: true, animeTags: [] } : { minimumAvailability: 'released' }),
    }
    const list: any[] = ok(await d.http({ method: 'GET', url: `${base}/api/v1/settings/${id}`, headers: h }), `Seerr's ${id} settings`) ?? []
    if (!list.some(x => x.hostname === id)) ok(await d.http({ method: 'POST', url: `${base}/api/v1/settings/${id}`, headers: h, json: body }), `Adding ${appById(id)!.name} to Seerr`)
    const back: any[] = ok(await d.http({ method: 'GET', url: `${base}/api/v1/settings/${id}`, headers: h }), `Seerr's ${id} settings`) ?? []
    if (!back.some(x => x.hostname === id && x.apiKey === keys[id])) fail(`Seerr did not keep ${appById(id)!.name}.`)
    linked.push(appById(id)!.name)
  }
  ok(await d.http({ method: 'POST', url: `${base}/api/v1/settings/initialize`, headers: h }), 'Finishing Seerr\'s setup')
  const pub = ok(await d.http({ method: 'GET', url: `${base}/api/v1/settings/public` }), 'Seerr\'s public settings')
  if (pub?.initialized !== true) fail('Seerr did not finish its setup.')
  return `Signed in with your Plex account (its owner), reading Plex at ${pu.host}, sending requests to ${linked.join(' and ')}.`
}

/** Asks an internal app (no port outside Docker) on its Compose-network address, from the container. */
export function internalHealthScript(id: ArrAppId): string {
  const a = appById(id)!
  return [
    `IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${id} 2>/dev/null)`,
    `printf '@@code ${id} %s\n' "$( [ -n "$IP" ] && curl -s -o /dev/null -w '%{http_code}' "http://$IP:${a.port}${a.health}" || echo 000)"`,
  ].join('\n') + '\n'
}

/** The apps a person opens: everything but FlareSolverr, which has no page. */
export const openable = (s: Selection) => APPS.filter(a => has(s, a.id) && a.id !== 'flaresolverr')
