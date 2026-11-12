// =============================================================================
//  HyperProx — Terminal Routes (hosts + SSH credentials)
//
//  The host list is populated from the cluster itself, so a fresh install opens
//  with every guest already listed. Nothing here ever returns a secret.
// =============================================================================

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { livePve }            from '../lib/pve-env'
import {
  SHARED_CREDENTIAL_ID, credentialId, listCredentials, saveCredential,
  removeCredential, listHostKeys, forgetHostKey, loadCredential, runCommand,
  type TerminalCredential,
} from '../lib/ssh-broker'
import {
  CREDENTIAL_CATEGORY, listManualHosts, saveManualHost, removeManualHost,
  saveHostAddress, listHostAddresses, type ManualHost,
} from '../lib/terminal-hosts'
import { PLUGINS }    from '../plugins'
import { getSettings } from '../lib/plugin-host'
import { ipFromLxcNet, isNodeLoginId, resolveTerminalTarget, terminalIdProblem, terminalTargetDeps } from '../lib/terminal-targets'
import { verifyForPane, trustVerdict, hostKeyCheckDeps, HostKeyCheckRefusal } from '../lib/terminal-hostkey'
import { auditOrThrow } from '../lib/audit'
import { isTokenContext } from '../lib/auth'


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
  source:  'cluster' | 'manual' | 'plugin'
  /** False for an appliance CLI, where probing for tmux wastes a round trip. */
  tmux?:   boolean
  hint?:   string
}

const LAYOUT_OWNED = 'u:'
/** The stored-name prefix for the signed-in person's layouts. */
function layoutPrefix(req: FastifyRequest): string {
  return `${LAYOUT_OWNED}${String(req.session?.email ?? '').toLowerCase()}:`
}

