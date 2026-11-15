// =============================================================================
//  HyperProx — placement advisor: what the heartbeat did around a move
//
//  The Proxmox API has no record of corosync retransmits or link flaps; only a
//  node's journal does. With a node login HyperProx reads the corosync unit's
//  journal for the move's window (and an equal stretch just before, as the
//  baseline) and counts what matters. Without one it says so: it never
//  reports "no problems" for something it could not look at.
// =============================================================================

import type { CorosyncCount } from './types'

const PATTERNS = {
  retransmits: /retransmit/i,
  linkDown:    /link:\s*\S+.*\b(is )?down\b|host:\s*\S+\s+has no active links|link .* down/i,
  tokenLost:   /token has not been received|token lost/i,
  membership:  /a (new|processor joined or left the) membership/i,
}

export function countJournal(text: string): Omit<CorosyncCount, 'checked' | 'before' | 'unavailable'> {
  const out = { retransmits: 0, linkDown: 0, tokenLost: 0, membership: 0 }
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    for (const k of Object.keys(PATTERNS) as Array<keyof typeof PATTERNS>) if (PATTERNS[k].test(line)) out[k]++
  }
  return out
}

/** The journal read, as one fixed command: times are integers, nothing from a request reaches the shell. */
export function journalCommand(fromSec: number, toSec: number): string {
  const a = Math.floor(Number(fromSec)), b = Math.floor(Number(toSec))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= a) throw new Error('bad window')
  return `journalctl -u corosync --since @${a} --until @${b} --no-pager -o cat 2>/dev/null | tail -n 5000`
}

export interface CorosyncDeps {
  /** Runs a read-only command on a node over its stored login; null when there is no login for it. */
  exec(node: string, command: string): Promise<{ code: number; output: string } | null>
}

/** Counts on the move's two nodes, for [start - pad, end + pad], and the same length before it. */
export async function corosyncAround(d: CorosyncDeps, nodes: string[], startSec: number, endSec: number, padSec = 300): Promise<CorosyncCount> {
  const from = startSec - padSec, to = Math.max(endSec, startSec + 1) + padSec
  const len = to - from
  const sum = { retransmits: 0, linkDown: 0, tokenLost: 0, membership: 0 }
  const before = { retransmits: 0, linkDown: 0, tokenLost: 0, membership: 0 }
  const checked: string[] = [], missing: string[] = []
  for (const n of Array.from(new Set(nodes))) {
    const run = async (a: number, b: number) => { try { return await d.exec(n, journalCommand(a, b)) } catch { return null } }
    const r = await run(from, to)
    if (!r || r.code !== 0) { missing.push(n); continue }
    const b = await run(from - len, from)
    checked.push(n)
    const c = countJournal(r.output)
    for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += c[k]
    if (b && b.code === 0) { const cb = countJournal(b.output); for (const k of Object.keys(before) as Array<keyof typeof before>) before[k] += cb[k] }
  }
  if (!checked.length) return { checked, ...sum, unavailable: `Corosync's log is only on the nodes, and HyperProx has no working login for ${missing.join(' or ')}. Add a node login in Settings → Setup checklist to see it.` }
  return { checked, ...sum, before, ...(missing.length ? { unavailable: `Not read on ${missing.join(', ')} (no working node login).` } : {}) }
}

/** One line for the guest card: "the last time this moved, …". */
export function corosyncWords(c: CorosyncCount | null | undefined): string {
  if (!c) return 'Corosync around this move has not been checked.'
  if (!c.checked.length) return c.unavailable ?? 'Corosync around this move could not be read.'
  const parts: string[] = []
  if (c.retransmits) parts.push(`${c.retransmits} retransmit${c.retransmits === 1 ? '' : 's'}`)
  if (c.linkDown) parts.push(`the heartbeat link went down ${c.linkDown} time${c.linkDown === 1 ? '' : 's'}`)
  if (c.tokenLost) parts.push(`${c.tokenLost} lost token${c.tokenLost === 1 ? '' : 's'}`)
  if (c.membership) parts.push(`${c.membership} membership change${c.membership === 1 ? '' : 's'}`)
  const base = c.before ? c.before.retransmits + c.before.linkDown + c.before.tokenLost : null
  const where = `on ${c.checked.join(' and ')}`
  if (!parts.length) return `Corosync stayed quiet ${where}.`
  return `Corosync ${where}: ${parts.join(', ')}${base !== null ? ` (${base} such events in the same time just before)` : ''}.`
}
