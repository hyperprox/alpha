// =============================================================================
//  The production adapters for the guest config service: the Proxmox API through
//  the current token, node logins for read-only probes, Postgres for history and
//  the audit log.
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import { pveFromEnv } from '../pve-env'
import { nodeCredential, execOnNode } from '../node-exec'
import type { GuestPve, NodeShell } from './service'
import { nodeAddressInContext } from '../clusters/nodes'

const form = (p: Record<string, string>) => new URLSearchParams(p).toString()

export function livePveAdapter(): GuestPve {
  return {
    get: (path) => pveFromEnv().fetchStrict(path),
    put: (path, params) => pveFromEnv().fetchStrict(path, 'PUT', form(params)),
    post: (path, params = {}) => pveFromEnv().fetchStrict(path, 'POST', Object.keys(params).length ? form(params) : undefined),
  }
}

/** Node names are not reliably resolvable from a container: ask the cluster for addresses. */
async function nodeAddress(node: string): Promise<string | null> {
  // A remote cluster's node is reached on the address saved for it, never the LAN address it reports.
  return nodeAddressInContext(node, async () => {
    const rows = await pveFromEnv().fetchNode<any[]>('/cluster/status').catch(() => [])
    return (rows ?? []).find((r: any) => r?.type === 'node' && r.name === node)?.ip ?? null
  })
}

/**
 * Read-only probes over the node login, which is read from the vault (credentials registry) and nowhere else.
 * Each use is audited by node and purpose, never with the credential or the command's output.
 */
export function liveNodeShell(audit?: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>): NodeShell {
  return {
    async run(node, command, timeoutMs = 30_000) {
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) return null
      const host = await nodeAddress(node)
      if (!host) return null
      const purpose = command.includes('# HPX write config file') ? 'write config file'
        : command.includes('# HPX read config file') ? 'read config file'
        : command.includes('# HPX clean config temp files') ? 'clean config temp files'
        : command.includes("echo '##lspci'") ? 'device probe'
        : /^pct exec/.test(command) ? 'look inside a container'
        : /if \[ -d '/.test(command) ? 'path check' : 'node command'
      await audit?.('node_login.use', node, { purpose }).catch(() => {})
      const r = await execOnNode({ host, cred, command: 'bash -s', input: command, timeoutMs })
      return { code: r.code, output: r.output }
    },
  }
}

export function prismaAudit(db: PrismaClient) {
  return async (action: string, resource: string, details: Record<string, unknown>) => {
    await db.auditLog.create({ data: { action, resource, details: details as any } })
  }
}

import { getCredential, setCredential } from '../credentials'
import { randomBytes } from 'node:crypto'

/**
 * The history HMAC key, kept in the vault and nowhere else. First use creates it if it is absent and then reads it
 * back, so two concurrent first uses end up with the one key that was stored. Calls are serialised in-process.
 */
let keyLoad: Promise<Buffer> | null = null
export function vaultHmacKey(): Promise<Buffer> {
  keyLoad ??= (async () => {
    const read = async () => { const v = await getCredential('system', 'guest-config', 'history_hmac_key'); return v && /^[0-9a-f]{64}$/.test(v) ? v : null }
    let cur = await read()
    if (!cur) {
      await setCredential('system', 'guest-config', 'history_hmac_key', randomBytes(32).toString('hex'), true)
      cur = await read()
      if (!cur) throw new Error('The history key could not be stored in the vault.')
    }
    return Buffer.from(cur, 'hex')
  })().finally(() => { keyLoad = null })
  return keyLoad
}
