// =============================================================================
//  HyperProx — searching the Catalogue
//
//  People look for what an app does, not what it is called: "google photos", "chatgpt", "smart home". Each recipe carries
//  those words (keywords); the search reads them with the name, the category and the summary. Every word typed must appear
//  somewhere (so "photo backup" finds Immich), case and punctuation do not matter, and an empty search shows everything.
// =============================================================================

export interface Searchable { id: string; name: string; summary: string; category: string; categoryLabel?: string; keywords?: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function matchesSearch(r: Searchable, query: string): boolean {
  const words = norm(query).split(' ').filter(Boolean)
  if (!words.length) return true
  const hay = ` ${norm([r.id, r.name, r.categoryLabel ?? r.category, r.summary, ...(r.keywords ?? [])].join(' '))} `
  return words.every(w => hay.includes(w))
}
