// =============================================================================
//  HyperProx — auto-connect: finding the credential for a detected install in the vault
//
//  The vault already holds the logins a person keeps for their services. When a
//  plug-in finds an install that needs a credential, it looks here before it
//  asks anyone, with three rules that never bend:
//
//    - only an item whose login URI names the same host as the install (and the
//      same port and scheme when the URI names them) matches: a stored
//      credential is never sent to a host it was not stored for;
//    - only an item that carries the kind of credential the plug-in needs (an
//      API key, a token, a username and password) is considered;
//    - exactly one match is used; two or more are never guessed between, the
//      person picks one (by id and name only; no value ever leaves here except
//      to the caller that sends it to that same address).
//
//  HyperProx's own items (hyperprox:<category>/<provider>) are the plug-ins'
//  settings, not a person's logins, and are never matched here.
// =============================================================================

import type { SecretItem } from '../vault/broker'
import { originParts } from '../net/ip'

const ITEM_PREFIX = 'hyperprox:'

export type CredentialKind = 'api_key' | 'token' | 'login' | 'password'

export interface VaultChoice { id: string; name: string }

export type VaultMatch =
  | { kind: 'none' }
  | { kind: 'one'; item: VaultChoice; value: { secret: string; username: string | null } }
  | { kind: 'several'; items: VaultChoice[] }

const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }

/** scheme, host and port of an address (lib/net/ip.ts). */
export { originParts }

/**
 * Whether a vault URI is for this address. Always the same host. The same scheme when the URI names one. The same
 * port: the URI's own port, or, when it names none, the default port of its scheme (of the address's scheme for a
 * bare host), so a URI for a host's web page never matches every other app on that host. A URI that cannot be read
 * never matches.
 */
export function uriMatches(uri: string, address: string): boolean {
  const a = originParts(address)
  const u = originParts(uri)
  if (!a || !u || !a.schemeGiven) return false
  if (u.host !== a.host) return false
  if (u.schemeGiven && u.scheme !== a.scheme) return false
  const wantPort = u.portGiven ? u.port : u.schemeGiven ? DEFAULT_PORT[u.scheme] : DEFAULT_PORT[a.scheme]
  return wantPort === a.port
}

/** The credential this item carries for the kind wanted, or null. Field names only decide; values are not looked at. */
export function credentialOf(item: SecretItem, kind: CredentialKind): { secret: string; username: string | null } | null {
  const f = item.fields ?? {}
  const field = (re: RegExp) => Object.keys(f).find(k => re.test(k) && (f[k] ?? '').trim())
  const username = f.username?.trim() ? f.username.trim() : null
  if (kind === 'login') return username && f.password ? { secret: f.password, username } : null
  // Pi-hole signs in with a password alone: an item for that very address (the URI rule in matchVault) with one.
  if (kind === 'password') return f.password && f.password.trim() ? { secret: f.password, username } : null
  const named = field(kind === 'api_key' ? /^(x-)?api[ _-]?key$|^apikey$/i : /^(x-plex-)?token$|^api[ _-]?token$/i)
  if (named) return { secret: f[named], username }
  // A login's password is taken for a key only when the item itself says it is one ("Sonarr API key", "Plex token"):
  // a person's web password is never sent as an API key, whatever it looks like.
  const label = kind === 'api_key' ? /\bapi[ _-]?key\b|\bapikey\b/i : /\btoken\b/i
  return f.password && label.test(String(item.name ?? '')) ? { secret: f.password, username } : null
}

/** The vault items for this address and kind: none, exactly one (with the credential), or several to pick from. */
export function matchVault(items: SecretItem[], address: string, kind: CredentialKind): VaultMatch {
  const hits = items
    .filter(i => i && !String(i.name ?? '').startsWith(ITEM_PREFIX))
    .filter(i => (i.uris ?? []).some(u => uriMatches(u, address)))
    .map(i => ({ item: i, cred: credentialOf(i, kind) }))
    .filter((x): x is { item: SecretItem; cred: { secret: string; username: string | null } } => !!x.cred)
  if (!hits.length) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'several', items: hits.map(h => ({ id: h.item.id, name: h.item.name })) }
  return { kind: 'one', item: { id: hits[0].item.id, name: hits[0].item.name }, value: hits[0].cred }
}

/** One item the person picked: used only when it still matches this address and kind. */
export function pickVault(items: SecretItem[], id: string, address: string, kind: CredentialKind): Extract<VaultMatch, { kind: 'one' }> | null {
  const i = items.find(x => x.id === id && !String(x.name ?? '').startsWith(ITEM_PREFIX))
  if (!i || !(i.uris ?? []).some(u => uriMatches(u, address))) return null
  const cred = credentialOf(i, kind)
  return cred ? { kind: 'one', item: { id: i.id, name: i.name }, value: cred } : null
}
