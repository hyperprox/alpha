// =============================================================================
//  HyperProx — service discovery (the Plug-ins page's view of the shared scan)
//
//  HyperProx already knows every guest on the cluster and its address. Asking
//  someone to type those addresses into a settings form is asking them to tell
//  the software something it can see for itself.
//
//  The probes are no longer kept here: they live in one list,
//  @hyperprox/hardware/service-probes, read by the setup wizard, the Plug-ins
//  page's Scan and the Catalogue alike (lib/service-scan.ts runs it). This file
//  keeps the plug-in-shaped view of that list and a single-probe helper.
// =============================================================================

import { PROBES as SHARED, probeHost } from '@hyperprox/hardware/service-probes'
import { realProbeGet, pluginFindings, sharedServiceScan } from './service-scan'

export interface Probe {
  /** Which bundled plug-in this configures. */
  pluginId: string
  /** Which of that plug-in's settings takes the address. */
  setting:  string
  label:    string
  port:     number
  path:     string
  scheme?:  'http' | 'https'
  /** True when the response is unmistakably this service. */
  match:    (status: number, body: string) => boolean
  /** Settings the user must still supply — a key we cannot discover. */
  needs?:   string[]
}

/** The shared probes that configure a plug-in. */
export const PROBES: Probe[] = SHARED.filter(p => p.pluginId && p.setting).map(p => ({
  pluginId: p.pluginId!, setting: p.setting!, label: p.label, port: p.port, path: p.path, scheme: p.scheme, match: p.match, needs: p.needs,
}))

export interface Finding {
  pluginId: string
  setting:  string
  label:    string
  address:  string
  /** Where it was found, for a human to recognise. */
  source:   string
  needs:    string[]
}

/** One probe against one address. Never throws; a miss is just a miss, and so is a redirect off its own origin. */
export async function probeOne(host: string, probe: Pick<Probe, 'port' | 'path' | 'match'> & { scheme?: 'http' | 'https' }): Promise<boolean> {
  return probeHost(realProbeGet, host, { key: 'one', label: '', recipeId: null, pluginId: null, setting: null, needs: [], multiple: false, scheme: probe.scheme ?? 'http', port: probe.port, path: probe.path, match: probe.match })
}

/** Scan for services HyperProx has a plug-in for: the shared scan (lib/service-scan.ts), asked afresh. */
export async function discoverServices(): Promise<Finding[]> {
  return pluginFindings((await sharedServiceScan().result(true)).findings)
}
