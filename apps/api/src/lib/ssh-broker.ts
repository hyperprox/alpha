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
import type { PinEvidence, PinSource } from './hostkey-pins'

export const CREDENTIAL_CATEGORY   = 'deck'
export const CRED_PROVIDER   = 'ssh'
const HOSTKEY_PROVIDER       = 'hostkey'

/** Credential id used when one login is shared across the fleet. */
export const SHARED_CREDENTIAL_ID = '_shared'

/**
 * Default tmux session name on the target. Stable, so a reconnect re-attaches.
 *
 * Panes pass their own name so that two panes on the SAME host get separate
 * sessions: tmux mirrors every client attached to one session and sizes it to
 * the smallest, so a shared name turns split view into two views of one shell
 * that fight over the window size.
 */
export const TMUX_SESSION = 'terminal'

/** tmux session names cannot contain '.' or ':'; keep it to something safe. */
export function sessionName(raw?: string): string {
  const cleaned = (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return cleaned || TMUX_SESSION
}

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
  /** The tmux session actually attached to, when persistent. */
  session:        string
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

/** Thrown for an id the Terminal must never use: a node login (node-<name>) or the shared login itself. */
export class CredentialIdRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialIdRefused' }
}

/**
 * Resolve the credential for a host: its own first, then (for a cluster guest only) the shared one.
 * Returns null when neither exists, so the caller can prompt.
 *
 * Node logins share this store (hyperprox:deck/ssh, `node-<name>`) but are never returned here: they are
 * HyperProx's root logins to the hypervisors (lib/node-exec.ts nodeCredential reads them), and an operator who
 * may open a guest pane must not be able to open one with a node's login. The shared login is for the shelf
 * of guests it was saved for, not for a hand-added host or a plug-in's device.
 */
export async function loadCredential(id: string): Promise<TerminalCredential | null> {
  const key = credentialId(id)
  if (key.toLowerCase().startsWith('node-')) throw new CredentialIdRefused('Node logins are not available in the Terminal.')
  if (key === SHARED_CREDENTIAL_ID) throw new CredentialIdRefused('The shared login is used only through a guest\'s own id.')
  const candidates = /^(lxc|qemu)-\d{1,9}$/.test(key) ? [key, SHARED_CREDENTIAL_ID] : [key]
  for (const candidate of candidates) {
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
  await deleteCredential(CREDENTIAL_CATEGORY, 'hostkey-source', credentialId(host)).catch(() => undefined)
  await deleteCredential(CREDENTIAL_CATEGORY, 'hostkey-evidence', credentialId(host)).catch(() => undefined)
}

/**
 * Replace the pin for host:port with exactly `fingerprint`, recording how (and, for a verified one, with what).
 * Only lib/terminal-hostkey.ts calls this, after it checked the new key with Proxmox or a person accepted it.
 */
export async function repinHostKey(host: string, port: number, fingerprint: string, source: PinSource, evidence: PinEvidence | null): Promise<void> {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('That is not an SSH SHA256 fingerprint.')
  const id = credentialId(`${host}:${port}`)
  await setCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, id, fingerprint, false)
  await setCredential(CREDENTIAL_CATEGORY, 'hostkey-source', id, source, false)
  if (evidence) await setCredential(CREDENTIAL_CATEGORY, 'hostkey-evidence', id, JSON.stringify(evidence), false)
  else await deleteCredential(CREDENTIAL_CATEGORY, 'hostkey-evidence', id).catch(() => undefined)
}

/** The key type written inside an SSH public key blob ("ssh-ed25519"), or "unknown". */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const len = key.readUInt32BE(0)
  if (len <= 0 || len > 64 || 4 + len > key.length) return 'unknown'
  return key.subarray(4, 4 + len).toString('latin1')
}

/** A pinned key that differs from the one offered. The Deck turns this into a check with Proxmox. */
export class HostKeyChangedError extends Error {
  constructor(readonly host: string, readonly port: number, readonly pinned: string, readonly offered: string, readonly offeredType: string) {
    super(
      `Host key for ${host}:${port} has changed.\r\n` +
      `  pinned:   ${pinned}\r\n` +
      `  offered:  ${offered}\r\n` +
      `Refusing to connect.`,
    )
    this.name = 'HostKeyChangedError'
  }
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
  /** tmux session to attach to or create. Defaults to TMUX_SESSION. */
  session?: string
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
  const tmuxName = sessionName(opts.session)
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
          resolve({ channel, client, persistent, session: tmuxName, hostKeyLearned, fingerprint })
        }

        const pty = { term: 'xterm-256color', cols, rows }

        if (persistent) {
          // new-session -A attaches to an existing session or creates it.
          client.exec(`tmux new-session -A -s ${tmuxName}`, { pty }, done)
        } else {
          client.shell(pty, done)
        }
      }

      if (!useTmux) return openShell(false)

      // Any output at all used to count as "tmux is here", which is wrong twice
      // over: a shell prints "not found" to stdout on some systems, and an
      // appliance CLI answers an unknown command with a syntax error. Require a
      // zero exit AND something that looks like a path to a binary named tmux.
      client.exec('command -v tmux', (err, probe) => {
        if (err) return openShell(false)
        let out = ''
        let exitCode: number | null = null
        probe.on('data', (d: Buffer) => { out += d.toString() })
        probe.on('exit', (code: number) => { exitCode = code })
        probe.on('close', () => openShell(exitCode === 0 && /^\/\S*\/tmux\s*$/m.test(out)))
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
              // Learned on first connection. The Terminal shows it, but nobody has accepted it, so it is NOT a
              // confirmed pin: requirePin callers refuse it until an admin confirms it (Setup checklist).
              await setCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, pinKey, fingerprint, false)
              await setCredential(CREDENTIAL_CATEGORY, 'hostkey-source', pinKey, 'terminal-auto', false)
              hostKeyLearned = true
              return verified(true)
            }
            if (pinned !== fingerprint) {
              fail(new HostKeyChangedError(host, port, pinned, fingerprint, keyTypeOf(key)))
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
    let refusal: Error | null = null

    const fail = (e: Error) => { if (!settled) { settled = true; try { client.end() } catch {} ; reject(refusal ?? e) } }

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
      // The host key must already be pinned (a Terminal pane pins it on first connect, and shows it). A host
      // with no pin is refused before any login is sent: this runs a command as that login, unattended.
      hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
        const fp = fingerprintOf(key)
        getCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, credentialId(`${host}:${port}`))
          .then(pinned => {
            if (!pinned) refusal = new Error(`${host}:${port} has no pinned host key yet (it presents ${fp}). Open it in a Terminal pane first, check the key it shows, then try again.`)
            else if (pinned !== fp) refusal = new Error(`Host key for ${host}:${port} has changed (pinned ${pinned}, offered ${fp}). Refusing to connect.`)
            verified(!!pinned && pinned === fp)
          })
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
