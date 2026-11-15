// =============================================================================
//  HyperProx — auto-connect for the plug-ins set up by an address setting
//
//  The shared service scan already finds Unmanic workers, qBittorrent, the Arr
//  apps, Plex and Tautulli. A plug-in whose address setting is empty takes the
//  address it found by itself:
//
//    - no credential needed (Unmanic, qBittorrent): the address alone;
//    - a credential needed (an Arr app's API key, Plex's token, Tautulli's key):
//      only with exactly one vault item whose login URI is that same host and
//      that carries that kind of credential. The key then goes only to the
//      address it was stored for (saveSettings' own origin rule applies too).
//      None: left for a person. Several: one pick.
//
//  A setting a person already filled is never changed, and an address this
//  pass filled before that is empty now was cleared by a person: it stays
//  empty (dismissed), until they say "connect again".
// =============================================================================

import type { PluginManifest } from '../plugin-host'
import { exclusionOf, type AdapterContext, type AutoConnectAdapter, type Outcome } from './core'
import { matchVault, pickVault, type CredentialKind, type VaultChoice } from './vault-match'

export interface SettingSpec {
  pluginId: string
  /** The address settings it may fill, in order (Unmanic has three worker slots). */
  urlSettings: string[]
  /** A name setting beside each address slot (Unmanic's worker names). */
  labelSettings?: string[]
  secret?: { setting: string; kind: CredentialKind; what: string }
}

/** Scan key (lib/service-scan, @hyperprox/hardware/service-probes) -> what it fills. */
export const SETTING_SPECS: Record<string, SettingSpec> = {
  unmanic:     { pluginId: 'unmanic',  urlSettings: ['url', 'url2', 'url3'], labelSettings: ['label', 'label2', 'label3'] },
  qbittorrent: { pluginId: 'arrstack', urlSettings: ['qbit_url'] },
  sonarr:      { pluginId: 'arrstack', urlSettings: ['sonarr_url'],   secret: { setting: 'sonarr_key',   kind: 'api_key', what: 'Sonarr\'s API key' } },
  radarr:      { pluginId: 'arrstack', urlSettings: ['radarr_url'],   secret: { setting: 'radarr_key',   kind: 'api_key', what: 'Radarr\'s API key' } },
  lidarr:      { pluginId: 'arrstack', urlSettings: ['lidarr_url'],   secret: { setting: 'lidarr_key',   kind: 'api_key', what: 'Lidarr\'s API key' } },
  prowlarr:    { pluginId: 'arrstack', urlSettings: ['prowlarr_url'], secret: { setting: 'prowlarr_key', kind: 'api_key', what: 'Prowlarr\'s API key' } },
  plex:        { pluginId: 'plex',     urlSettings: ['plex_url'],     secret: { setting: 'plex_token',   kind: 'token',   what: 'a Plex token' } },
  tautulli:    { pluginId: 'plex',     urlSettings: ['url'],          secret: { setting: 'apikey',       kind: 'api_key', what: 'Tautulli\'s API key' } },
}

export interface ScanSighting {
  key: string
  address: string
  guest: { vmid: number; type: 'lxc' | 'qemu'; name: string } | null
}

export interface SettingsAdapterDeps {
  findings(): Promise<ScanSighting[]>
  /** Machine id (lxc-101) -> its Proxmox tags. */
  tags(): Promise<Map<string, string[]>>
  manifest(pluginId: string): PluginManifest | undefined
  settings(pluginId: string): Promise<Record<string, string>>
  /** saveSettings (lib/plugin-host.ts): its origin rule refuses a key for another address. */
  save(m: PluginManifest, values: Record<string, string>): Promise<void>
}

const machineOf = (g: ScanSighting['guest']) => (g ? `${g.type}-${g.vmid}` : null)
const originOf = (v: string) => { try { const u = new URL(v); return `${u.protocol}//${u.host}`.toLowerCase() } catch { return String(v).trim().toLowerCase() } }
const outKey = (setting: string, address: string) => `${setting}@${originOf(address)}`

