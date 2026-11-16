// =============================================================================
//  HyperProx — where an app was seen without looking inside a guest
//
//  Two places say an app is installed somewhere: the shared service scan (its probe answered on a guest's address)
//  and the Catalogue's finished installs. Nextcloud and Homepage both ask; each keeps its own policy on top
//  (what a failed scan means, which guests count, what else it adds).
// =============================================================================

import { sharedServiceScan } from '../service-scan'
import { wizardStore } from '../catalogue-store'
import { installStillOwns } from '../auto-connect/core'
import type { GuestKind } from '../guest-id'

export interface Sighting {
  guest: { type: GuestKind; vmid: number }
  url: string | null
  /** The address the scan answered on (a Catalogue install: the address it was given, without the prefix length). */
  ip: string | null
  /** The admin the installer made (its name only; its password stays in the vault). Catalogue sightings only. */
  admin: string | null
}

export interface SightingOptions {
  /** The guests as they are now, read after the scan: a Catalogue install whose guest is gone, or reused, is not this app. */
  guests: () => Promise<Array<{ vmid: number | string; name?: unknown }>>
  /** Catalogue installs below this id are not counted (the Catalogue makes containers from 100 up). */
  minVmid: number
  /** A scan that cannot be read: throw (default) or count as seeing nothing. */
  ignoreScanFailure?: boolean
}

export async function sightingsOf(recipeId: string, scanKey: string, o: SightingOptions): Promise<{ scan: Sighting[]; catalogue: Sighting[] }> {
  const scan: Sighting[] = []
  const findings = o.ignoreScanFailure
    ? (await sharedServiceScan().result(false).catch(() => ({ findings: [] as any[] }))).findings
    : (await sharedServiceScan().result(false)).findings
  for (const f of findings) {
    if (f.key === scanKey && f.guest) scan.push({ guest: { type: f.guest.type, vmid: Number(f.guest.vmid) }, url: f.address, ip: f.host ?? null, admin: null })
  }
  const guests = await o.guests()
  const catalogue: Sighting[] = []
  for (const r of await wizardStore().list('job').catch(() => [])) {
    const j: any = r.data
    if (j?.recipeId !== recipeId) continue
    // A VMID reused by another guest since the install: not this app any more.
    if (!installStillOwns(j, guests.find(g => Number(g.vmid) === Number(j.vmid)))) continue
    if (j.status !== 'completed' || !(Number(j.vmid) >= o.minVmid)) continue
    catalogue.push({
      guest: { type: 'lxc', vmid: Number(j.vmid) }, url: typeof j.url === 'string' ? j.url : null,
      ip: typeof j.ip === 'string' ? j.ip.split('/')[0] : null,
      admin: typeof j.adminCredential?.user === 'string' ? j.adminCredential.user : null,
    })
  }
  return { scan, catalogue }
}
