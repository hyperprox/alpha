// =============================================================================
//  HyperProx — Deck Routes (hosts + SSH credentials)
//
//  The host list is populated from the cluster itself, so a fresh install opens
//  with every guest already listed. Nothing here ever returns a secret.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { ProxmoxClient }      from '../lib/proxmox-client'
import {
  SHARED_CREDENTIAL_ID, credentialId, listCredentials, saveCredential,
  removeCredential, listHostKeys, forgetHostKey, type TerminalCredential,
} from '../lib/ssh-broker'
import {
  CREDENTIAL_CATEGORY, listManualHosts, saveManualHost, removeManualHost, type ManualHost,
} from '../lib/terminal-hosts'

function getClient() {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

export interface TerminalHost {
  id:      string              // stable credential/pin key, e.g. "lxc-711"
  name:    string
  vmid:    number
  node:    string
  type:    'lxc' | 'qemu' | 'manual'
  status:  string
  /** Null when it could not be determined — the UI asks rather than guesses. */
  ip:      string | null
  port?:   number
  hasCredential: boolean
  source:  'cluster' | 'manual'
}

/** Pull an IPv4 out of an LXC netN line: name=eth0,...,ip=192.168.2.211/24,... */
function ipFromLxcNet(config: Record<string, any>): string | null {
  for (const [k, v] of Object.entries(config)) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue
    const m = v.match(/(?:^|,)ip=([0-9.]+)(?:\/\d+)?/)
    if (m && m[1] !== '0.0.0.0') return m[1]
  }
  return null
}

