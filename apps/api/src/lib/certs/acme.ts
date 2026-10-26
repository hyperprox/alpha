// =============================================================================
//  HyperProx — Certificates: ACME issuance over DNS-01
//
//  RFC 8555 (account, order, authorizations, finalize) is acme-client's job;
//  this file decides what to ask for and guarantees two things:
//    - Nothing is written to DNS unless every name lies in a managed zone, so
//      an order that cannot finish never leaves records behind to start with.
//    - Every challenge value this order wrote is removed again, in a finally,
//      whether the CA accepted it, rejected it or the wait timed out.
//  There is no retry loop here: CAs rate-limit failed validations, and a
//  failed renewal is retried by the next daily check.
//
//  ARI (RFC 9773, renewal information) is a plain GET acme-client does not
//  know, so it is fetched directly.
// =============================================================================

import { X509Certificate, createPrivateKey } from 'node:crypto'
import * as acme from 'acme-client'
import type { KeyType } from './policy'
import { findZone, waitForPropagation, type DnsProvider } from './dns01'

export interface IssueDeps {
  directoryUrl: string
  email: string | null
  getAccountKey(): Promise<string | null>
  saveAccountKey(pem: string): Promise<void>
  dns: DnsProvider[]
  log(line: string): void
  propagation?: Parameters<typeof waitForPropagation>[2]
}

export interface IssuedBundle {
  keyPem: string; certPem: string; chainPem: string; fullchainPem: string
  notBefore: Date; notAfter: Date; serial: string; issuer: string; fingerprint256: string
}

function normName(n: string): string {
  return n.trim().toLowerCase().replace(/\.$/, '')
}

/** For each name, the provider and zone that can answer its challenge; zone null when none can. */
export async function zonesFor(names: string[], dns: DnsProvider[]): Promise<{ name: string; zone: string | null; provider: string | null }[]> {
  const lists = await Promise.all(dns.map(async p => ({ p, zones: await p.zones() })))
  return names.map(name => {
    let zone: string | null = null, provider: string | null = null
    for (const { p, zones } of lists) {
      const z = findZone(name, zones)
      if (z && (!zone || z.length > zone.length)) { zone = z; provider = p.name }
    }
    return { name, zone, provider }
  })
}

async function newCertKey(t: KeyType): Promise<Buffer> {
  switch (t) {
    case 'ec256':   return acme.crypto.createPrivateEcdsaKey('P-256')
    case 'ec384':   return acme.crypto.createPrivateEcdsaKey('P-384')
    case 'rsa2048': return acme.crypto.createPrivateRsaKey(2048)
    case 'rsa4096': return acme.crypto.createPrivateRsaKey(4096)
  }
}

/** "CN=…, O=…, C=…": Node gives the DN one attribute per line. */
function oneLineDn(dn: string): string {
  return dn.split('\n').filter(Boolean).reverse().join(', ')
}

/** Dates, serial, issuer and fingerprint of a PEM leaf, in the shapes the rest of the feature compares. */
export function describeLeaf(certPem: string): Pick<IssuedBundle, 'notBefore' | 'notAfter' | 'serial' | 'issuer' | 'fingerprint256'> {
  const x = new X509Certificate(certPem)
  return {
    notBefore: new Date(x.validFrom), notAfter: new Date(x.validTo),
    serial: x.serialNumber.toUpperCase(),
    issuer: oneLineDn(x.issuer),
    fingerprint256: x.fingerprint256,
  }
}

interface Challenge { name: string; zone: string; provider: DnsProvider; fqdn: string; value: string }

