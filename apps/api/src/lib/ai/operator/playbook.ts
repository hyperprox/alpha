// =============================================================================
//  The handbook's playbooks: shape, validation and the markdown format they are imported from.
//
//  A playbook is a written-down fix: what it looks like (symptoms), what to read (checks), why it happens (cause),
//  what to do (fix), what not to do (safety) and a situation to test it against. The operator looks them up by
//  keyword; nothing here trains a model. Pure: no database, no network.
//
//  Markdown format (what the importer reads and the export writes):
//
//    ---
//    title: Short name of the problem
//    tags: [one, two]            (a list, or a comma separated line)
//    symptoms:                    (a list of what a person would notice)
//      - first thing
//    severity: low | medium | high
//    area: any short word (the plug-in or part of the system)
//    ---
//    ## Checks
//    ## Cause
//    ## Fix
//    ## Safety
//    ## Test scenario
// =============================================================================

// js-yaml ships no types; only load() and dump() are used (as in lib/certs/policy.ts).
const yaml = require('js-yaml') as { load(src: string): unknown; dump(v: unknown, o?: Record<string, unknown>): string }

export const SEVERITIES = ['low', 'medium', 'high'] as const
export type Severity = typeof SEVERITIES[number]
export const SOURCES = ['seed', 'cloud-draft', 'user'] as const
export type PlaybookSource = typeof SOURCES[number]

export interface Playbook {
  id: string
  /** A stable short name (a slug of the title or the file), so an import can update what it made earlier. */
  key: string
  title: string
  tags: string[]
  symptoms: string[]
  severity: Severity
  area: string
  checks: string
  cause: string
  fix: string
  safety: string
  testScenario: string
  source: PlaybookSource
  /** Only approved playbooks are given to the operator. A draft waits here for a person. */
  approved: boolean
  createdAt: Date
  updatedAt: Date
}

/** What a person (or the importer, or a cloud draft) supplies. */
export type PlaybookInput = Partial<Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>>

export const LIMITS = { title: 160, tag: 40, tags: 20, symptom: 240, symptoms: 20, area: 40, section: 8000, key: 80 } as const

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '')
const list = (v: unknown, each: number, n: number): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []
  // YAML reads "- state: error" as a little table; it was meant as a sentence.
  const flat = (x: unknown): unknown => (typeof x === 'number' ? String(x) : x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(x).map(([k, v]) => `${k}: ${v}`).join(', ') : x)
  return [...new Set(raw.map(x => text(flat(x), each)).filter(Boolean))].slice(0, n)
}

export function slugOf(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.key)
}

/** A complete, valid playbook body from anything submitted. Unknown keys are dropped. A title is the one thing it must have. */
export function normalizePlaybook(input: unknown): { ok: true; value: Required<PlaybookInput> } | { ok: false; error: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const title = text(i.title, LIMITS.title)
  if (!title) return { ok: false, error: 'A playbook needs a title.' }
  const severity = SEVERITIES.includes(i.severity as Severity) ? (i.severity as Severity) : 'medium'
  const source = SOURCES.includes(i.source as PlaybookSource) ? (i.source as PlaybookSource) : 'user'
  const key = slugOf(typeof i.key === 'string' && i.key ? i.key : title)
  return {
    ok: true,
    value: {
      key, title, severity, source,
      tags: list(i.tags, LIMITS.tag, LIMITS.tags),
      symptoms: list(i.symptoms, LIMITS.symptom, LIMITS.symptoms),
      area: text(i.area, LIMITS.area),
      checks: text(i.checks, LIMITS.section), cause: text(i.cause, LIMITS.section), fix: text(i.fix, LIMITS.section),
      safety: text(i.safety, LIMITS.section), testScenario: text(i.testScenario, LIMITS.section),
      approved: i.approved === true,
    },
  }
}

const SECTION_NAMES: Record<string, 'checks' | 'cause' | 'fix' | 'safety' | 'testScenario'> = {
  checks: 'checks', cause: 'cause', fix: 'fix', safety: 'safety', 'test scenario': 'testScenario',
}

/**
 * A forgiving reader for the few shapes a playbook's frontmatter uses: `key: value`, `key: [a, b]` and `key:` followed by
 * `- item` lines, each item taken as written. Null when nothing in it looks like a key.
 */
