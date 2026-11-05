// =============================================================================
//  HyperProx — "Let containers use this node's built-in graphics"
//
//  For the Infrastructure page's Portable GPU (and the Setup checklist). One node at a time:
//
//    const a = await igpuAccess('node-b')
//    a.state          'open'   render nodes are 0666, so any container given /dev/dri can use them
//                     'closed' built-in Intel or AMD graphics are there, but only the render group can
//                     'none'   no built-in graphics (or only NVIDIA): nothing to open
//    a.ruleInstalled  HyperProx's /etc/udev/rules.d/99-hyperprox-igpu.rules is on the node
//    await a.apply()  writes the rule, re-triggers udev, checks renderD128 reads 666
//    await a.undo()   deletes the rule and re-triggers udev
//
//  apply() and undo() resolve to { status: 'done'|'already'|'skipped'|'failed', reason, state } and never
//  throw for a node-side failure. The node login comes from the vault: while HyperProx is locked this
//  throws VaultLockedError, and with no login saved for the node it throws IgpuRefusal (409).
//  The trade-off, in the UI's words: any container on that node can then use its built-in graphics.
// =============================================================================

import { hardware, detectNode, productionHardwareDeps, type HardwareDeps } from './hardware'
import { auditCredentialUse } from './audit'

export type IgpuState = 'open' | 'closed' | 'none'
export interface IgpuResult { status: 'done' | 'already' | 'skipped' | 'failed'; reason: string; state: IgpuState }
export interface IgpuAccess {
  node: string
  state: IgpuState
  ruleInstalled: boolean
  apply(): Promise<IgpuResult>
  undo(): Promise<IgpuResult>
}

export class IgpuRefusal extends Error {
  constructor(message: string, public status = 409) { super(message) }
}

export async function igpuAccess(node: string, deps: HardwareDeps = productionHardwareDeps(), by = 'unknown'): Promise<IgpuAccess> {
  const cred = await deps.login(node)
  if (!cred) throw new IgpuRefusal(`No login is saved for ${node}. Add one on Settings → Setup checklist.`)
  const addr = (await deps.addresses())[node] ?? node
  const read = async (): Promise<{ state: IgpuState; rule: boolean }> => {
    const hw = await detectNode(node, addr, deps)
    if (hw.source !== 'probe') throw new IgpuRefusal(`Could not sign in to ${node} to look at its graphics.`, 502)
    return { state: hw.igpuAccess ?? 'none', rule: Boolean(hw.igpuRule) }
  }
  const first = await read()
  const run = async (step: 'igpu-access' | 'igpu-access-undo'): Promise<IgpuResult> => {
    await auditCredentialUse('node_login.use', `node:${node}`, { by, purpose: step === 'igpu-access' ? 'open built-in graphics to containers' : 'close built-in graphics to containers' })
    let r: { status: IgpuResult['status']; reason: string }
    try {
      const out = await deps.exec(addr, cred, hardware.stepScript(step), 60_000)
      r = hardware.parseResult(out.output, out.code)
    } catch (e: any) { r = { status: 'failed', reason: `could not reach ${node}: ${e?.message ?? e}` } }
    const after = await read().catch(() => first)
    return { ...r, state: after.state }
  }
  return {
    node, state: first.state, ruleInstalled: first.rule,
    apply: () => first.state === 'none'
      ? Promise.resolve({ status: 'skipped', reason: 'no built-in graphics on this node', state: 'none' as const })
      : run('igpu-access'),
    undo: () => run('igpu-access-undo'),
  }
}