export function settingsAdapter(plugin: string, d: SettingsAdapterDeps): AutoConnectAdapter {
  const specs = Object.entries(SETTING_SPECS).filter(([, s]) => s.pluginId === plugin)

  /** Fill one slot: the address (and, when the spec needs one, the vault's credential for that address). */
  async function fill(ctx: AdapterContext, m: PluginManifest, spec: SettingSpec, slot: number, f: ScanSighting, item: { choice: VaultChoice; secret: string } | null, by: 'system' | 'pick'): Promise<Outcome> {
    const setting = spec.urlSettings[slot]
    // A person may have dismissed it while this pass ran: read again right before anything is saved.
    if (ctx.dismissed(outKey(setting, f.address))) return { key: outKey(setting, f.address), label: `${m.name}: ${f.address}`, did: 'dismissed' }
    const values: Record<string, string> = { [setting]: f.address }
    if (spec.labelSettings?.[slot] && f.guest) values[spec.labelSettings[slot]] = f.guest.name.slice(0, 60)
    if (spec.secret && item) values[spec.secret.setting] = item.secret
    const evidence = [`found by the service scan at ${f.address}${f.guest ? ` on ${f.guest.name}` : ''}`]
    await ctx.audit('plugin.auto_connect', `plugin:${plugin}`, {
      setting, address: f.address, evidence, via: by,
      ...(item ? { vaultItemId: item.choice.id, vaultItemName: item.choice.name, credentialSetting: spec.secret!.setting } : {}),
    })
    await d.save(m, values)
    return { key: outKey(setting, f.address), label: `${m.name}: ${f.address}`, did: 'connected', evidence, vaultItem: item?.choice ?? null }
  }

  return {
    plugin,
    async reconcile(ctx) {
      const out: Outcome[] = []
      const m = d.manifest(plugin)
      if (!m || !specs.length) return out
      const [all, tags] = await Promise.all([d.findings(), d.tags()])
      let stored = await d.settings(plugin)
      for (const [scanKey, spec] of specs) {
        const seen = all.filter(f => f.key === scanKey)
        // One address per guest and origin; the scan can see a service on two addresses of the same guest.
        const found = seen.filter((f, i) => seen.findIndex(x => originOf(x.address) === originOf(f.address)) === i)
        const taken = new Set(spec.urlSettings.map(s => stored[s]).filter(Boolean).map(originOf))
        const usable: ScanSighting[] = []
        for (const f of found) {
          const k = outKey(spec.urlSettings[0], f.address)
          const label = `${m.name}: ${f.address}`
          if (taken.has(originOf(f.address))) { out.push({ key: k, label, did: 'present' }); continue }
          const why = exclusionOf(ctx, { machineId: machineOf(f.guest), tags: tags.get(machineOf(f.guest) ?? '') ?? [], addresses: [f.address] })
          if (why) { out.push({ key: k, label, did: 'excluded', message: why }); continue }
          // Filled by an earlier pass and not there any more: a person cleared it. Never put back by itself.
          const slotKeys = spec.urlSettings.map(s => outKey(s, f.address))
          const gone = slotKeys.find(x => ctx.dismissed(x) || ctx.autoConnectedBefore(x))
          if (gone) { out.push({ key: gone, label, did: 'dismissed' }); continue }
          usable.push(f)
        }
        const free = spec.urlSettings.map((s, i) => ({ s, i })).filter(x => !stored[x.s])
        if (!usable.length || !free.length) continue
        // A single-address setting with two candidates: not guessed between.
        if (spec.urlSettings.length === 1 && usable.length > 1) {
          out.push({ key: `${spec.urlSettings[0]}@*`, label: `${m.name}: ${spec.urlSettings[0]}`, did: 'ambiguous', choiceKind: 'address',
            message: `${usable.length} ${scanKey} servers were found. Pick the one ${m.name} uses.`,
            choices: usable.map(f => ({ id: f.address, label: `${f.address}${f.guest ? ` (${f.guest.name})` : ''}` })) })
          continue
        }
        for (const [n, f] of usable.slice(0, free.length).entries()) {
          const slot = free[n].i
          const k = outKey(spec.urlSettings[slot], f.address)
          const label = `${m.name}: ${f.address}`
          let item: { choice: VaultChoice; secret: string } | null = null
          if (spec.secret) {
            const r = matchVault(ctx.vaultItems(), f.address, spec.secret.kind)
            if (r.kind === 'none') { out.push({ key: k, label, did: 'needs_credential', message: `${spec.secret.what}: no vault item has a login for ${originOf(f.address)}.` }); continue }
            if (r.kind === 'several') { out.push({ key: k, label, did: 'ambiguous', choiceKind: 'vault-item', message: `${r.items.length} vault items have a login for ${originOf(f.address)}. Pick the one with ${spec.secret.what}.`, choices: r.items.map(i => ({ id: i.id, label: i.name })) }); continue }
            item = { choice: r.item, secret: r.value.secret }
          }
          try { out.push(await fill(ctx, m, spec, slot, f, item, 'system')); stored = await d.settings(plugin) }
          catch (e: any) { out.push({ key: k, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) }) }
        }
      }
      return out
    },

    /** key `setting@*` + an address (two servers found), or `setting@origin` + a vault item id (two logins). */
    async pick(key, choiceId, ctx) {
      const m = d.manifest(plugin)
      const at = key.indexOf('@')
      const setting = key.slice(0, at)
      const spec = specs.map(([, s]) => s).find(s => s.urlSettings.includes(setting))
      const scanKey = specs.find(([, s]) => s === spec)?.[0]
      if (!m || !spec || at < 0) throw new Error('Not a choice of this plug-in.')
      const stored = await d.settings(plugin)
      if (stored[setting]) return { key, label: m.name, did: 'present' }
      const tags = await d.tags()
      const found = (await d.findings()).filter(f => f.key === scanKey)
      const f = key.endsWith('@*') ? found.find(x => x.address === choiceId) : found.find(x => originOf(x.address) === key.slice(at + 1))
      if (!f) throw new Error('That server is not found by the scan any more.')
      if (exclusionOf(ctx, { machineId: machineOf(f.guest), tags: tags.get(machineOf(f.guest) ?? '') ?? [], addresses: [f.address] })) throw new Error('That server is excluded.')
      let item: { choice: VaultChoice; secret: string } | null = null
      if (spec.secret) {
        const r = key.endsWith('@*') ? matchVault(ctx.vaultItems(), f.address, spec.secret.kind) : pickVault(ctx.vaultItems(), choiceId, f.address, spec.secret.kind)
        if (!r || r.kind === 'none') return { key, label: m.name, did: 'needs_credential', message: `${spec.secret.what}: no vault item for ${originOf(f.address)}.` }
        if (r.kind === 'several') return { key: outKey(setting, f.address), label: m.name, did: 'ambiguous', choiceKind: 'vault-item', message: `Pick the vault item with ${spec.secret.what}.`, choices: r.items.map(i => ({ id: i.id, label: i.name })) }
        item = { choice: r.item, secret: r.value.secret }
      }
      return fill(ctx, m, spec, spec.urlSettings.indexOf(setting), f, item, 'pick')
    },
  }
}
