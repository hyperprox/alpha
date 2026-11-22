// Row helpers shared by the engine, the lockout guard and the plan builders. Pure.

import { createHash } from 'node:crypto'
import type { Row, Where } from './types'

const isMacKey = (k: string) => k.includes('mac')

/** Every key in `where` equals the row's value (MAC addresses without regard to case). */
export function matchRow(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const a = String(row[k] ?? ''), b = String(v)
    return isMacKey(k) ? a.toUpperCase() === b.toUpperCase() : a === b
  })
}

export const arr = (v: unknown): Row[] => Array.isArray(v) ? v as Row[] : []
export const isTrue = (v: unknown) => v === 'true' || v === 'yes'

/** A fixed set of properties of a row, for an `add` that puts the row back: nothing the router fills in itself. */
const COMPUTED = new Set(['.id', '.nextid', 'dynamic', 'invalid', 'status', 'active', 'last-seen', 'expires-after', 'bytes', 'packets', 'host-name',
  'active-address', 'active-mac-address', 'active-client-id', 'active-server', 'radius', 'blocked', 'age', 'class-id', 'client-id-hint'])
export function settable(row: Row): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) {
    if (COMPUTED.has(k) || v === undefined || v === null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * The properties that say whether an added row is already there. A row that is put back must not be added twice when
 * the first attempt had in fact landed: by address + MAC when it has both (a lease), else by its comment tag, else by
 * everything it says.
 */
export function guardOf(props: Record<string, string>): Where {
  if (props['mac-address'] && props.address) return { address: props.address, 'mac-address': props['mac-address'] }
  if (props.comment) return { comment: props.comment }
  return { ...props }
}

/** A short, steady tag from the parameters, so the same request always makes the same comment. */
export function tagOf(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 6)
}
