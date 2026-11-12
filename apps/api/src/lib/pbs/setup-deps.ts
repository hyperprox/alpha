// =============================================================================
//  HyperProx — Proxmox Backup Server from the catalogue: the real connections
//
//  What lib/pbs/catalogue.ts's setup steps and the NAS checks reach in
//  production: the new server (through its pin), the vault, the PBS plug-in's
//  own store and service, the chosen cluster's storage API, and the node's
//  saved, pinned SSH login for the NFS probe and mount.
// =============================================================================

import type { ProxmoxClient } from '../proxmox-client'
import { execOnNode, nodeCredential } from '../node-exec'
import { setCredentials } from '../credentials'
import { pbsService, probePbs } from './index'
import { PbsTransport } from './transport'
import { unmountScript } from './nfs'
import type { SetupDeps } from './catalogue'

/** Run a script on a node (stdin, never the command line) over its saved login. */
export async function pbsSetupNodeRunner(node: string, script: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  const { pveFromEnv } = await import('../pve-env')
  const cred = await nodeCredential(node)
  if (!cred) throw new Error(`No SSH login is saved for node ${node}.`)
  const status = await pveFromEnv().fetchStrict<any[]>('/cluster/status')
  const host = (status ?? []).find((r: any) => r?.type === 'node' && r.name === node)?.ip
  if (!host) throw new Error(`Could not find an address for node ${node}.`)
  const r = await execOnNode({ host, cred, command: 'bash -s', input: script, timeoutMs })
  return { code: r.code, output: r.output }
}

/**
 * After a container is deleted: if the node's fstab still has this container's backup-server NAS line (marked
 * "# hyperprox-pbs <id>"), unmount it and remove the line and its empty folder. The NAS's files are not touched,
 * and the container's id is not used for anything else (a later container with the same id is never changed).
 */
export async function pbsMountCleanup(g: { node: string; vmid: number }, run = pbsSetupNodeRunner): Promise<string> {
  const r = await run(g.node, unmountScript(g.vmid, { detach: false }), 60_000)
  if (/@@pbs nomount/.test(r.output)) return ''
  if (/@@pbs unmounted/.test(r.output)) return ` Its backup-server NAS mount on ${g.node} was removed too (the NAS's files were not touched).`
  return ` Its backup-server NAS mount on ${g.node} could not be removed: delete the line ending "# hyperprox-pbs ${g.vmid}" in /etc/fstab there and unmount /mnt/hyperprox-pbs/${g.vmid}.`
}

export function pbsSetupDeps(pve: Pick<ProxmoxClient, 'fetchStrict'>): SetupDeps {
  return {
    probe: probePbs,
    login: (url, pin, user, password) => PbsTransport.login({ url, pin }, user, password),
    tokenApi: (url, pin, tokenId, secret) => new PbsTransport({ url, pin, tokenId, secret }),
    saveSecrets: (c, p, v) => setCredentials(c, p, v),
    connect: async v => (await pbsService().instances.create(v)).id,
    reading: id => pbsService().reading(id, { fresh: true }),
    pveStorage: {
      list: async () => (await pve.fetchStrict<any[]>('/storage')) ?? [],
      add: async body => { await pve.fetchStrict('/storage', 'POST', new URLSearchParams(body).toString()) },
    },
    now: () => new Date(),
  }
}
