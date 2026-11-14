// Deleting a vault item (Settings → Secrets): the confirm step and what each answer of
// POST /api/secrets/delete means. Kept free of CSS so it can be tested in Node.

/** The Delete button arms only when the item's name is typed exactly. */
export function deleteArmed(typed: string, name: string): boolean {
  return typed.trim() === name && name.length > 0
}

export type DeleteOutcome =
  | { kind: 'done'; message: string }
  | { kind: 'reconfirm' }
  | { kind: 'error'; message: string }

export function deleteOutcome(r: { ok: boolean; status: number; code?: string; error?: string }, name: string): DeleteOutcome {
  if (r.ok) return { kind: 'done', message: `${name} was moved to the vault's trash.` }
  if (r.status === 403 && (r.code === 'reconfirm_required' || /confirm/i.test(r.error ?? ''))) return { kind: 'reconfirm' }
  return { kind: 'error', message: r.error ?? 'Could not delete it' }
}
