// =============================================================================
//  HyperProx — running commands where the guests live
//
//  The deployment wizard could create a container, point a proxy at it, create
//  the DNS record and issue a real certificate for a box with nothing running
//  inside it. The install step printed its commands and told you to go and run
//  them, because the executor had no shell.
//
//  The obvious fix — SSH into the new container — is the wrong one. It needs a
//  credential for a guest that was created thirty seconds ago, an SSH daemon
//  that may not be installed, and working networking. `pct exec` from the node
//  needs none of those: the node already owns the container, and the container
//  does not have to be reachable, only running.
//
//  So HyperProx needs one credential per node, not one per guest, and it is the
//  same credential store the Terminal already uses.
// =============================================================================

import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import {
  credentialId, fingerprintOf,
  CREDENTIAL_CATEGORY, CRED_PROVIDER, type TerminalCredential,
} from './ssh-broker'
import { getCredential } from './credentials'

const HOSTKEY_PROVIDER = 'hostkey'

/** Credential id for a node, distinct from any guest that shares its name. */
export function nodeCredentialId(node: string): string {
  return credentialId(`node-${node}`)
}

/**
 * A node login, and only ever an explicit one.
 *
 * The Terminal's shared credential deliberately does NOT apply here. It exists
 * so one root password covers a shelf of containers; borrowing it to SSH into
 * the hypervisors is both a guess and a quiet escalation — the user granted it
 * for guests. Worse, falling back to it made the AI's cluster facts announce
 * that installs could run on all five nodes when nothing had ever authenticated
 * to one, which is precisely the kind of confident wrong claim this codebase
 * keeps having to unpick.
 */
export async function nodeCredential(node: string): Promise<TerminalCredential | null> {
  // Not loadCredential(): that helper falls back to the shared login *inside
  // itself*, which is correct for a guest pane and wrong for a hypervisor.
  const raw = await getCredential(CREDENTIAL_CATEGORY, CRED_PROVIDER, nodeCredentialId(node))
  if (!raw) return null
  try { return JSON.parse(raw) as TerminalCredential }
  catch { throw new Error(`Stored login for node ${node} is not readable JSON`) }
}

export interface ExecResult {
  code:   number
  output: string
  /** True when the command was cut off rather than finishing. */
  timedOut: boolean
}

export interface ExecOptions {
  host:      string
  cred:      TerminalCredential
  command:   string
  /** Installs pull packages and images; the default is generous on purpose. */
  timeoutMs?: number
  /** Called with each chunk, so a long install can show progress as it happens. */
  onData?:   (chunk: string) => void
}

/**
 * Run one command on a node and collect its output.
 *
 * Deliberately no pty. A pty merges stderr into stdout, and more importantly it
 * makes apt and docker draw progress bars — thousands of carriage returns that
 * turn a log into a smear. Without one, `DEBIAN_FRONTEND=noninteractive` behaves
 * and the output is readable.
 */
export function execOnNode(opts: ExecOptions): Promise<ExecResult> {
  const { host, cred, command, onData } = opts
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000

  return new Promise((resolve, reject) => {
    const client = new Client()
    let out = ''
    let settled = false
    let timedOut = false

    const finish = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch { /* already gone */ }
      resolve(r)
    }
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch { /* already gone */ }
      reject(e)
    }

    const timer = setTimeout(() => {
      timedOut = true
      finish({ code: -1, output: out, timedOut: true })
    }, timeoutMs)

    client.on('error', e => fail(e as Error))
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) return fail(err)
        const take = (d: Buffer) => {
          const s = d.toString()
          out += s
          onData?.(s)
        }
        stream.on('data', take)
        stream.stderr?.on('data', take)
        stream.on('close', (code: number) => finish({ code: code ?? 0, output: out, timedOut }))
      })
    })

    const config: ConnectConfig = {
      host, port: 22, username: cred.username,
      readyTimeout: 15_000, keepaliveInterval: 20_000,
      // Same pin the Terminal uses. A node whose key changed is refused here for
      // exactly the reason it is refused there.
      hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
        const fp = fingerprintOf(key)
        getCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, credentialId(`${host}:22`))
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
      return fail(new Error('Node credential has neither a password nor a private key'))
    }

    try { client.connect(config) } catch (e: any) { fail(e) }
  })
}

/**
 * Run a script *inside* a container, from its node.
 *
 * The script is written to a file and pushed rather than interpolated into a
 * command line. An install script is full of quotes, heredocs and dollar signs,
 * and every layer of shell it passes through is another chance to mangle one —
 * a compose file with `${VAR}` in it does not survive being nested three deep.
 */
export function execInGuest(opts: {
  host: string
  cred: TerminalCredential
  vmid: number
  script: string
  timeoutMs?: number
  onData?: (chunk: string) => void
}): Promise<ExecResult> {
  // A delimiter the payload cannot contain, so the heredoc always terminates.
  const tag  = `HPEOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const tmp  = `/tmp/hyperprox-${opts.vmid}-${Date.now()}.sh`

  const command = [
    `set -e`,
    `cat > ${tmp} <<'${tag}'`,
    opts.script,
    tag,
    // Nothing here assumes the guest has networking, ssh, or even a shell on
    // PATH beyond bash — pct works on a container that can do none of that.
    `pct push ${opts.vmid} ${tmp} /tmp/hyperprox-install.sh --perms 755`,
    `rm -f ${tmp}`,
    `pct exec ${opts.vmid} -- bash /tmp/hyperprox-install.sh`,
    `_rc=$?`,
    `pct exec ${opts.vmid} -- rm -f /tmp/hyperprox-install.sh || true`,
    `exit $_rc`,
  ].join('\n')

  return execOnNode({ ...opts, command })
}