export function looseFrontmatter(src: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  let list: string[] | null = null
  for (const raw of src.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && list) { list.push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2')); continue }
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(raw)
    if (!kv) { if (raw.trim()) list = null; continue }
    const v = kv[2].trim()
    if (v === '') { list = []; out[kv[1]] = list; continue }
    list = null
    const arr = /^\[(.*)\]$/.exec(v)
    out[kv[1]] = arr ? arr[1].split(',').map(x => x.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean) : v.replace(/^(['"])(.*)\1$/, '$2')
  }
  return Object.keys(out).length ? out : null
}

/** Reads one markdown playbook. `name` (a file name) gives the key when the title has none. Never throws. */
export function parsePlaybookMarkdown(md: string, name = ''): { ok: true; value: Required<PlaybookInput> } | { ok: false; error: string } {
  const src = String(md ?? '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src)
  if (!m) return { ok: false, error: 'No frontmatter: the file must start with --- and list title, tags, symptoms, severity and area.' }
  let meta: Record<string, unknown>
  try {
    const y = yaml.load(m[1])
    if (!y || typeof y !== 'object' || Array.isArray(y)) throw new Error('not a mapping')
    meta = y as Record<string, unknown>
  } catch (e) {
    // Hand-written files often have a colon or a quote in a symptom, which strict YAML refuses: read them line by line.
    const loose = looseFrontmatter(m[1])
    if (!loose) return { ok: false, error: `The frontmatter could not be read (${e instanceof Error ? e.message.split('\n')[0] : 'invalid'}).` }
    meta = loose
  }
  const sections: Record<string, string[]> = {}
  let cur: string | null = null
  for (const line of m[2].split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) { cur = SECTION_NAMES[h[1].toLowerCase()] ?? null; if (cur) sections[cur] = []; continue }
    if (cur) sections[cur].push(line)
  }
  const body = (k: string) => (sections[k] ?? []).join('\n').trim()
  return normalizePlaybook({
    key: name ? slugOf(name) : undefined,
    title: meta.title, tags: meta.tags, symptoms: meta.symptoms, severity: meta.severity, area: meta.area,
    checks: body('checks'), cause: body('cause'), fix: body('fix'), safety: body('safety'), testScenario: body('testScenario'),
  })
}

/** The same format written back out, so a handbook can be exported and re-imported. */
export function playbookToMarkdown(p: Pick<Playbook, 'title' | 'tags' | 'symptoms' | 'severity' | 'area' | 'checks' | 'cause' | 'fix' | 'safety' | 'testScenario'>): string {
  const fm = yaml.dump({ title: p.title, tags: p.tags, symptoms: p.symptoms, severity: p.severity, area: p.area }, { lineWidth: 120, flowLevel: 1 }).trimEnd()
  const sec = (h: string, v: string) => `## ${h}\n${v || ''}\n`
  return `---\n${fm}\n---\n\n${sec('Checks', p.checks)}\n${sec('Cause', p.cause)}\n${sec('Fix', p.fix)}\n${sec('Safety', p.safety)}\n${sec('Test scenario', p.testScenario)}`
}

// ── House rules ─────────────────────────────────────────────────────────────

export interface HouseRules { text: string; rules: string[]; updatedAt: Date | null; updatedBy: string }
export const RULE_LIMITS = { text: 20_000, rule: 1200, rules: 300 } as const

export function normalizeRules(input: unknown): { text: string; rules: string[] } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const rules = (Array.isArray(i.rules) ? i.rules : [])
    .map(r => (typeof r === 'string' ? r.replace(/\s+/g, ' ').trim().slice(0, RULE_LIMITS.rule) : '')).filter(Boolean).slice(0, RULE_LIMITS.rules)
  return { text: text(i.text, RULE_LIMITS.text), rules }
}

/**
 * A markdown rules document into the two parts the handbook keeps: the free text (the title and any plain paragraphs)
 * and the rules (each top-level bullet, with its indented sub-bullets joined on so it reads whole). A rule under a
 * `##` heading starts with that heading ("Downloads: ..."), so it still says what it is about on its own.
 */
export function parseRulesMarkdown(md: string): { text: string; rules: string[] } {
  const prose: string[] = []
  const rules: string[] = []
  let inRule = false
  let heading = ''
  for (const raw of String(md ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const top = /^[-*]\s+(.*)$/.exec(raw)
    const sub = /^\s+[-*]\s+(.*)$/.exec(raw)
    const h = /^##\s+(.+?)\s*$/.exec(raw)
    if (h) { heading = h[1].replace(/\s*\([^)]*\)\s*$/, '').trim(); inRule = false; continue }
    if (top) { rules.push(`${heading ? `${heading}: ` : ''}${top[1].trim()}`); inRule = true }
    else if (sub && inRule) rules[rules.length - 1] += ` ${sub[1].trim()}`
    else if (inRule && /^\s+\S/.test(raw)) rules[rules.length - 1] += ` ${raw.trim()}`
    else { if (raw.trim()) inRule = false; prose.push(raw) }
  }
  return normalizeRules({ text: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(), rules })
}