export const terminalRoutes: FastifyPluginAsync = async (fastify) => {
  const pve = getClient()

  // -- Hosts ------------------------------------------------------------------
  // Cluster-discovered guests. Manual hosts (a router, a NAS, a VPS) arrive in
  // the next phase and slot into the same shape.
  fastify.get('/hosts', async (_req, reply) => {
    try {
      const [resources, credentials, manual] = await Promise.all([
        pve.getClusterResources(),
        listCredentials(),
        listManualHosts(),
      ])

      const credIds = new Set(credentials.map(c => c.id))
      const shared  = credIds.has(SHARED_CREDENTIAL_ID)

      const guests = (resources as any[]).filter(r => r.type === 'lxc' || r.type === 'qemu')

      // LXC addresses come straight from net0. VM addresses need the guest agent,
      // which is slow and often absent — those are left null and typed in once.
      const hosts = await Promise.all(guests.map(async (g): Promise<TerminalHost> => {
        const id = `${g.type}-${g.vmid}`
        let ip: string | null = null

        if (g.type === 'lxc' && g.status === 'running') {
          try {
            const config = await pve.getVMConfig(g.node, Number(g.vmid), 'lxc')
            ip = ipFromLxcNet(config as Record<string, any>)
          } catch { /* unreadable config is not fatal — the UI will ask */ }
        }

        return {
          id,
          name:   g.name ?? String(g.vmid),
          vmid:   Number(g.vmid),
          node:   g.node,
          type:   g.type,
          status: g.status,
          ip,
          hasCredential: credIds.has(credentialId(id)) || shared,
          source: 'cluster',
        }
      }))

      hosts.sort((a, b) => a.vmid - b.vmid)

      // Hosts added by hand — a router, a NAS, a VPS. Proxmox has never heard of
      // them, which is precisely why they belong here.
      const manualHosts: TerminalHost[] = manual.map(m => ({
        id:     m.id,
        name:   m.name,
        vmid:   0,
        node:   'manual',
        type:   'manual',
        status: 'running',
        ip:     m.address,
        port:   m.port,
        hasCredential: credIds.has(credentialId(m.id)) || shared,
        source: 'manual',
      }))

      return { success: true, data: [...hosts, ...manualHosts] }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Credentials ------------------------------------------------------------
  // Presence only. Values are decrypted at connect time inside the broker and
  // are never returned by any route.
  fastify.get('/credentials', async (_req, reply) => {
    try {
      const creds = await listCredentials()
      return {
        success: true,
        data: {
          ids:      creds.map(c => c.id),
          shared:   creds.some(c => c.id === SHARED_CREDENTIAL_ID),
          hostKeys: await listHostKeys(),
        },
      }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  fastify.put<{ Params: { id: string }; Body: TerminalCredential & { alsoShared?: boolean } }>(
    '/credentials/:id',
    async (req, reply) => {
      const { username, port, password, privateKey, passphrase, alsoShared } = req.body ?? ({} as any)

      if (!username?.trim()) {
        return reply.status(400).send({ success: false, error: 'A username is required' })
      }
      if (!password && !privateKey) {
        return reply.status(400).send({ success: false, error: 'Enter a password or paste a private key' })
      }

      const cred: TerminalCredential = {
        username: username.trim(),
        port:     Number(port) || 22,
        ...(privateKey ? { privateKey, ...(passphrase ? { passphrase } : {}) } : { password }),
      }

      try {
        await saveCredential(req.params.id, cred)
        if (alsoShared) await saveCredential(SHARED_CREDENTIAL_ID, cred)
        fastify.log.info({ host: req.params.id, shared: !!alsoShared }, '[terminal] credential saved')
        return { success: true }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>('/credentials/:id', async (req, reply) => {
    try {
      await removeCredential(req.params.id)
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Manual hosts -----------------------------------------------------------
  fastify.post<{ Body: { name: string; address: string; port?: number } }>(
    '/manual-hosts',
    async (req, reply) => {
      const name    = (req.body?.name ?? '').trim()
      const address = (req.body?.address ?? '').trim()
      const port    = Number(req.body?.port) || 22

      if (!name)    return reply.status(400).send({ success: false, error: 'A name is required' })
      if (!address) return reply.status(400).send({ success: false, error: 'An address is required' })

      try {
        const host = await saveManualHost({ name, address, port })
        fastify.log.info({ id: host.id, address }, '[terminal] manual host added')
        return { success: true, data: host }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>('/manual-hosts/:id', async (req, reply) => {
    try {
      await removeManualHost(req.params.id)
      await removeCredential(req.params.id)
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Saved layouts ----------------------------------------------------------
  // A layout is a named set of panes plus how they are arranged. Stored server
  // side rather than in the browser so the same arrangement is there from any
  // machine — the whole point is not rebuilding it each morning.
  fastify.get('/layouts', async (_req, reply) => {
    try {
      const rows = await fastify.prisma.terminalLayout.findMany({ orderBy: { name: 'asc' } })
      return { success: true, data: rows }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  fastify.put<{ Body: { name: string; view: string; panes: unknown[] } }>(
    '/layouts',
    async (req, reply) => {
      const name  = (req.body?.name ?? '').trim()
      const view  = (req.body?.view ?? 'tabs').trim()
      const panes = req.body?.panes

      if (!name)               return reply.status(400).send({ success: false, error: 'A name is required' })
      if (!Array.isArray(panes)) return reply.status(400).send({ success: false, error: 'panes must be a list' })
      if (!panes.length)       return reply.status(400).send({ success: false, error: 'Open at least one pane before saving a layout' })

      try {
        // Saving under an existing name replaces it — that is what "save" means
        // once you have the arrangement you want on screen.
        const row = await fastify.prisma.terminalLayout.upsert({
          where:  { name },
          update: { view, panes: panes as any },
          create: { name, view, panes: panes as any },
        })
        fastify.log.info({ name, panes: panes.length, view }, '[terminal] layout saved')
        return { success: true, data: row }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.delete<{ Params: { name: string } }>('/layouts/:name', async (req, reply) => {
    try {
      await fastify.prisma.terminalLayout.deleteMany({ where: { name: req.params.name } })
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Pinned host keys -------------------------------------------------------
  // Clearing one is how you accept a genuinely rebuilt guest. Deliberate, and
  // never automatic.
  fastify.delete<{ Params: { host: string } }>('/hostkeys/:host', async (req, reply) => {
    try {
      await forgetHostKey(req.params.host)
      fastify.log.warn({ host: req.params.host }, '[terminal] pinned host key cleared')
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })
}
