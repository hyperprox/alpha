// The Handbook page's words and rules, kept apart from the markup so they can be tested.

export type Severity = 'low' | 'medium' | 'high'
export type Source = 'seed' | 'cloud-draft' | 'user'

export interface Playbook {
  id: string; key: string; title: string; tags: string[]; symptoms: string[]; severity: Severity; area: string
  checks: string; cause: string; fix: string; safety: string; testScenario: string
  source: Source; approved: boolean; createdAt: string; updatedAt: string
}
export interface HouseRules { text: string; rules: string[]; updatedAt: string | null; updatedBy: string }

export type Draft = Pick<Playbook, 'title' | 'area' | 'severity' | 'checks' | 'cause' | 'fix' | 'safety' | 'testScenario'> & { tags: string; symptoms: string; approved: boolean }

export const SECTIONS: Array<{ key: 'checks' | 'cause' | 'fix' | 'safety' | 'testScenario'; label: string; hint: string }> = [
  { key: 'checks', label: 'Checks', hint: 'What to read first. Read-only steps.' },
  { key: 'cause', label: 'Cause', hint: 'Why it happens.' },
  { key: 'fix', label: 'Fix', hint: 'What to do, in order.' },
  { key: 'safety', label: 'Safety', hint: 'What not to do, and what needs your OK.' },
  { key: 'testScenario', label: 'Test scenario', hint: 'A situation, and the conclusion a correct answer reaches.' },
]

export const sourceWord = (s: Source): string => (s === 'seed' ? 'Imported' : s === 'cloud-draft' ? 'Drafted by a cloud model' : 'Written by a person')
export const statusWord = (p: Pick<Playbook, 'approved'>): string => (p.approved ? 'Approved' : 'Waiting for approval')
export const severityWord = (s: Severity): string => (s === 'high' ? 'High' : s === 'low' ? 'Low' : 'Medium')

/** One per line or comma separated, as the tags and symptoms boxes take them. */
export const parseList = (text: string, sep: RegExp = /[\n,]+/): string[] => [...new Set(text.split(sep).map(t => t.trim()).filter(Boolean))]

export const emptyDraft = (): Draft => ({ title: '', tags: '', symptoms: '', severity: 'medium', area: '', checks: '', cause: '', fix: '', safety: '', testScenario: '', approved: false })

export const draftOf = (p: Playbook): Draft => ({
  title: p.title, tags: p.tags.join(', '), symptoms: p.symptoms.join('\n'), severity: p.severity, area: p.area,
  checks: p.checks, cause: p.cause, fix: p.fix, safety: p.safety, testScenario: p.testScenario, approved: p.approved,
})

/** The request body for a draft. Symptoms are one per line (they are sentences); tags may be commas or lines. */
export const bodyOf = (d: Draft) => ({ ...d, tags: parseList(d.tags), symptoms: parseList(d.symptoms, /\n+/) })

export type Filter = 'all' | 'waiting' | 'approved'

/** Search by words in the title, tags, symptoms or area; the status filter first. Waiting ones sort to the top. */
export function filterPlaybooks(list: Playbook[], o: { q: string; status: Filter }): Playbook[] {
  const words = o.q.toLowerCase().split(/\s+/).filter(Boolean)
  return list
    .filter(p => (o.status === 'all' ? true : o.status === 'waiting' ? !p.approved : p.approved))
    .filter(p => {
      const hay = [p.title, p.area, ...p.tags, ...p.symptoms].join(' ').toLowerCase()
      return words.every(w => hay.includes(w))
    })
    .sort((a, b) => Number(a.approved) - Number(b.approved) || a.area.localeCompare(b.area) || a.title.localeCompare(b.title))
}

export const countLine = (list: Playbook[]): string => {
  const waiting = list.filter(p => !p.approved).length
  return `${list.length} ${list.length === 1 ? 'playbook' : 'playbooks'}${waiting ? `, ${waiting} waiting for approval` : ''}.`
}

/** The rules box: one rule per line. */
export const rulesText = (rules: string[]): string => rules.join('\n')
export const parseRules = (text: string): string[] => text.split('\n').map(r => r.trim()).filter(Boolean)
