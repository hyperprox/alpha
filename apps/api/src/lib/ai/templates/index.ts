// =============================================================================
//  HyperProx — the task template registry
// =============================================================================

import type { TaskTemplate } from './types'
import { deployService } from './deploy-service'

export const TEMPLATES: Readonly<Record<string, TaskTemplate>> = Object.freeze({
  [deployService.id]: deployService,
})

/** Own keys only, so "toString" or "__proto__" is never a template. */
export function getTemplate(id: string): TaskTemplate | undefined {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id) ? TEMPLATES[id] : undefined
}