export async function issueCertificate(deps: IssueDeps, names: string[], keyType: KeyType): Promise<IssuedBundle> {
  const wanted = [...new Set(names.map(normName))]
  if (!wanted.length) throw new Error('no names to issue a certificate for')

  // 1. Every name must lie in a managed zone before anything is written anywhere.
  const zoned = await zonesFor(wanted, deps.dns)
  const unmanaged = zoned.filter(z => !z.zone).map(z => z.name)
  if (unmanaged.length) throw new Error(`No managed DNS zone for ${unmanaged.join(', ')}: nothing was written`)
  const zoneOf = new Map(zoned.map(z => [z.name.replace(/^\*\./, ''), z]))

  // 2. Account: one key, kept in the vault, reused for every order.
  let accountKey = await deps.getAccountKey()
  const knownKey = Boolean(accountKey)
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateEcdsaKey('P-256')).toString()
    // Saved before the account exists, so a failure further on cannot strand a registered key nobody kept.
    await deps.saveAccountKey(accountKey)
    deps.log('Created a new ACME account key')
  }
  const client = new acme.Client({ directoryUrl: deps.directoryUrl, accountKey })
  const contact = deps.email ? [`mailto:${deps.email}`] : []
  const register = () => client.createAccount({ termsOfServiceAgreed: true, ...(contact.length ? { contact } : {}) })
  if (!knownKey) await register()
  else {
    // Re-sending newAccount for an existing key makes acme-client follow up with an account update, and a
    // CA refuses an update that changes nothing. Look the account up instead, and only update a changed contact.
    let account: { contact?: string[] } | null = null
    try { account = await client.createAccount({ onlyReturnExisting: true }) }
    catch (e: any) {
      // acme-client keeps only the problem's detail text, not its type (accountDoesNotExist), so match the
      // wording CAs use: Let's Encrypt "No account exists with the provided key", Pebble "unable to find existing account".
      if (!/accountDoesNotExist|no account exists|unable to find existing account|account (does not exist|not found)/i.test(String(e?.message ?? e))) throw e
      deps.log('The stored account key has no account at this CA; registering it')
      await register()
    }
    if (account && contact.length && JSON.stringify(account.contact ?? []) !== JSON.stringify(contact)) {
      await client.updateAccount({ contact })
      deps.log('ACME account contact updated')
    }
  }

  // 3. Order and its authorizations.
  const order = await client.createOrder({ identifiers: wanted.map(value => ({ type: 'dns', value })) })
  deps.log(`Order created for ${wanted.join(', ')}`)
  const authzs = await client.getAuthorizations(order)

  const written: Challenge[] = []
  try {
    const pending: { authz: acme.Authorization; challenge: any; c: Challenge }[] = []
    for (const authz of authzs) {
      const label = `${authz.wildcard ? '*.' : ''}${authz.identifier.value}`
      if (authz.status === 'valid') { deps.log(`${label}: already authorized`); continue }
      const challenge = authz.challenges.find(ch => ch.type === 'dns-01')
      if (!challenge) throw new Error(`${label}: the CA offered no dns-01 challenge`)
      const z = zoneOf.get(normName(authz.identifier.value))
      if (!z?.zone || !z.provider) throw new Error(`${label}: the CA asked for a name that was not ordered`)
      const provider = deps.dns.find(p => p.name === z.provider)!
      const c: Challenge = {
        name: label, zone: z.zone, provider,
        fqdn: `_acme-challenge.${normName(authz.identifier.value)}`,
        value: await client.getChallengeKeyAuthorization(challenge),
      }
      pending.push({ authz, challenge, c })
    }

    // 4. Write every value first (apex and wildcard share a name), then wait for all of them.
    for (const { c } of pending) {
      written.push(c)
      await c.provider.present(c.zone, c.fqdn, c.value)
      deps.log(`TXT ${c.fqdn} added in ${c.zone} (${c.provider.name}) for ${c.name}`)
    }
    for (const { c } of pending) {
      await waitForPropagation(c.fqdn, c.value, { ...deps.propagation, zone: deps.propagation?.zone ?? c.zone })
      deps.log(`TXT ${c.fqdn} visible on the zone's name servers`)
    }

    // 5. Validation.
    for (const { challenge, c } of pending) {
      await client.completeChallenge(challenge)
      try { await client.waitForValidStatus(challenge) }
      catch (e: any) { throw new Error(`${c.name}: the CA rejected the challenge: ${e?.message ?? e}`) }
      deps.log(`${c.name}: validated`)
    }
  } finally {
    // 6. Remove exactly what this order wrote. A cleanup failure is logged, never allowed to mask the real error.
    for (const c of written) {
      try { await c.provider.cleanup(c.zone, c.fqdn, c.value); deps.log(`TXT ${c.fqdn} value removed`) }
      catch (e: any) { deps.log(`Could not remove the TXT value at ${c.fqdn}: ${e?.message ?? e}`) }
    }
  }

  // 7. Finalize with a fresh key.
  const key = await newCertKey(keyType)
  // The CN is limited to 64 characters; it is optional, and the SANs are what clients check.
  const cn = wanted.find(n => n.length <= 64)
  const [, csr] = await acme.crypto.createCsr({ ...(cn ? { commonName: cn } : {}), altNames: wanted }, key)
  const finalized = await client.finalizeOrder(order, csr)
  const fullchainPem = (await client.getCertificate(finalized)).trim() + '\n'

  const parts = acme.crypto.splitPemChain(fullchainPem)
  if (!parts.length) throw new Error('the CA returned no certificate')
  const certPem = parts[0].trim() + '\n'
  const chainPem = parts.slice(1).map(p => p.trim() + '\n').join('')
  const leaf = new X509Certificate(certPem)
  const keyPem = key.toString()
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) throw new Error('the issued certificate does not match the generated key')
  const sans = (leaf.subjectAltName ?? '').split(', ').filter(s => s.startsWith('DNS:')).map(s => s.slice(4).toLowerCase())
  const missing = wanted.filter(n => !sans.includes(n))
  if (missing.length) throw new Error(`the issued certificate does not cover ${missing.join(', ')}`)

  const info = describeLeaf(certPem)
  deps.log(`Issued: serial ${info.serial}, valid until ${info.notAfter.toISOString()}`)
  return { keyPem, certPem, chainPem, fullchainPem, ...info }
}

