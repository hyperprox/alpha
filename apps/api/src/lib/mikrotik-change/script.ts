// =============================================================================
//  HyperProx — MikroTik change engine: the router's own undo, as a RouterOS script
//
//  Before a change is made, HyperProx puts a scheduler entry on the router that runs a script 90 seconds later. The
//  script holds the inverse commands. When the change is verified HyperProx removes both. When HyperProx cannot reach
//  the router any more, nothing removes them, and the router puts itself back.
//
//  Text is written as a quoted string with the characters RouterOS would otherwise interpret (the quote, the
//  backslash, $, ?, [ and ]) and everything that is not printable ASCII written as hex escapes (\XX per UTF-8 byte),
//  so a comment such as `a "b" $c [d]` can never become a command. Booleans and plain addresses are written bare, the
//  way RouterOS types them. A row that is edited is selected by the id it had when the switch was armed, a row that was
//  added by the comment HyperProx gave it.
// =============================================================================

import { guardOf } from './rows'
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

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const ROW_ID = /^\*[0-9A-Z]+$/i

/**
 * One value as RouterOS wants it written. Typed values (booleans, plain IPv4 addresses) are written bare: a quoted
 * "yes" or "10.0.0.5" is a string, and a string never compares equal to a boolean or an address in `find`. Everything
 * else is a quoted literal. A comment is always text, whatever it says.
 */
export function valueText(k: string, v: string): string {
  if (k !== 'comment') {
    if (v === 'true' || v === 'yes') return 'yes'
    if (v === 'false' || v === 'no') return 'no'
    if (IPV4.test(v) && v.split('.').every(x => Number(x) <= 255)) return v
  }
  return quote(v)
}

const pairs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${prop(k)}=${valueText(k, v)}`).join(' ')

export function findExpr(where: Where): string {
  const w = pairs(where)
  return w ? `[find where ${w}]` : '[find]'
}

/** The row ids, written the way RouterOS reads them (`*1A`), after checking they are only that. */
function idList(ids: string[]): string[] {
  for (const id of ids) if (!ROW_ID.test(id)) throw new Error(`Not a row id: ${id}`)
  return ids
}

const menu = (op: Op): string => {
  const path = op.path.replace(/\/+$/, '')
  if (!/^(\/[a-z][a-z0-9-]*)+$/.test(path)) throw new Error(`Not a menu path: ${path}`)
  return path
}

/** What the router runs for one operation: one command, or several (a `set` that clears a property also needs `unset`). */
export function opCommands(op: Op): string[] {
  const path = menu(op)
  switch (op.kind) {
    case 'add': return [`${path}/add ${op.top && path.startsWith('/ip/firewall/') ? 'place-before=0 ' : ''}${pairs(op.props)}`]
    case 'remove': return [`${path}/remove ${findExpr(op.where)}`]
    case 'command': return [`${path} ${findExpr(op.where)}`]
    case 'set': {
      const targets = op.ids?.length ? idList(op.ids) : [findExpr(op.where)]
      // A property set to nothing is cleared with `unset` (a `time` of "" is not a time); a comment is set to "".
      const set = Object.fromEntries(Object.entries(op.props).filter(([k, v]) => v !== '' || k === 'comment'))
      const clear = Object.entries(op.props).filter(([k, v]) => v === '' && k !== 'comment').map(([k]) => prop(k))
      return targets.flatMap(t => [
        ...(Object.keys(set).length ? [`${path}/set ${t} ${pairs(set)}`] : []),
        ...(clear.length ? [`${path}/unset ${t} ${clear.join(',')}`] : []),
      ])
    }
  }
}

/** `/ip/firewall/nat/remove [find where comment="..."]` and so on, as one line. */
export function opCommand(op: Op): string { return opCommands(op).join('; ') }

/**
 * An inverse operation as it goes into the router's script. A row that is put back is only added when it is not there
 * already, so the script and HyperProx's own rollback can both run without making it twice.
 */
function scriptLines(op: Op, id: string): string[] {
  const fail = `on-error={ :log error "HyperProx: one undo command for change ${id} failed" }`
  const cmds = opCommands(op)
  if (op.kind === 'add') {
    const path = menu(op)
    return cmds.map(c => `:do { :if ([:len [${path}/find where ${pairs(guardOf(op.props))}]] = 0) do={ ${c} } } ${fail}`)
  }
  return cmds.map(c => `:do { ${c} } ${fail}`)
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
    ...inverse.flatMap(op => scriptLines(op, id)),
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
