// =============================================================================
//  HyperProx — Immich: the chores after the install
//
//  Immich starts with no account at all, and whoever opens it first becomes its administrator. So the install makes
//  that account itself, straight away, over the container's own address, with a password it generated (already in the
//  vault: the installer saves it before anything runs). Then it signs in once, makes an API key for HyperProx that can
//  only read the numbers and look after the job queues, keeps the key in the vault as the plug-in's setting, and
//  turns on hardware video conversion when the node has the hardware. The sign-in token is used for those requests
//  only and is never kept.
//
//  Every request goes to one address (the container's) through an injected http, so the tests stand in for Immich.
// =============================================================================

import type { Http, StepRef } from '../arr/setup'
import { IMMICH_KEY_PERMISSIONS, IMMICH_PORT } from './recipe'

export interface ImmichSetupInput {
  ip: string
  admin: { email: string; name: string; password: string }
  /** What Immich is told to use for video conversion: from the preview, never from the request. */
  ffmpeg: 'disabled' | 'nvenc' | 'qsv' | 'vaapi'
  vault: { category: string; provider: string }
}

export interface ImmichSetupDeps {
  http: Http
  wait(ms: number): Promise<unknown>
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  /** The Immich plug-in's own settings (its address and key), as every plug-in is connected. */
  savePluginSettings(id: string, values: Record<string, string>): Promise<void>
  /** What the plug-in holds now, so an Immich that is already connected is never replaced by this one. */
  pluginSettings(id: string): Promise<Record<string, string>>
}

export const immichUrl = (ip: string) => `http://${ip}:${IMMICH_PORT}`

const j = (body: string): any => { try { return JSON.parse(body) } catch { return null } }

/** Wait until Immich answers its ping. The first start builds the database, so this is generous. */
export async function waitForImmich(ip: string, d: Pick<ImmichSetupDeps, 'http' | 'wait'>, tries = 60): Promise<boolean> {
  for (let n = 0; n < tries; n++) {
    const r = await d.http({ method: 'GET', url: `${immichUrl(ip)}/api/server/ping`, timeoutMs: 5000 }).catch(() => null)
    if (r?.status === 200 && j(r.body)?.res === 'pong') return true
    await d.wait(5000)
  }
  return false
}

export async function runImmichSetup(i: ImmichSetupInput, step: (id: string) => StepRef, d: ImmichSetupDeps): Promise<{ url: string; keyName: string; connected: boolean }> {
  const base = immichUrl(i.ip)
  const s1 = step('immich-ready')
  if (!await waitForImmich(i.ip, d)) throw new Error('Immich did not answer within five minutes. Its containers may still be starting: check them from the container\'s console (docker compose ps) and try again.')
  s1.status = 'done'; s1.detail = 'Immich answers.'

  // The administrator. The server refuses this once any account exists, so a second run can never replace one.
  const s2 = step('immich-admin')
  const up = await d.http({ method: 'POST', url: `${base}/api/auth/admin-sign-up`, json: { email: i.admin.email, name: i.admin.name, password: i.admin.password }, timeoutMs: 30_000 })
  if (up.status !== 201 && up.status !== 200) {
    const already = /already has an admin|admin.*exist/i.test(up.body)
    throw new Error(already
      ? 'Immich already has an administrator, so HyperProx did not make one. Something opened it before the install finished: sign in to it, or remove this install and start again.'
      : `Immich refused to make the administrator (it answered ${up.status}).`)
  }
  const login = await d.http({ method: 'POST', url: `${base}/api/auth/login`, json: { email: i.admin.email, password: i.admin.password }, timeoutMs: 30_000 })
  const token = login.status === 201 || login.status === 200 ? j(login.body)?.accessToken : null
  if (typeof token !== 'string' || !token) throw new Error(`The new administrator could not sign in (Immich answered ${login.status}).`)
  s2.status = 'done'; s2.detail = `${i.admin.email} is the administrator. Its password is in the vault.`
  const auth = { authorization: `Bearer ${token}` }

  // HyperProx's own key: read the numbers, look after the queues, nothing that reads a photo.
  const s3 = step('immich-key')
  const keyName = 'HyperProx'
  const made = await d.http({ method: 'POST', url: `${base}/api/api-keys`, headers: auth, json: { name: keyName, permissions: [...IMMICH_KEY_PERMISSIONS] }, timeoutMs: 30_000 })
  const secret = made.status === 201 || made.status === 200 ? j(made.body)?.secret : null
  if (typeof secret !== 'string' || !secret) throw new Error(`Immich would not make HyperProx's API key (it answered ${made.status}).`)
  // Kept first: a key that exists only in this request is lost.
  await d.saveSecrets(i.vault.category, i.vault.provider, { api_key: secret })
  // The plug-in follows one Immich. When another is already connected it is left alone; this one's key is in the vault.
  const mine = !(await d.pluginSettings('immich').catch(() => ({} as Record<string, string>))).url
  if (mine) await d.savePluginSettings('immich', { url: base, key: secret })
  // Proof it works, with the key and not the sign-in: the numbers the plug-in reads.
  const proof = await d.http({ method: 'GET', url: `${base}/api/server/statistics`, headers: { 'x-api-key': secret }, timeoutMs: 20_000 })
  if (proof.status !== 200) throw new Error(`HyperProx's new key was refused when it was used (Immich answered ${proof.status}). It is in the vault as api_key; the plug-in is connected to it.`)
  s3.status = 'done'; s3.detail = mine ? 'The key reads statistics and manages the job queues, and nothing else. It is in the vault, and the Immich plug-in is connected.'
    : 'The key is in the vault as api_key. The Immich plug-in already follows another Immich, so it was left as it is: change its address and key in its settings to follow this one.'

  // Hardware video conversion, set in Immich's own settings and read back.
  const s4 = step('immich-hw')
  if (i.ffmpeg === 'disabled') { s4.status = 'skipped'; s4.detail = 'No acceleration was chosen.' }
  else {
    const cur = await d.http({ method: 'GET', url: `${base}/api/system-config`, headers: auth, timeoutMs: 20_000 })
    const cfg = cur.status === 200 ? j(cur.body) : null
    if (!cfg || typeof cfg !== 'object' || typeof cfg.ffmpeg !== 'object') throw new Error(`Immich's settings could not be read to turn on hardware conversion (it answered ${cur.status}).`)
    cfg.ffmpeg.accel = i.ffmpeg
    cfg.ffmpeg.accelDecode = true
    const put = await d.http({ method: 'PUT', url: `${base}/api/system-config`, headers: auth, json: cfg, timeoutMs: 30_000 })
    if (put.status !== 200) throw new Error(`Immich refused the hardware conversion setting (it answered ${put.status}).`)
    const back = await d.http({ method: 'GET', url: `${base}/api/system-config`, headers: auth, timeoutMs: 20_000 })
    if (j(back.body)?.ffmpeg?.accel !== i.ffmpeg) throw new Error('Immich did not keep the hardware conversion setting: it read back as something else.')
    s4.status = 'done'; s4.detail = `Video conversion uses ${i.ffmpeg === 'nvenc' ? 'the NVIDIA card' : i.ffmpeg === 'qsv' ? 'Intel Quick Sync' : 'the graphics (VAAPI)'}, with hardware decoding.`
  }
  return { url: base, keyName, connected: mine }
}