// --- ARI (RFC 9773) ---------------------------------------------------------------

interface Der { tag: number; start: number; len: number; end: number }

function derAt(buf: Buffer, pos: number): Der {
  const tag = buf[pos]
  let len = buf[pos + 1], start = pos + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n < 1 || n > 4) throw new Error('unsupported DER length')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]
    start += n
  }
  if (start + len > buf.length) throw new Error('truncated DER')
  return { tag, start, len, end: start + len }
}

function derChildren(buf: Buffer, parent: Der): Der[] {
  const out: Der[] = []
  for (let p = parent.start; p < parent.end;) { const d = derAt(buf, p); out.push(d); p = d.end }
  return out
}

const OID_AKI = Buffer.from([0x55, 0x1d, 0x23])   // 2.5.29.35 authorityKeyIdentifier

/** The ARI certID: base64url(AKI keyIdentifier) "." base64url(serial as DER INTEGER content). */
export function ariCertId(certPem: string): string {
  const der = new X509Certificate(certPem).raw
  const tbs = derChildren(der, derAt(der, 0))[0]
  const fields = derChildren(der, tbs)
  const i = fields[0].tag === 0xa0 ? 1 : 0          // [0] version is optional
  const serial = der.subarray(fields[i].start, fields[i].end)
  const extsWrap = fields.find(f => f.tag === 0xa3)
  if (!extsWrap) throw new Error('certificate has no extensions')
  for (const ext of derChildren(der, derChildren(der, extsWrap)[0])) {
    const parts = derChildren(der, ext)
    if (parts[0].tag !== 0x06 || !der.subarray(parts[0].start, parts[0].end).equals(OID_AKI)) continue
    const octets = parts[parts.length - 1]
    const aki = derChildren(der, derAt(der, octets.start)).find(d => d.tag === 0x80)
    if (!aki) break
    return `${der.subarray(aki.start, aki.end).toString('base64url')}.${serial.toString('base64url')}`
  }
  throw new Error('certificate has no authority key identifier')
}

/** The CA's suggested renewal window, or null when the CA offers no ARI or does not know the certificate. */
export async function fetchAri(directoryUrl: string, certPem: string): Promise<{ start: Date; end: Date } | null> {
  const dirRes = await fetch(directoryUrl, { signal: AbortSignal.timeout(15_000) })
  if (!dirRes.ok) throw new Error(`ACME directory ${dirRes.status}`)
  const dir = await dirRes.json() as { renewalInfo?: unknown }
  if (typeof dir.renewalInfo !== 'string' || !dir.renewalInfo) return null

  const url = `${dir.renewalInfo.replace(/\/+$/, '')}/${ariCertId(certPem)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`ARI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json() as { suggestedWindow?: { start?: string; end?: string } }
  const start = new Date(body.suggestedWindow?.start ?? NaN), end = new Date(body.suggestedWindow?.end ?? NaN)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('ARI response has no valid suggestedWindow')
  return { start, end }
}