export const terminalRoutes: FastifyPluginAsync = async (fastify) => {
  const pve = livePve()   // resolves the current token on every call (see lib/pve-env.ts)

  // -- Hosts ------------------------------------------------------------------
  // Cluster-discovered guests. Manual hosts (a router, a NAS, a VPS) arrive in
  // the next phase and slot into the same shape.
  fastify.get('/hosts', async (_req, reply) => {
    try {
      const [resources, credentials, manual, addresses] = await Promise.all([
        pve.getClusterResources(),
        listCredentials(),
        listManualHosts(),
        listHostAddresses(),
      ])

      const credIds = new Set(credentials.map((c: { id: string }) => c.id))
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

        // A remembered address wins over nothing, and fills the gap Proxmox
        // leaves for VMs and stopped guests.
        if (!ip && addresses[id]) ip = addresses[id]

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
      const manualHosts: TerminalHost[] = manual.map((m: ManualHost) => ({
        id:     m.id,
        name:   m.name,
        vmid:   0,
        node:   'manual',
        type:   'manual',
        status: 'running',
        ip:     m.address,
        port:   m.port,
        // The shared login is for cluster guests only (lib/ssh-broker.ts loadCredential).
        hasCredential: credIds.has(credentialId(m.id)),
        source: 'manual',
      }))

      // Devices a configured plug-in already knows how to reach. The address
      // comes from the plug-in's own base URL, so a router set up once does not
      // have to be typed in again here — and cannot drift out of step with it.
      const pluginHosts: TerminalHost[] = []
      for (const plugin of PLUGINS) {
        const console_ = plugin.manifest.consoleAccess
        if (!console_) continue
        try {
          const stored = await getSettings(plugin.manifest.id)
          const base   = stored[plugin.manifest.baseUrlSetting]
          if (!base) continue
          const id = `plugin-${plugin.manifest.id}`
          pluginHosts.push({
            id,
            name:   `${plugin.manifest.name}${console_.label ? ` — ${console_.label}` : ''}`,
            vmid:   0,
            node:   'plugin',
            type:   'manual',
            status: 'running',
            ip:     addresses[id] ?? new URL(base).hostname,
            port:   console_.defaultPort,
            hasCredential: credIds.has(credentialId(id)),
            source: 'plugin',
            tmux:   console_.tmux !== false,
            hint:   console_.hint,
          })
        } catch { /* an unparseable base URL just means no console offered */ }
      }

      return { success: true, data: [...hosts, ...manualHosts, ...pluginHosts] }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Credentials ------------------------------------------------------------
  // Presence only. Values are decrypted at connect time inside the broker and
  // are never returned by any route.
  fastify.get('/credentials', async (_req, reply) => {
    try {
      // Node logins live in the same store; they are not the Terminal's, so they are not listed here.
      const creds = (await listCredentials()).filter(c => !isNodeLoginId(c.id))
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

  fastify.put<{ Params: { id: string }; Body: TerminalCredential & { alsoShared?: boolean; address?: string } }>(
    '/credentials/:id',
    async (req, reply) => {
      const { username, port, password, privateKey, passphrase, alsoShared, address } = req.body ?? ({} as any)
      fastify.log.info(
        { host: req.params.id, hasPassword: !!password, hasKey: !!privateKey, alsoShared: !!alsoShared },
        '[terminal] credential save requested',
      )

      // Never a node's login (Settings → Setup checklist keeps those) or the shared one under its own name.
      const refused = terminalIdProblem(req.params.id)
      if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })
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
        if (address) await saveHostAddress(req.params.id, address)
        if (alsoShared) await saveCredential(SHARED_CREDENTIAL_ID, cred)
        fastify.log.info({ host: req.params.id, shared: !!alsoShared }, '[terminal] credential saved')
        return { success: true }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>('/credentials/:id', async (req, reply) => {
    const refused = terminalIdProblem(req.params.id)
    if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })
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

  // -- Persistence ------------------------------------------------------------
  // A pane only survives a closed browser if the session lives on the host, and
  // that means tmux. Most containers ship without it, so rather than telling
  // people to go and apt-get it on every guest, install it from here — on an
  // explicit click, and reporting exactly what happened.
  fastify.post<{ Params: { id: string }; Body: { host: string; port?: number } }>(
    '/hosts/:id/enable-persistence',
    async (req, reply) => {
      // The body's host and port are ignored: the login goes only where the id says (lib/terminal-targets.ts).
      const refused = terminalIdProblem(req.params.id)
      if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })

      let cred
      try { cred = await loadCredential(req.params.id) }
      catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
      if (!cred) return reply.status(400).send({ success: false, error: `No saved login for ${req.params.id}.` })
      let host: string, port: number
      try { ({ host, port } = await resolveTerminalTarget(req.params.id, cred.port, terminalTargetDeps())) }
      catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }

      // Covers Debian/Ubuntu, Alpine, RHEL family and Arch. Anything else is
      // reported rather than guessed at.
      const command =
        'if command -v tmux >/dev/null 2>&1; then echo ALREADY; ' +
        'elif command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux; ' +
        'elif command -v apk >/dev/null 2>&1; then apk add --no-cache tmux; ' +
        'elif command -v dnf >/dev/null 2>&1; then dnf install -y tmux; ' +
        'elif command -v yum >/dev/null 2>&1; then yum install -y tmux; ' +
        'elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm tmux; ' +
        'else echo NO_PACKAGE_MANAGER; exit 90; fi; ' +
        'command -v tmux >/dev/null 2>&1 && echo TMUX_OK || { echo TMUX_MISSING; exit 91; }'

      try {
        const { code, output } = await runCommand({ host, port, cred, command })

        if (output.includes('ALREADY')) {
          return { success: true, data: { installed: false, message: 'tmux was already installed — reconnect the pane.' } }
        }
        if (output.includes('NO_PACKAGE_MANAGER')) {
          return reply.status(422).send({
            success: false,
            error: 'No supported package manager on this host (apt, apk, dnf, yum or pacman). Install tmux by hand to make sessions persistent.',
          })
        }
        if (code !== 0 || !output.includes('TMUX_OK')) {
          return reply.status(422).send({
            success: false,
            error: `Could not install tmux (exit ${code}). Last output: ${output.trim().split('\n').slice(-3).join(' / ').slice(0, 400)}`,
          })
        }

        fastify.log.info({ host, port }, '[terminal] tmux installed for session persistence')
        return { success: true, data: { installed: true, message: 'tmux installed — reconnect the pane and the session will survive a closed browser.' } }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  // -- Existing tmux sessions ---------------------------------------------------
  // A pane already lives in tmux, so typing `tmux attach` inside it nests one
  // tmux in another ("sessions should be nested with care"). Instead the pane can
  // ask what is running on the host and open any session in a pane of its own,
  // attached directly - a build left running in one pane, a server console, a
  // session someone started over plain ssh.
  fastify.post<{ Params: { id: string }; Body: { host: string; port?: number } }>(
    '/hosts/:id/tmux-sessions',
    async (req, reply) => {
      // The body's host and port are ignored: the login goes only where the id says (lib/terminal-targets.ts).
      const refused = terminalIdProblem(req.params.id)
      if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })

      let cred
      try { cred = await loadCredential(req.params.id) }
      catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
      if (!cred) return reply.status(400).send({ success: false, error: `No saved login for ${req.params.id}.` })
      let host: string, port: number
      try { ({ host, port } = await resolveTerminalTarget(req.params.id, cred.port, terminalTargetDeps())) }
      catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }

      // `tmux ls` exits non-zero when no server is running; that is an empty
      // list, not an error.
      const command = "tmux ls -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}|#{session_activity}' 2>/dev/null || true"
      try {
        const { output } = await runCommand({ host, port, cred, command })
        const sessions = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).flatMap(line => {
          const [name, windows, attached, created, activity] = line.split('|')
          if (!name || windows === undefined) return []
          return [{
            name,
            windows:  Number(windows) || 0,
            attached: Number(attached) || 0,
            created:  Number(created) || 0,
            activity: Number(activity) || 0,
          }]
        })
        sessions.sort((a, b) => b.activity - a.activity)
        return { success: true, data: sessions }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  // -- Saved layouts ----------------------------------------------------------
  // A layout is a named set of panes plus how they are arranged. Stored server
  // side rather than in the browser so the same arrangement is there from any
  // machine — the whole point is not rebuilding it each morning.
  // Each person's layouts are their own: stored under "u:<email>:<name>". Layouts saved before that (no owner) are
  // shown to admins only. A layout names hosts and addresses, so nobody reads or replaces another person's.
  fastify.get('/layouts', async (req, reply) => {
    try {
      const mine = layoutPrefix(req)
      const admin = hasRole(req.session?.role ?? 'viewer', 'admin')
      const rows = await fastify.prisma.terminalLayout.findMany({ orderBy: { name: 'asc' } })
      const data = rows.flatMap((r: any) => {
        if (r.name.startsWith(mine)) return [{ ...r, name: r.name.slice(mine.length) }]
        if (admin && !r.name.startsWith(LAYOUT_OWNED)) return [{ ...r, shared: true }]
        return []
      })
      return { success: true, data }
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
        const key = layoutPrefix(req) + name
        const row = await fastify.prisma.terminalLayout.upsert({
          where:  { name: key },
          update: { view, panes: panes as any },
          create: { name: key, view, panes: panes as any },
        })
        fastify.log.info({ name, panes: panes.length, view }, '[terminal] layout saved')
        return { success: true, data: { ...row, name } }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.delete<{ Params: { name: string } }>('/layouts/:name', async (req, reply) => {
    try {
      const own = layoutPrefix(req) + req.params.name
      const admin = hasRole(req.session?.role ?? 'viewer', 'admin')
      // Your own layout, or (admins) one saved before layouts had owners. Never another person's.
      const names = admin && !req.params.name.startsWith(LAYOUT_OWNED) ? [own, req.params.name] : [own]
      await fastify.prisma.terminalLayout.deleteMany({ where: { name: { in: names } } })
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- Pinned host keys -------------------------------------------------------
  // Clearing one is the old manual way to accept a rebuilt guest: the next connect learns whatever answers. The
  // Deck now checks a changed key with Proxmox first (below); this stays for admins, deliberate and audited.
  fastify.delete<{ Params: { host: string } }>('/hostkeys/:host', async (req, reply) => {
    if (isTokenContext()) return reply.status(403).send({ success: false, error: 'An API token cannot change host keys.' })
    try {
      await auditOrThrow('host_key.clear', `host:${req.params.host}`, { by: req.session?.email ?? null })
      await forgetHostKey(req.params.host)
      fastify.log.warn({ host: req.params.host }, '[terminal] pinned host key cleared')
      return { success: true }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // -- A changed host key, checked with Proxmox (lib/terminal-hostkey.ts) ---------------------------------------
  // The pane's id decides the host and port, as for every Terminal route; nothing about the key comes from the
  // browser. Operator, like the Terminal itself; trusting anything but a verified key needs an admin (checked there).
  const paneTarget = async (id: string) => {
    let cred = null
    try { cred = await loadCredential(id) } catch { /* the port then defaults as the target says */ }
    return resolveTerminalTarget(id, cred?.port, terminalTargetDeps())
  }
  const refusal = (reply: any, e: any) => {
    if (e instanceof HostKeyCheckRefusal) {
      if (e.retryAfter) reply.header('retry-after', String(e.retryAfter))
      return reply.status(e.status).send({ success: false, error: e.message })
    }
    return reply.status(500).send({ success: false, error: e?.message ?? String(e) })
  }

  fastify.post<{ Params: { id: string } }>('/hosts/:id/hostkey/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const refused = terminalIdProblem(req.params.id)
    if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })
    let target
    try { target = await paneTarget(req.params.id) } catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }
    try {
      const data = await verifyForPane(req.params.id, target.host, target.port, hostKeyCheckDeps())
      fastify.log.info({ host: target.host, port: target.port, state: data.state, reason: data.reason }, '[terminal] changed host key checked')
      return { success: true, data }
    } catch (e: any) { return refusal(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { verdictId?: string; confirmed?: boolean; phrase?: string } }>('/hosts/:id/hostkey/trust', async (req, reply) => {
    const refused = terminalIdProblem(req.params.id)
    if (refused) return reply.status(isNodeLoginId(req.params.id) ? 403 : 400).send({ success: false, error: refused })
    let target
    try { target = await paneTarget(req.params.id) } catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }
    try {
      const body = req.body ?? {}
      const data = await trustVerdict(req.params.id, target, { verdictId: String(body.verdictId ?? ''), confirmed: body.confirmed === true, phrase: typeof body.phrase === 'string' ? body.phrase : undefined }, hostKeyCheckDeps())
      fastify.log.warn({ host: target.host, port: target.port, state: data.state }, '[terminal] host key re-pinned')
      return { success: true, data }
    } catch (e: any) { return refusal(reply, e) }
  })
}
