// =============================================================================
//  HyperProx — Homepage: the shapes shared by the generator, the service and the routes
// =============================================================================

import type { GroupName } from './catalog'

export interface GuestRef { vmid: number; name: string; node: string; type: 'lxc' | 'qemu' }

/** A guest as the inventory sees it. `machineId` is Remote access's id (lxc-101), used by its exclusion list. */
export interface InvGuest extends GuestRef {
  status: string
  tags: string[]
  addresses: string[]
  machineId: string
}

/** One service HyperProx knows runs somewhere: found by a probe, a Catalogue install, a plug-in's settings. */
export interface InvService {
  /** A key from lib/homepage/catalog.ts (plex, sonarr...) or a recipe id it maps from. */
  key: string
  /** A name when the key alone does not say which (a second Unmanic worker, a plug-in's own label). */
  label?: string
  /** The address on the LAN: scheme://host:port. */
  url: string
  /** The public address when one is already known (a proxy host matched to it by the Catalogue). */
  publicUrl?: string | null
  guest?: GuestRef | null
  source: 'scan' | 'catalogue' | 'install' | 'plugin' | 'self' | 'cluster'
}

export interface InvProxyHost {
  domains: string[]
  /** What a visitor opens (https when the proxy holds a certificate). */
  url: string | null
  forward: { scheme: string; host: string; port: number }
  guest: GuestRef | null
}

export interface InvSite { name: string; recipeId: string; url?: string; localUrl?: string; vmid: number }

export interface Inventory {
  guests: InvGuest[]
  services: InvService[]
  proxyHosts: InvProxyHost[]
  sites: InvSite[]
  /** Remote access's exclusion list (machine ids). Guests tagged hyperprox-ignore are left out as well. */
  excludedMachineIds: string[]
  builtAt: number
  /** Sources that could not be read; the preview names them. */
  errors: string[]
}

export interface GenerateOptions {
  /** CIDRs whose addresses never go on the dashboard. */
  excludeSubnets: string[]
  /** Running guests with no web service found: list them with a ping dot. */
  includeBareGuests: boolean
  /** Groups the person removed from the file or hid here: never put back. */
  hiddenGroups: string[]
  /** Entries (by id) the person hid here. */
  hiddenEntries: string[]
  /** Entry ids with their service widget turned on. */
  widgets: string[]
  /** HOMEPAGE_VAR_* names already written to the guest's .env: a widget is only written once its keys are there. */
  exportedVars: string[]
}

export const DEFAULT_OPTIONS: GenerateOptions = {
  excludeSubnets: [], includeBareGuests: false, hiddenGroups: [], hiddenEntries: [], widgets: [], exportedVars: [],
}

/** A widget this entry could have: its type and the variables its secrets would need. */
export interface WidgetOffer {
  type: string
  /** field -> HOMEPAGE_VAR_ name */
  vars: Record<string, string>
  /** Turned on by the person. */
  enabled: boolean
  /** Turned on, but its keys are not on the guest yet: not written until they are. */
  pending: boolean
}

export interface Entry {
  /** Stable across runs: `sonarr@10.0.0.5:8989`, `site:Blog`, `proxy:example.org`, `guest:101`. */
  id: string
  group: GroupName
  name: string
  href: string | null
  hrefKind: 'public' | 'lan' | 'none'
  icon: string
  description: string
  siteMonitor?: string
  ping?: string
  /** The widget block as written (secrets as {{HOMEPAGE_VAR_...}}), when enabled and its keys are exported. */
  widget?: Record<string, string>
  offer?: WidgetOffer
  guest: GuestRef | null
  source: string
}

/** What HyperProx remembers about what it wrote, so it can tell its own entries from the person's. */
export interface ManagedState {
  /** Groups HyperProx owns, by the name they have in the file. */
  managedGroups: string[]
  /** Per managed group, the entries HyperProx wrote and a hash of exactly what it wrote. */
  written: Record<string, Record<string, string>>
}

export const EMPTY_STATE: ManagedState = { managedGroups: [], written: {} }

export interface MergeNotes {
  keptUserGroups: string[]
  /** "Group / Entry": added by the person inside a HyperProx group. */
  keptUserEntries: string[]
  /** "Group / Entry": HyperProx's entry, changed by the person, left as they changed it. */
  keptEdits: string[]
  /** HyperProx groups the person deleted from the file: not put back. */
  userRemovedGroups: string[]
  /** A HyperProx group renamed because the person already has a group of that name. */
  renamed: Array<{ from: string; to: string }>
  droppedSamples: boolean
  /** Groups taken back from the file's header because HyperProx had no record of them. */
  adopted: string[]
}

export interface MergeResult { text: string; state: ManagedState; notes: MergeNotes; changed: boolean }
