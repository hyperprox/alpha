// =============================================================================
//  HyperProx — Updates: what a plan is, for "the plan you confirmed is the plan that runs"
//
//  Update now (the simple page) asks for the plan (/preview), shows it in one confirmation and starts the run with
//  this hash bound to that confirmation. After the lists are refreshed the run builds its plan again; when that plan
//  has the same hash it goes ahead without a second stop, and when it differs (a machine or step added, something
//  refused or no longer refused) it stops for "Go ahead". Only what a person would call the plan counts: which steps
//  run on which machine, what is refused and what was approved. Package names and versions that moved while the
//  lists refreshed do not.
// =============================================================================

import { createHash } from 'node:crypto'
import type { UpdatesPlan } from './types'

export function planHash(plan: Pick<UpdatesPlan, 'steps' | 'refused' | 'approved'>): string {
  const body = {
    steps: plan.steps.map(s => `${s.target}|${s.action}`),
    refused: (plan.refused ?? []).map(r => r.id).sort(),
    approved: [...(plan.approved ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export const PLAN_HASH = /^[0-9a-f]{64}$/
export const PLAN_CHANGED = 'The plan changed since you confirmed it. Look it over, then press Go ahead.'
