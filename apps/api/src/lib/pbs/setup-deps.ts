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
import { clusterContext } from '../clusters/context'
import { HOME_ID } from '../clusters/registry'
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
 * A node runner that finds the node through the client it is given (not the selected cluster), and runs inside the
 * home cluster's context, so the home node logins are read and only a pinned host key is accepted. With a remote
 * cluster selected and a remote node that shares a home node's name, the home login never goes to the remote node.
 */
export function homeNodeRunner(d: {
  pve: Pick<ProxmoxClient, 'fetchStrict'>
  cred?: typeof nodeCredential
  exec?: typeof execOnNode
}): (node: string, script: string, timeoutMs: number) => Promise<{ code: number; output: string }> {
  const cred = d.cred ?? nodeCredential, exec = d.exec ?? execOnNode
  return (node, script, timeoutMs) => clusterContext.run({ id: HOME_ID, kind: 'home' }, async () => {
    const login = await cred(node)
    if (!login) throw new Error(`No SSH login is saved for node ${node}.`)
    const status = await d.pve.fetchStrict<any[]>('/cluster/status')
    const host = (Array.isArray(status) ? status : []).find((r: any) => r?.type === 'node' && r.name === node)?.ip
    if (!host) throw new Error(`Could not find an address for node ${node}.`)
    const r = await exec({ host, cred: login, command: 'bash -s', input: script, timeoutMs, requirePin: true })
    return { code: r.code, output: r.output }
  })
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
