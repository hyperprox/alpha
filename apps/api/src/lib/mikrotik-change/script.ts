// =============================================================================
//  HyperProx — MikroTik change engine: the router's own undo, as a RouterOS script
//
//  Before a change is made, HyperProx puts a scheduler entry on the router that runs a script 90 seconds later. The
//  script holds the inverse commands. When the change is verified HyperProx removes both. When HyperProx cannot reach
//  the router any more, nothing removes them, and the router puts itself back.
//
//  Every value is written as a quoted string with the characters RouterOS would otherwise interpret (the quote, the
//  backslash, $, ?, [ and ]) and everything that is not printable ASCII written as hex escapes (\XX per UTF-8 byte),
//  so a comment such as `a "b" $c [d]` can never become a command.
// =============================================================================

import type { Op, Where } from './types'

const SPECIAL = new Set(['"', '\\', '$', '?', '[', ']'])

/** A string as a RouterOS double-quoted literal. */
export function quote(v: string): string {
  let out = ''
  for (const b of Buffer.from(String(v), 'utf8')) {
    const ch = String.fromCharCode(b)
    if (b >= 0x20 && b <= 0x7e && !SPECIAL.has(ch)) out += ch
    else out += `\\${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `"${out}"`
}

const PROP = /^[a-z][a-z0-9.-]*$/i

function prop(k: string): string {
  if (!PROP.test(k)) throw new Error(`Not a property name: ${k}`)
  return k
}

/** RouterOS' own spelling for the values REST says as "true" and "false". */
function value(k: string, v: string): string {
  if (k === 'disabled' || k === 'invalid' || k === 'dynamic') return v === 'true' ? 'yes' : v === 'false' ? 'no' : v
  return v
}

const pairs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${prop(k)}=${quote(value(k, v))}`).join(' ')

export function findExpr(where: Where): string {
  const w = pairs(where)
  return w ? `[find where ${w}]` : '[find]'
}

/** `/ip/firewall/nat/remove [find where comment="..."]` and so on. */
export function opCommand(op: Op): string {
  const path = op.path.replace(/\/+$/, '')
  if (!/^(\/[a-z][a-z0-9-]*)+$/.test(path)) throw new Error(`Not a menu path: ${path}`)
  switch (op.kind) {
    case 'add': return `${path}/add ${pairs(op.props)}`
    case 'set': return `${path}/set ${findExpr(op.where)} ${pairs(op.props)}`
    case 'remove': return `${path}/remove ${findExpr(op.where)}`
    case 'command': return `${path} ${findExpr(op.where)}`
  }
}

/** The name HyperProx gives the scheduler entry and the script. `id` is hex. */
export function deadManName(id: string): string {
  if (!/^[0-9a-f]{6,16}$/.test(id)) throw new Error('Not a change id.')
  return `hyperprox-undo-${id}`
}

export const deadManComment = (id: string) => `HyperProx auto-undo ${id}`

/**
 * The script that puts a change back. Every command is wrapped so one failing never stops the next, and the last two
 * lines remove the scheduler entry and the script itself, so it runs once.
 */
export function deadManScript(id: string, inverse: Op[]): string {
  const name = deadManName(id)
  const lines = [
    `# ${deadManComment(id)}`,
    `:log warning "HyperProx: change ${id} was not confirmed in time, putting it back"`,
    ...inverse.map(op => `:do { ${opCommand(op)} } on-error={ :log error "HyperProx: one undo command for change ${id} failed" }`),
    `:do { /system/scheduler/remove [find where name=${quote(name)}] } on-error={}`,
    `:do { /system/script/remove [find where name=${quote(name)}] } on-error={}`,
  ]
  return lines.join('\n') + '\n'
}

/** The scheduler entry: runs the script `delaySeconds` after the clock reading it was built from. */
export function deadManScheduler(id: string, clock: { date?: string; time?: string }, delaySeconds = 90): Record<string, string> {
  const name = deadManName(id)
  const base: Record<string, string> = {
    name, comment: deadManComment(id), 'on-event': `/system/script/run ${name}`,
    interval: secondsText(delaySeconds), policy: 'read,write,test',
  }
  // Start now: the first run is one interval later, and the script removes the entry, so it never runs twice.
  // Without the router's clock there is no safe start time, so there is no scheduler entry and no change.
  if (!clock.time) throw new Error('The router did not say what time it is.')
  if (clock.date) base['start-date'] = clock.date
  base['start-time'] = clock.time
  return base
}

export function secondsText(n: number): string {
  const s = Math.max(1, Math.floor(n))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}
