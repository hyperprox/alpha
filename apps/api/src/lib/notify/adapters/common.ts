// Shared bits for the per-kind adapters: colours, text, limits.
import { fitLines, linkLine, mapPlain, severityPrefix, unmarkPlain } from '../render'
import type { NotifyMessage } from '../types'

export const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** critical red, warning amber, info blue, resolved green. */
export function colour(m: NotifyMessage): number {
  if (m.resolved) return 0x30A46C
  return m.severity === 'critical' ? 0xE5484D : m.severity === 'warning' ? 0xF5A524 : 0x3B82F6
}
export const hex = (n: number) => `#${n.toString(16).toUpperCase().padStart(6, '0')}`

export const titleOf = (m: NotifyMessage) => (m.resolved ? `Resolved: ${m.title}` : m.title)

/** Lines plus the link line, cut to whole lines within `limit` characters. */
export function bodyText(m: NotifyMessage, limit: number): string {
  const tail = linkLine(m)
  return [...fitLines(m.lines, Math.max(0, limit - tail.length - 1)), tail].join('\n')
}

/** Title (with the severity word), lines and link as plain text. */
export function plainText(m: NotifyMessage, limit: number): string {
  const head = `${severityPrefix(m)}${m.title}`
  return `${head}\n${bodyText(m, limit - head.length - 1)}`
}

/** Markdown escaped and links broken, so a value shows as typed and cannot be clicked. */
export function plainMarkdown(v: string): string {
  return v
    .replace(/[\\`*_~|<>\[\]()#+\-=!{}.]/g, c => `\\${c}`)
    .replace(/:\\?\/\\?\//g, '[:]//')
    .replace(/\bwww\\?\./gi, 'www[.]')
}

/** For a markdown channel: every marked outside value made plain; marks removed. */
export function withPlainValues(m: NotifyMessage): NotifyMessage {
  return { ...m, title: mapPlain(m.title, plainMarkdown), lines: m.lines.map(l => mapPlain(l, plainMarkdown)) }
}

/** For every other channel: the marks removed, the text as it was. */
export function withoutMarks(m: NotifyMessage): NotifyMessage {
  return { ...m, title: unmarkPlain(m.title), lines: m.lines.map(unmarkPlain) }
}
