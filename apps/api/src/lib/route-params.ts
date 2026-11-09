// =============================================================================
//  HyperProx — strict route parameters for the routes that build Proxmox paths
//
//  The router decodes a parameter, so "pve%2Fstatus%3Fcommand%3Dshutdown" arrives as one value holding a "/"
//  and a "?". Every value a Proxmox path is built from is checked here first; the Proxmox client also encodes
//  each one (lib/proxmox-client.ts seg()), so neither check alone has to be perfect.
// =============================================================================

import type { FastifyInstance } from 'fastify'

export const NODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/
export const SNAP_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const RULES: Record<string, RegExp> = {
  node: NODE_RE,
  vmid: /^\d{1,9}$/,
  type: /^(lxc|qemu)$/,
  snapname: SNAP_RE,
  sid: /^(ct|vm):\d{1,9}$/,
}

/** The first parameter that breaks its rule, or null. */
export function badParam(params: Record<string, unknown> | undefined): string | null {
  for (const [k, re] of Object.entries(RULES)) {
    const v = params?.[k]
    if (v !== undefined && !re.test(String(v))) return k
  }
  return null
}

/** Refuse (400) a request whose node, vmid, type, snapshot name or HA id is not plainly one of those. */
export function strictParams(fastify: FastifyInstance): void {
  fastify.addHook('preValidation', async (req, reply) => {
    const bad = badParam(req.params as Record<string, unknown>)
    if (bad) return reply.status(400).send({ success: false, code: 'bad_param', error: `That ${bad} is not valid.` })
  })
}
