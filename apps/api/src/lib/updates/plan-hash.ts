// =============================================================================
//  HyperProx — Updates: what a plan is, for "the plan you confirmed is the plan that runs"
//
//  Update now (the simple page) asks for the plan (/preview), shows it in one confirmation and starts the run with
//  this hash bound to that confirmation. After the lists are refreshed the run builds its plan again; when that plan
//  (its own selection included) has the same hash it goes ahead without a second stop, and when it differs (a machine or step added, something
//  refused or no longer refused) it stops for "Go ahead". What counts: which steps run on which machine and how (the upgrade verb, the chosen package names), what is
//  refused or approved, forced reboots, how items depend on each other, and the selection. Counts and versions that
//  moved while the lists refreshed do not.
// =============================================================================

import { createHash } from 'node:crypto'
import type { UpdatesPlan } from './types'

/**
 * A step's detail without what moves while the lists refresh: the "(N packages)" count, version strings, and a
 * snapshot's note about the newest backup. The upgrade verb (upgrade or dist-upgrade) stays, and so do the package
 * names of a chosen-packages step: a different verb or a different package is a different plan.
 */
export function normaliseDetail(action: string, detail: string | null | undefined): string {
  const d = detail ?? ''
  if (action === 'snapshot') return d.split(' — ')[0].split('.')[0].trim()
  const noCount = d.replace(/\(\d+ packages?\)/g, '(N)')
  if (action === 'node-packages' || action === 'apt-packages') return noCount
  return noCount.replace(/\d+(?:\.\d+)+[\w.+~:-]*/g, '#')
}

type Hashable = Pick<UpdatesPlan, 'steps'> & Partial<Pick<UpdatesPlan, 'refused' | 'approved' | 'forced' | 'items' | 'selection'>>

export function planHash(plan: Hashable): string {
  const body = {
    steps: plan.steps.map(s => `${s.target}|${s.action}|${normaliseDetail(s.action, s.detail)}`),
    refused: (plan.refused ?? []).map(r => r.id).sort(),
    approved: [...(plan.approved ?? [])].sort(),
    forced: [...(plan.forced ?? [])].sort((x, y) => x - y),
    items: (plan.items ?? []).map(i => `${i.id}|${[...i.dependsOn].sort().join(',')}`).sort(),
    selection: [...(plan.selection ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export const PLAN_HASH = /^[0-9a-f]{64}$/
export const PLAN_CHANGED = 'The plan changed since you confirmed it. Look it over, then press Go ahead.'
