// =============================================================================
//  HyperProx — which cluster a question or request is about
//
//  The cluster the person has open (the request's X-HyperProx-Cluster header or ?cluster=, resolved by
//  lib/clusters/context.ts) is the default. A request can name another one ("on Remote server", "the remote",
//  "the home cluster") or ask about all of them ("each cluster", "all my clusters"). Names are matched as whole
//  words against the registry, never guessed: a name that matches nothing, or "the remote" when there are
//  several, is answered with a question listing the real names. Pure: no I/O.
// =============================================================================

export interface ClusterRef { id: string; name: string; kind: 'home' | 'remote' }

export type Targets =
  | { kind: 'ok'; clusters: ClusterRef[]; /** The person named a cluster or "all", rather than relying on the open one. */ named: boolean; all: boolean }
  | { kind: 'ask'; message: string; choices: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9])${esc(name.trim())}($|[^A-Za-z0-9])`, 'i')

const ALL = /\b(all|each|every|both)\s+(of\s+)?(my\s+|the\s+|our\s+)?(clusters?|servers?)\b|\bacross\s+(my|all|the|our)\s+(clusters|servers)\b|\b(clusters|servers)\s+(each|both)\b/i
const REMOTE = /\b(the|my|our|that)\s+remote(\s+(server|cluster))?\b|\bremote\s+(server|cluster)\b|\b(on|in|at|to|for|from)\s+remote\b/i
const HOME = /\b(the|my|our)\s+home\s+(server|cluster)\b|\bhome\s+cluster\b|\b(on|in|at|to|for|from)\s+(the\s+)?home(\s+(one|server|cluster))?\s*([.?!,]|$)/i
// "on the Lab cluster": a name the person used, which must be a real one. Only "cluster": "the plex server" is
// far more often a guest than a cluster.
const ON_X = /\b(?:on|in|at|for|to|from)\s+(?:the\s+|my\s+|our\s+)?([A-Za-z0-9][\w.-]*)\s+cluster\b/i
const NOT_A_NAME = new Set(['this', 'that', 'my', 'the', 'other', 'same', 'home', 'remote', 'each', 'every', 'all', 'one', 'proxmox', 'pve',
  'a', 'new', 'which', 'what', 'any', 'our', 'your', 'second', 'first', 'both', 'whole', 'entire', 'dns', 'proxy', 'web', 'media', 'file', 'plex'])

/** Ask which of these, in plain words, offering each real name. */
function askWhich(intro: string, clusters: ClusterRef[]): Targets {
  return { kind: 'ask', message: `${intro} Your clusters are: ${clusters.map(c => c.name).join(', ')}. Which one did you mean?`, choices: clusters.map(c => c.name) }
}

/**
 * The clusters `text` is about. `current` is the cluster the request was made for. Home is always first in
 * `clusters` (listClusters() order), so "all" answers home first.
 */
export function resolveTargets(text: string, clusters: ClusterRef[], current: ClusterRef): Targets {
  const remotes = clusters.filter(c => c.kind === 'remote')
  if (ALL.test(text)) return { kind: 'ok', clusters: clusters.slice(), named: true, all: true }

  const named = new Map<string, ClusterRef>()
  // Longest names first, so "Remote server 2" is not also read as "Remote server".
  const byLength = clusters.slice().sort((a, b) => b.name.length - a.name.length)
  let rest = text
  for (const c of byLength) {
    if (!c.name.trim() || !word(c.name).test(rest)) continue
    named.set(c.id, c)
    rest = rest.replace(new RegExp(esc(c.name.trim()), 'ig'), ' ')
  }
  if (HOME.test(rest)) { const h = clusters.find(c => c.kind === 'home'); if (h) named.set(h.id, h) }
  if (REMOTE.test(rest) && ![...named.values()].some(c => c.kind === 'remote')) {
    if (!remotes.length) return { kind: 'ask', message: 'You have no remote cluster yet. Add one in the Command center first.', choices: [] }
    if (remotes.length > 1) return askWhich('You have more than one remote cluster.', remotes)
    named.set(remotes[0].id, remotes[0])
  }
  if (named.size) {
    const list = clusters.filter(c => named.has(c.id))
    return { kind: 'ok', clusters: list, named: true, all: false }
  }
  const x = ON_X.exec(rest)?.[1]
  if (x && !NOT_A_NAME.has(x.toLowerCase())) return askWhich(`I do not know a cluster called "${x}".`, clusters)
  return { kind: 'ok', clusters: [current], named: false, all: false }
}

/**
 * The question without the words that only said which cluster, so they do not steer which knowledge source is
 * read ("Remote server" must not read as a question about servers).
 */
export function withoutClusterWords(text: string, clusters: ClusterRef[]): string {
  let t = text
  for (const c of clusters.slice().sort((a, b) => b.name.length - a.name.length)) {
    if (c.name.trim()) t = t.replace(new RegExp(`\\b(on|in|at|for|to|from)?\\s*(the\\s+)?${esc(c.name.trim())}\\b`, 'ig'), ' ')
  }
  return t
    .replace(new RegExp(ALL.source, 'ig'), ' ')
    .replace(/\b(on|in|at|for|to|from)?\s*(the|my|our|that)\s+remote(\s+(server|cluster))?\b/ig, ' ')
    .replace(/\b(on|in|at|for|to|from)?\s*(the|my|our)\s+home\s+(server|cluster)\b/ig, ' ')
    .replace(/\b(on|in|at|for|to|from)\s+(remote|home)\b/ig, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** The plain line at the top of an answer that touches more than the home cluster. */
export function aboutLine(targets: ClusterRef[]): string {
  if (targets.length === 1) {
    const c = targets[0]
    return `Answering about ${c.name} (${c.kind === 'home' ? 'home cluster' : 'remote'}).`
  }
  return `Answering about ${targets.length} clusters: ${targets.map(c => c.name).join(', ')}.`
}
