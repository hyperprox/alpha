// =============================================================================
//  HyperProx — SSH Broker
//
//  Opens interactive SSH sessions for the Deck. Credentials are decrypted here
//  and never leave this process: no route returns one, and none is ever sent to
//  the browser.
//
//  Two rules this file exists to enforce:
//    1. Host keys are pinned on first connect and a change is refused loudly.
//       Terminal managers are notorious for accepting any key silently.
//    2. Sessions live in tmux on the target, not in the browser. Closing the
//       tab must not kill the work.
// =============================================================================

import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import { createHash } from 'crypto'
import { getCredential, setCredential, deleteCredential, listCredentialKeys } from './credentials'

export const CREDENTIAL_CATEGORY   = 'deck'
const CRED_PROVIDER          = 'ssh'
const HOSTKEY_PROVIDER       = 'hostkey'

/** Credential id used when one login is shared across the fleet. */
export const SHARED_CREDENTIAL_ID = '_shared'

/** Session name on the target. Stable, so every reconnect re-attaches. */
export const TMUX_SESSION = 'hyperprox'

export interface TerminalCredential {
  username:    string
  port:        number
  password?:   string
  privateKey?: string
  passphrase?: string
}

export interface ConnectResult {
  channel:        ClientChannel
  client:         Client
  /** true when tmux was found and the session persists across disconnects. */
  persistent:     boolean
  /** true when this connect learned the host key rather than matching a pinned one. */
  hostKeyLearned: boolean
  fingerprint:    string
}

// ---------------------------------------------------------------------------
//  Credential storage
// ---------------------------------------------------------------------------

/** Credential ids are opaque keys — keep them filesystem/url safe. */
export function credentialId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)
}

export async function saveCredential(id: string, cred: TerminalCredential): Promise<void> {
  await setCredential(CREDENTIAL_CATEGORY, CRED_PROVIDER, credentialId(id), JSON.stringify(cred), true)
}

export async function removeCredential(id: string): Promise<void> {
  await deleteCredential(CREDENTIAL_CATEGORY, CRED_PROVIDER, credentialId(id))
}

export async function listCredentials(): Promise<Array<{ id: string; updatedAt: Date }>> {
  const rows = await listCredentialKeys(CREDENTIAL_CATEGORY, CRED_PROVIDER)
  return rows.map(r => ({ id: r.key, updatedAt: r.updatedAt }))
}

/**
 * Resolve the credential for a host: its own first, then the shared one.
 * Returns null when neither exists, so the caller can prompt.
 */
