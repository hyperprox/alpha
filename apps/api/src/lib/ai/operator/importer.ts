// =============================================================================
//  Importing a folder of markdown playbooks (and one house-rules document) into a handbook.
//
//  Safe to run twice: a playbook is matched by its file name, and an existing one is left alone unless `overwrite`.
//  Imported playbooks are the owner's own writing, so they arrive approved with source "seed". Pure apart from the
//  store it is given: reading the folder is the script's job (scripts/import-playbooks.ts).
// =============================================================================

import { parsePlaybookMarkdown, parseRulesMarkdown } from './playbook'
import { upsertByKey, type PlaybookStore } from './playbook-store'

export interface ImportFile { name: string; content: string }
export interface ImportReport {
  created: number; updated: number; skipped: number
  failed: Array<{ file: string; error: string }>
  rules: { imported: boolean; rules: number }
}

/** Files that are about the folder, not playbooks. */
const NOT_PLAYBOOKS = /^(readme|index)\.md$/i
const RULES_FILE = /^house-rules\.md$/i

export async function importPlaybooks(files: ImportFile[], store: PlaybookStore, o: { overwrite?: boolean; by?: string } = {}): Promise<ImportReport> {
  const rep: ImportReport = { created: 0, updated: 0, skipped: 0, failed: [], rules: { imported: false, rules: 0 } }
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/\.md$/i.test(f.name) || NOT_PLAYBOOKS.test(f.name)) continue
    if (RULES_FILE.test(f.name)) {
      const have = await store.getRules()
      if (have.updatedAt && !o.overwrite) { continue }
      const r = parseRulesMarkdown(f.content)
      await store.saveRules(r, o.by ?? 'import')
      rep.rules = { imported: true, rules: r.rules.length }
      continue
    }
    const parsed = parsePlaybookMarkdown(f.content, f.name)
    if (!parsed.ok) { rep.failed.push({ file: f.name, error: parsed.error }); continue }
    const out = await upsertByKey(store, { ...parsed.value, source: 'seed', approved: true }, { overwrite: !!o.overwrite })
    if (typeof out === 'string') rep[out]++
    else rep.failed.push({ file: f.name, error: out.error })
  }
  return rep
}
