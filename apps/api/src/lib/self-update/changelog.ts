// =============================================================================
//  HyperProx — self-update: what's new, from CHANGELOG.md
//
//  CHANGELOG.md keeps two registers in one file. Each top-level bullet is a
//  plain-English line for the person using HyperProx; anything indented under
//  it (a "Technical:" sub-bullet and its wrapped lines) is for GitHub readers.
//  This reads only the plain lines: the update page never shows the technical
//  notes, file names or commit messages.
//
//  Entries are dated ("## 2026-11-15 — Title"). An update's notes are the
//  entries in the OFFERED version's CHANGELOG.md dated on or after the day of
//  the first commit the install does not have yet (the day the install's own
//  commit was made, when that is not known). The day is inclusive on purpose:
//  an entry dated the day you installed may describe work that came after
//  your commit, and showing it once too often is better than never.
// =============================================================================

export type NoteKind = 'before' | 'new' | 'improved' | 'fixed' | 'other'

export interface ChangelogSection { kind: NoteKind; heading: string; items: string[] }
export interface ChangelogEntry {
  /** The anchor the website uses for this entry ("2026-11-15"). */
  id:       string
  date:     string
  version:  string | null
  title:    string
  sections: ChangelogSection[]
}

/** The notes an offered update carries. read: false when the offered CHANGELOG.md could not be read. */
export interface UpdateNotes { entries: ChangelogEntry[]; read: boolean; fromDay: string | null }

const MAX_BYTES = 512 * 1024
const MAX_ENTRIES = 20
const ENTRY = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+[·|]\s+(v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*))?\s*(?:[—–-]\s*(.*))?$/
const KINDS: Array<[RegExp, NoteKind]> = [[/^before you update/i, 'before'], [/^new\b/i, 'new'], [/^improved\b/i, 'improved'], [/^fixed\b/i, 'fixed']]
const ORDER: NoteKind[] = ['before', 'new', 'improved', 'fixed', 'other']

/** Markdown to plain words: emphasis, code marks, links and stray HTML removed. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every dated entry, newest first as written, with only the plain-English lines. */
export function parseChangelog(md: string): ChangelogEntry[] {
  const text = md.slice(0, MAX_BYTES).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '')
  const out: ChangelogEntry[] = []
  let entry: ChangelogEntry | null = null
  let section: ChangelogSection | null = null
  // inTech: inside an indented sub-bullet (a technical note); it ends at the next top-level line.
  let item: string | null = null, inTech = false
  const flush = () => {
    if (item !== null && section) { const t = plainText(item); if (t) section.items.push(t) }
    item = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      flush(); inTech = false; section = null
      const m = ENTRY.exec(line)
      entry = m ? { id: m[1] + (m[2] ? '-' + m[2].replace(/[^0-9A-Za-z.-]/g, '') : ''), date: m[1], version: m[2] ?? null, title: plainText(m[3] ?? ''), sections: [] } : null
      if (entry) out.push(entry)
      continue
    }
    if (!entry) continue
    if (/^###\s/.test(line)) {
      flush(); inTech = false
      const heading = plainText(line.replace(/^###\s+/, ''))
      section = { kind: KINDS.find(([re]) => re.test(heading))?.[1] ?? 'other', heading, items: [] }
      entry.sections.push(section)
      continue
    }
    if (!section) continue
    if (/^[-*]\s+/.test(line)) { flush(); inTech = false; item = line.replace(/^[-*]\s+/, ''); continue }
    if (!line.trim()) { flush(); inTech = false; continue }
    if (/^\s+/.test(line)) {
      // Indented: a sub-bullet starts a technical note; a plain wrapped line continues the item unless inside one.
      if (/^\s+([-*]|\d+\.)\s+/.test(line) || /^\s+<details/i.test(line)) inTech = true
      if (!inTech && item !== null) item += ' ' + line.trim()
      continue
    }
    // A top-level paragraph line inside a section: a plain line of its own.
    flush(); inTech = false; item = line
  }
  flush()
  for (const e of out) e.sections = e.sections.filter(s => s.items.length).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  return out
}

/** The day (YYYY-MM-DD) of an ISO date as it was written, so a commit's own day is not moved by time zones. */
export const dayOf = (iso: string | null | undefined): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null)

/** The entries an update brings: dated on or after fromDay, newest first. Nothing when fromDay is unknown. */
export function entriesSince(entries: ChangelogEntry[], fromDay: string | null): ChangelogEntry[] {
  if (!fromDay) return []
  return entries.filter(e => e.date >= fromDay).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, MAX_ENTRIES)
}

/** Notes for an update, from the offered version's CHANGELOG.md (null: it could not be read). */
export function notesFor(offered: string | null, fromDay: string | null): UpdateNotes {
  if (offered === null) return { entries: [], read: false, fromDay }
  return { entries: entriesSince(parseChangelog(offered), fromDay), read: true, fromDay }
}

/** A one-line summary for a notification or a tooltip: the entry titles, and whether there is something to read first. */
export function notesSummary(n: UpdateNotes | null | undefined): { count: number; before: boolean; titles: string[] } {
  const entries = n?.entries ?? []
  return { count: entries.length, before: entries.some(e => e.sections.some(s => s.kind === 'before')), titles: entries.map(e => e.title || e.date).slice(0, 5) }
}