export async function loadCredential(id: string): Promise<TerminalCredential | null> {
  for (const candidate of [credentialId(id), SHARED_CREDENTIAL_ID]) {
    const raw = await getCredential(CREDENTIAL_CATEGORY, CRED_PROVIDER, candidate)
    if (raw) {
      try { return JSON.parse(raw) as TerminalCredential }
      catch { throw new Error(`Stored credential "${candidate}" is not readable JSON`) }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
//  Host key pinning
// ---------------------------------------------------------------------------

/** OpenSSH-style fingerprint, so it can be compared against ssh-keygen -lf output. */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export async function listHostKeys(): Promise<Array<{ host: string; updatedAt: Date }>> {
  const rows = await listCredentialKeys(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER)
  return rows.map(r => ({ host: r.key, updatedAt: r.updatedAt }))
}

export async function forgetHostKey(host: string): Promise<void> {
  await deleteCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, credentialId(host))
}

// ---------------------------------------------------------------------------
//  Connect
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  host:    string
  port:    number
  cred:    TerminalCredential
  cols:    number
  rows:    number
  /** Set false to get a plain login shell instead of attaching to tmux. */
  useTmux?: boolean
}

/**
 * Open a session and return the live channel.
 *
 * Rejects rather than prompting when the host key has changed — a silent accept
 * is the whole reason this kind of tool gets people compromised.
 */
export function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const { host, port, cred, cols, rows } = opts
  const useTmux = opts.useTmux !== false
  const pinKey  = credentialId(`${host}:${port}`)

  return new Promise<ConnectResult>((resolve, reject) => {
    const client = new Client()

    let fingerprint    = ''
    let hostKeyLearned = false
    let settled        = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* already gone */ }
      reject(err)
    }

    client.on('error', err => fail(err as Error))
    client.on('close', () => { if (!settled) fail(new Error('Connection closed before a shell opened')) })

    client.on('ready', () => {
      // tmux is what makes a pane survive a closed browser. Probe rather than
      // assume — plenty of containers ship without it, and a missing binary
      // must degrade to a plain shell, not to a hang.
      const openShell = (persistent: boolean) => {
        const done = (err: Error | undefined, channel: ClientChannel) => {
          if (err) return fail(err)
          settled = true
          resolve({ channel, client, persistent, hostKeyLearned, fingerprint })
        }

        const pty = { term: 'xterm-256color', cols, rows }

        if (persistent) {
          // new-session -A attaches to an existing session or creates it.
          client.exec(`tmux new-session -A -s ${TMUX_SESSION}`, { pty }, done)
        } else {
          client.shell(pty, done)
        }
      }

      if (!useTmux) return openShell(false)

      client.exec('command -v tmux', (err, probe) => {
        if (err) return openShell(false)
        let found = false
        probe.on('data', (d: Buffer) => { if (d.toString().trim()) found = true })
        probe.on('close', () => openShell(found))
      })
    })

    const config: ConnectConfig = {
      host,
      port,
      username:         cred.username,
      readyTimeout:     15_000,
      keepaliveInterval: 20_000,
      hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
        fingerprint = fingerprintOf(key)
        getCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, pinKey)
          .then(async pinned => {
            if (!pinned) {
              await setCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, pinKey, fingerprint, false)
              hostKeyLearned = true
              return verified(true)
            }
            if (pinned !== fingerprint) {
              fail(new Error(
                `Host key for ${host}:${port} has changed.\r\n` +
                `  pinned:   ${pinned}\r\n` +
                `  offered:  ${fingerprint}\r\n` +
                `Refusing to connect. If this change was expected — the guest was ` +
                `rebuilt, say — clear the pinned key for this host and reconnect.`
              ))
              return verified(false)
            }
            verified(true)
          })
          .catch(e => { fail(e as Error); verified(false) })
      },
    }

    if (cred.privateKey) {
      config.privateKey = cred.privateKey
      if (cred.passphrase) config.passphrase = cred.passphrase
    } else if (cred.password) {
      config.password = cred.password
    } else {
      return fail(new Error('Credential has neither a password nor a private key'))
    }

    try { client.connect(config) }
    catch (e: any) { fail(e) }
  })
}

/**
 * Run one command and collect its output. Used for setup tasks that are not a
 * session — installing tmux, probing what a host has — so they do not have to
 * be typed into a pane by hand.
 */
export function runCommand(
  opts: Omit<ConnectOptions, 'cols' | 'rows' | 'useTmux'> & { command: string },
): Promise<{ code: number; output: string }> {
  const { host, port, cred, command } = opts

  return new Promise((resolve, reject) => {
    const client = new Client()
    let out = ''
    let settled = false

    const fail = (e: Error) => { if (!settled) { settled = true; try { client.end() } catch {} ; reject(e) } }

    client.on('error', e => fail(e as Error))
    client.on('ready', () => {
      client.exec(command, { pty: true }, (err, stream) => {
        if (err) return fail(err)
        stream.on('data', (d: Buffer) => { out += d.toString() })
        stream.stderr?.on('data', (d: Buffer) => { out += d.toString() })
        stream.on('close', (code: number) => {
          settled = true
          client.end()
          resolve({ code: code ?? 0, output: out })
        })
      })
    })

    const config: ConnectConfig = {
      host, port, username: cred.username, readyTimeout: 15_000,
      // The host key is already pinned by the session path; reuse that pin.
      hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
        const fp = fingerprintOf(key)
        getCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, credentialId(`${host}:${port}`))
          .then(pinned => verified(!pinned || pinned === fp))
          .catch(() => verified(false))
      },
    }
    if (cred.privateKey) {
      config.privateKey = cred.privateKey
      if (cred.passphrase) config.passphrase = cred.passphrase
    } else if (cred.password) {
      config.password = cred.password
    } else {
      return fail(new Error('Credential has neither a password nor a private key'))
    }

    try { client.connect(config) } catch (e: any) { fail(e) }
  })
}
