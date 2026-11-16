// The areas an assistant answer was read from, shown under it behind a small "Sources used" disclosure. The answer
// itself no longer starts with an "Attached: ..." line: that index is for the model's prompt, not for the person.
// Kept free of CSS so it can be tested in Node.

/** The names to show, each once, in the order they were read; null when there is nothing to show. */
export function sourcesUsed(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null
  const out: string[] = []
  for (const x of list) {
    const s = typeof x === 'string' ? x.trim() : ''
    if (s && !out.includes(s)) out.push(s)
  }
  return out.length ? out : null
}

export const SOURCES_LABEL = 'Sources used'
