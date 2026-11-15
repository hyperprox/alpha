// =============================================================================
//  HyperProx — which plug-in owns which compose project
//
//  Some compose projects have a careful update of their own on a plug-in's page:
//  Nextcloud's takes a database dump, turns maintenance mode on and moves one
//  major version at a time. A plain `docker compose pull && up -d` from the
//  Updates page would skip all of that. So a plug-in registers the (guest,
//  compose project) pairs it manages, and Updates leaves them to it: such a
//  project is shown as "Managed by the <page> — update it there", cannot be
//  chosen, and the runner refuses it again before it pulls anything.
//
//  An entry with neither a project name nor a directory covers every compose
//  project in that guest (the plug-in knows the guest but not yet which project
//  it is). When an owner's list cannot be read, nobody can tell whether a project
//  is managed, so every compose project is refused until it can (fail closed).
//
//  Home cluster only: the plug-ins manage guests of the home cluster.
// =============================================================================

export interface ManagedCompose {
  /** The plug-in that owns it, e.g. `nextcloud`. */
  owner:   string
  /** Where a person updates it, as it reads in a sentence: "the Nextcloud page". */
  page:    string
  vmid:    number
  /** The compose project name Docker reports; null with `dir` null: every project in the guest. */
  project: string | null
  /** The project's working directory, when known. */
  dir:     string | null
}

export interface ComposeOwnership {
  entries: ManagedCompose[]
  /** Owners whose list could not be read: nothing can be told apart, so every compose project is refused. */
  unknown: string[]
}

type Source = { page: string; list: () => Promise<Array<Omit<ManagedCompose, 'owner' | 'page'>>> }
const sources = new Map<string, Source>()
let last: ComposeOwnership = { entries: [], unknown: [] }

/** A plug-in's list of what it manages. Returns a function that takes it away again. */
export function registerComposeOwner(owner: string, page: string, list: Source['list']): () => void {
  const s: Source = { page, list }
  sources.set(owner, s)
  return () => { if (sources.get(owner) === s) sources.delete(owner) }
}

/** Read every owner's list now (and keep it, for the callers that cannot wait: lastComposeOwnership). */
export async function composeOwnership(): Promise<ComposeOwnership> {
  const out: ComposeOwnership = { entries: [], unknown: [] }
  await Promise.all([...sources.entries()].map(async ([owner, s]) => {
    try {
      for (const e of await s.list()) {
        if (!Number.isInteger(e.vmid)) continue
        out.entries.push({ owner, page: s.page, vmid: e.vmid, project: e.project || null, dir: e.dir || null })
      }
    } catch { out.unknown.push(s.page) }
  }))
  last = out
  return out
}

/** What was read last (empty before the first read). */
export function lastComposeOwnership(): ComposeOwnership { return last }

/**
 * Why Updates must not touch this compose project in this guest, in words, or null. `project` is what Updates knows of
 * it: its name (`docker compose ls`) and/or its directory.
 */
export function composeOwnerRefusal(o: ComposeOwnership, vmid: number, project: { name?: string | null; dir?: string | null }): string | null {
  if (o.unknown.length) return `HyperProx could not read which compose projects ${o.unknown.join(' and ')} manages, so none is updated here until it can`
  const strip = (d: string | null | undefined) => (d ? d.replace(/\/+$/, '') || '/' : null)
  const hit = o.entries.find(e => e.vmid === vmid && (
    (!e.project && !e.dir)
    || (!!e.project && !!project.name && e.project === project.name)
    || (!!e.dir && !!project.dir && strip(e.dir) === strip(project.dir))))
  return hit ? `Managed by ${hit.page} — update it there` : null
}

/** For tests. */
export function resetComposeOwners(): void { sources.clear(); last = { entries: [], unknown: [] } }
