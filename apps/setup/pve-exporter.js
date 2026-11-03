'use strict'

/**
 * The read-only Proxmox token the bundled prometheus-pve-exporter signs in with, and the file it reads.
 * Shared by the setup wizard (setup.js) and the API (apps/api/src/lib/pve-exporter.ts, behind
 * `hyperprox pve-exporter` and the Monitoring page), so both make the same token the same way.
 * Zero dependencies, like the wizard.
 *
 * The token lives under the same Proxmox user as HyperProx's own token and is named after it:
 * `<user>!<HyperProx token>-exporter`. It has privilege separation on and one ACL, PVEAuditor on `/`, so
 * it can read everything the exporter reports and change nothing, whatever the user itself may do.
 *
 * It is changed on Proxmox as little as possible (the same rules as the wizard's own token):
 *   reuse    - pve.yml already holds a secret for that token that still authenticates; nothing is made
 *   create   - no token of that name exists yet
 *   recreate - it exists, its comment says this HyperProx made it, and the secret is gone (Proxmox shows a
 *              secret only once): that one token is deleted and made again
 * A token of that name that HyperProx did not make is refused, never replaced. The ACL is set every time
 * (it is idempotent), which also repairs one that was removed by hand.
 */

const fs   = require('fs')
const path = require('path')

const EXPORTER_ROLE = 'PVEAuditor'
/** The uid prometheus-pve-exporter runs as in its image; the file is 0600 and must be its own. */
const EXPORTER_UID  = 101

function exporterTokenName(adminTokenName) {
  return `${String(adminTokenName || 'hyperprox')}-exporter`
}

/** What marks a token as this HyperProx's exporter token: it names the HyperProx token it belongs to. */
function exporterComment(userid, adminTokenName) {
  return `HyperProx metrics exporter, read-only (PVEAuditor) [exporter for ${userid}!${adminTokenName}]`
}

/**
 * pve.yml in the exporter's own format. JSON strings are valid YAML scalars, so values need no other
 * escaping. verify_ssl stays off: Proxmox ships a self-signed certificate, as everywhere else in HyperProx.
 */
function renderPveYml({ user, tokenName, secret }) {
  return [
    '# prometheus-pve-exporter: the read-only Proxmox API token it signs in with (PVEAuditor on /).',
    '# Written by HyperProx. To make a new one: hyperprox pve-exporter (or Monitoring, "Set up Proxmox metrics").',
    'default:',
    `  user: ${JSON.stringify(user)}`,
    `  token_name: ${JSON.stringify(tokenName)}`,
    `  token_value: ${JSON.stringify(secret)}`,
    '  verify_ssl: false',
    '',
  ].join('\n')
}

/** The token a pve.yml holds, or null. Reads the format above and the installer's placeholder. */
function parsePveYml(text) {
  const get = (k) => {
    const m = String(text || '').match(new RegExp(`^\\s+${k}:\\s*(.*?)\\s*$`, 'm'))
    if (!m) return ''
    const v = m[1]
    if (v.startsWith('"')) { try { return JSON.parse(v) } catch { return '' } }
    return v.replace(/^'(.*)'$/, '$1')
  }
  const user = get('user'), tokenName = get('token_name'), secret = get('token_value')
  return user && tokenName && secret ? { user, tokenName, secret } : null
}

function readPveYml(file) {
  try { return parsePveYml(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Write pve.yml: 0600, owned by the exporter's user, replaced in one rename so the exporter never reads
 * half a file. Any directory Docker made in its place is removed first. True when the content changed.
 */
function writePveYml(file, content, uid = EXPORTER_UID) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try { if (fs.statSync(file).isDirectory()) fs.rmSync(file, { recursive: true, force: true }) } catch {}
  let before = null
  try { before = fs.readFileSync(file, 'utf8') } catch {}
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  try { fs.chownSync(tmp, uid, uid) } catch { /* not root (tests): the mode still keeps it private */ }
  fs.renameSync(tmp, file)
  return before !== content
}

/**
 * Make sure the exporter token exists with its ACL, and return what pve.yml should hold.
 * `pve`: the cluster through HyperProx's own access (a sign-in session, or its admin token):
 *   { listTokens(), createToken(name, { privsep, comment }), deleteToken(name),
 *     setAcl({ path, role, token }), tokenWorks(fullTokenId, secret) }
 * `held`: what pve.yml holds now ({ user, tokenName, secret }) or null.
 * Returns { action, user, tokenName, fullTokenId, secret }.
 */
async function ensureExporterToken(pve, { userid, adminTokenName, held }) {
  if (!userid || !adminTokenName) throw new Error('HyperProx has no Proxmox token yet, so there is nothing to name the exporter token after')
  const name = exporterTokenName(adminTokenName)
  const fullTokenId = `${userid}!${name}`
  const comment = exporterComment(userid, adminTokenName)

  let action, secret
  if (held && held.user === userid && held.tokenName === name && held.secret
      && await pve.tokenWorks(fullTokenId, held.secret)) {
    action = 'reuse'
    secret = held.secret
  } else {
    const existing = ((await pve.listTokens()) || []).find(t => t && t.tokenid === name)
    action = 'create'
    if (existing) {
      if (!String(existing.comment || '').includes(`[exporter for ${userid}!${adminTokenName}]`)) {
        throw new Error(`A Proxmox token named ${fullTokenId} already exists and was not made by HyperProx, so it was left alone. Remove it in Proxmox, then try again.`)
      }
      await pve.deleteToken(name)
      action = 'recreate'
    }
    const tok = await pve.createToken(name, { privsep: 1, comment })
    if (!tok || !tok.value) throw new Error('Proxmox created the exporter token but returned no secret')
    secret = tok.value
  }
  await pve.setAcl({ path: '/', role: EXPORTER_ROLE, token: fullTokenId })
  return { action, user: userid, tokenName: name, fullTokenId, secret }
}

module.exports = {
  EXPORTER_ROLE, EXPORTER_UID, exporterTokenName, exporterComment,
  renderPveYml, parsePveYml, readPveYml, writePveYml, ensureExporterToken,
}
