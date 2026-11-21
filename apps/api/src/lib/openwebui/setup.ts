// =============================================================================
//  HyperProx — Open WebUI: the chores after the install
//
//  Open WebUI made the administrator itself on its first start (the generated password in the vault). This signs in as
//  that account once, makes an API key for HyperProx (kept in the vault as the plug-in's setting; the sign-in token is
//  never kept), checks that open sign-up really is off, and checks the Ollama connection: the models it lists. A missing
//  Ollama does not fail the install; the step says so and the plug-in can reconnect it later.
// =============================================================================

import type { Http, StepRef } from '../arr/setup'
import { OPENWEBUI_PORT } from './recipe'

export interface OpenWebuiSetupInput {
  ip: string
  admin: { email: string; password: string }
  /** Whether the install pointed Open WebUI at an Ollama. */
  ollama: boolean
  vault: { category: string; provider: string }
}

export interface OpenWebuiSetupDeps {
  http: Http
  wait(ms: number): Promise<unknown>
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  /** A script in the container, as root. */
  sh(script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  savePluginSettings(id: string, values: Record<string, string>): Promise<void>
  /** What the plug-in holds now, so an Open WebUI that is already connected is never replaced by this one. */
  pluginSettings(id: string): Promise<Record<string, string>>
}

const INSTALL_DIR = '/opt/app'
/** Blank the password line, check it is blank, recreate the container. Nothing is printed. */
export const CLEAN_SCRIPT = `set -e
cd ${INSTALL_DIR}
sed -i 's/^OWUI_ADMIN_PASSWORD=.*/OWUI_ADMIN_PASSWORD=/' .env
grep -qx 'OWUI_ADMIN_PASSWORD=' .env
docker compose up -d --force-recreate >/dev/null
`

export const openwebuiUrl = (ip: string) => `http://${ip}:${OPENWEBUI_PORT}`
const j = (body: string): any => { try { return JSON.parse(body) } catch { return null } }

export async function waitForOpenWebui(ip: string, d: Pick<OpenWebuiSetupDeps, 'http' | 'wait'>, tries = 60): Promise<boolean> {
  for (let n = 0; n < tries; n++) {
    const r = await d.http({ method: 'GET', url: `${openwebuiUrl(ip)}/health`, timeoutMs: 5000 }).catch(() => null)
    if (r?.status === 200) return true
    await d.wait(5000)
  }
  return false
}

export async function runOpenWebuiSetup(i: OpenWebuiSetupInput, step: (id: string) => StepRef, d: OpenWebuiSetupDeps): Promise<{ url: string; models: number | null; connected: boolean }> {
  const base = openwebuiUrl(i.ip)
  const s1 = step('owui-ready')
  if (!await waitForOpenWebui(i.ip, d)) throw new Error('Open WebUI did not answer within five minutes. Its first start unpacks a lot: check the container (docker compose logs) and try again.')
  s1.status = 'done'; s1.detail = 'Open WebUI answers.'

  const s2 = step('owui-key')
  // The administrator is made at start-up, a moment after /health first answers: a few tries.
  let token: string | null = null, last = 0
  for (let n = 0; n < 12 && !token; n++) {
    const r = await d.http({ method: 'POST', url: `${base}/api/v1/auths/signin`, json: { email: i.admin.email, password: i.admin.password }, timeoutMs: 30_000 })
    last = r.status
    const t = r.status === 200 ? j(r.body)?.token : null
    if (typeof t === 'string' && t) token = t; else await d.wait(5000)
  }
  if (!token) throw new Error(`The administrator Open WebUI made could not sign in (it answered ${last}). Its password is in the vault; check the container's logs.`)
  const auth = { authorization: `Bearer ${token}` }
  const made = await d.http({ method: 'POST', url: `${base}/api/v1/auths/api_key`, headers: auth, timeoutMs: 30_000 })
  const key = made.status === 200 ? j(made.body)?.api_key : null
  if (typeof key !== 'string' || !key) throw new Error(`Open WebUI would not make HyperProx's API key (it answered ${made.status}).`)
  await d.saveSecrets(i.vault.category, i.vault.provider, { api_key: key })
  const mine = !(await d.pluginSettings('openwebui').catch(() => ({} as Record<string, string>))).url
  if (mine) await d.savePluginSettings('openwebui', { url: base, token: key })
  const proof = await d.http({ method: 'GET', url: `${base}/api/v1/auths/admin/config`, headers: { authorization: `Bearer ${key}` }, timeoutMs: 20_000 })
  if (proof.status !== 200) throw new Error(`HyperProx's new key was refused when it was used (Open WebUI answered ${proof.status}). It is in the vault as api_key.`)
  s2.status = 'done'; s2.detail = mine ? 'The key is in the vault, and the Open WebUI plug-in is connected.'
    : 'The key is in the vault as api_key. The Open WebUI plug-in already follows another Open WebUI, so it was left as it is.'

  const s3 = step('owui-signup')
  const cfg = j(proof.body)
  if (cfg?.ENABLE_SIGNUP !== false) throw new Error('Open sign-up is still on in Open WebUI, so anyone who reaches it could make an account. Turn it off in Admin → Settings → General, or remove this install.')
  s3.status = 'done'; s3.detail = 'Open sign-up is off.'

  const s4 = step('owui-ollama')
  let models: number | null = null
  if (!i.ollama) { s4.status = 'skipped'; s4.detail = 'No Ollama was set. Install one from the Catalogue and reconnect it from the plug-in.' }
  else {
    const t = await d.http({ method: 'GET', url: `${base}/ollama/api/tags`, headers: { authorization: `Bearer ${key}` }, timeoutMs: 30_000 }).catch(() => null)
    const m = t?.status === 200 ? j(t.body)?.models : null
    if (Array.isArray(m)) { models = m.length; s4.status = 'done'; s4.detail = `Ollama answers through Open WebUI and lists ${models} model${models === 1 ? '' : 's'}.` }
    else { s4.status = 'failed'; s4.detail = 'Open WebUI could not reach the Ollama. It is installed and working; open the plug-in and use Reconnect once the Ollama is up.' }
  }

  // The administrator's password was only read while Open WebUI had no users. Blank it in the private .env and recreate the
  // container, so it is not left in a file (it stays in the vault); then wait for Open WebUI again.
  const s5 = step('owui-clean')
  const r = await d.sh(CLEAN_SCRIPT, 5 * 60_000)
  if (r.code !== 0) throw new Error(`The administrator password could not be blanked in the install folder (exit ${r.code}). Open WebUI is installed and working; blank OWUI_ADMIN_PASSWORD in ${INSTALL_DIR}/.env and run docker compose up -d there.`)
  if (!await waitForOpenWebui(i.ip, d)) throw new Error('Open WebUI did not answer after it was recreated without the administrator password. Check the container (docker compose logs).')
  s5.status = 'done'; s5.detail = 'The password is no longer in the install folder; it stays in the vault.'
  return { url: base, models, connected: mine }
}
