// =============================================================================
//  HyperProx — Notifications: where channel secrets live
//
//  A channel's secret (webhook URL, token, bot token, signing secret) is one
//  vault Secure Note, `hyperprox:notify/<channelId>`, through the credential
//  store: written as the signed-in user, read from the unlock cache. While
//  locked it cannot be read.
//
//  A channel marked "usable while locked" keeps its secret OUTSIDE the vault in
//  data/notify-locked-channels.json (0600, written atomically, git-ignored),
//  with a copy of its non-secret delivery settings, so a lock alert needs
//  neither Postgres nor the vault. Anyone who can read that file can post to
//  those channels: that is the stated trade-off, owner-only, per channel. The
//  vault copy is removed, so each secret has one home.
//
//  Nothing here logs a value.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../vault/config'
import { isUnlocked, cachedSecret } from '../vault/state'
import { deleteProviderCredentials, itemName, setCredentials } from '../credentials'
import type { ChannelKind, ChannelNonSecret, ChannelRecord, ChannelSecret, EventFilter, QuietHours, Severity } from './types'

// --- The locked-channels file ------------------------------------------------

export interface LockedEntry {
  id: string
  name: string
  kind: ChannelKind
  enabled: boolean
  minSeverity: Severity
  eventFilter: EventFilter
  quietHours: QuietHours | null
  lanOverride: boolean
  nonSecret: ChannelNonSecret
  secret: ChannelSecret
}

export interface LockedFileData {
  version: 1
  /** Which old settings were moved here, and when (e.g. lockAlert). */
  seeded: Record<string, string>
  channels: Record<string, LockedEntry>
}

export function lockedFilePath(): string {
  return path.join(dataDir(), 'notify-locked-channels.json')
}

export class LockedChannelsFile {
  constructor(private readonly file: string = lockedFilePath()) {}

  get path(): string { return this.file }

  read(): LockedFileData {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (v && v.version === 1 && v.channels && typeof v.channels === 'object') {
        return { version: 1, seeded: v.seeded && typeof v.seeded === 'object' ? v.seeded : {}, channels: v.channels }
      }
    } catch { /* missing or damaged: empty */ }
    return { version: 1, seeded: {}, channels: {} }
  }

  private write(d: LockedFileData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }

  upsert(ch: Pick<ChannelRecord, 'id' | 'name' | 'kind' | 'enabled' | 'minSeverity' | 'eventFilter' | 'quietHours' | 'lanOverride' | 'nonSecret'>,
         secret?: ChannelSecret): void {
    const d = this.read()
    const prev = d.channels[ch.id]
    const s = secret ?? prev?.secret
    if (!s) throw new Error('no secret for a usable-while-locked channel')
    d.channels[ch.id] = {
      id: ch.id, name: ch.name, kind: ch.kind, enabled: ch.enabled, minSeverity: ch.minSeverity, eventFilter: ch.eventFilter,
      quietHours: ch.quietHours, lanOverride: ch.lanOverride, nonSecret: ch.nonSecret, secret: clean(s),
    }
    this.write(d)
  }

  remove(id: string): void {
    const d = this.read()
    if (!d.channels[id]) return
    delete d.channels[id]
    this.write(d)
  }

  markSeeded(key: string, at = new Date()): void {
    const d = this.read()
    d.seeded[key] = at.toISOString()
    this.write(d)
  }
}

function clean(s: ChannelSecret): ChannelSecret {
  const out: ChannelSecret = {}
  if (s.url) out.url = s.url
  if (s.token) out.token = s.token
  if (s.botToken) out.botToken = s.botToken
  if (s.signingSecret) out.signingSecret = s.signingSecret
  return out
}

// --- The vault ---------------------------------------------------------------

export interface SecretBackend {
  readable(): boolean
  read(channelId: string): ChannelSecret | null
  write(channelId: string, s: ChannelSecret): Promise<void>
  remove(channelId: string): Promise<void>
}

const CATEGORY = 'notify'

/** The vault through the credential store: item hyperprox:notify/<id>, fields url, token, bot_token, signing_secret. */
export function vaultSecretBackend(): SecretBackend {
  return {
    readable: () => isUnlocked(),
    read(id) {
      if (!isUnlocked()) return null
      const f = cachedSecret(itemName(CATEGORY, id))?.fields
      if (!f) return null
      return clean({ url: f.url, token: f.token, botToken: f.bot_token, signingSecret: f.signing_secret })
    },
    // Every field is written, empty when unused, so a changed kind leaves nothing stale behind.
    write: (id, s) => setCredentials(CATEGORY, id, {
      url: s.url ?? '', token: s.token ?? '', bot_token: s.botToken ?? '', signing_secret: s.signingSecret ?? '',
    }),
    remove: id => deleteProviderCredentials(CATEGORY, id),
  }
}

// --- One place per channel ---------------------------------------------------

export class ChannelSecrets {
  constructor(readonly vault: SecretBackend, readonly file: LockedChannelsFile) {}

  /** Null when it cannot be read now (a vault-only channel while locked) or there is none. */
  get(ch: Pick<ChannelRecord, 'id' | 'usableWhileLocked'>): ChannelSecret | null {
    if (ch.usableWhileLocked) return this.file.read().channels[ch.id]?.secret ?? null
    return this.vault.read(ch.id)
  }

  /** Readable at all right now (decides between sending and holding). */
  readable(ch: Pick<ChannelRecord, 'usableWhileLocked'>): boolean {
    return ch.usableWhileLocked || this.vault.readable()
  }

  /** Store in the channel's one place, and remove any copy from the other. */
  async put(ch: ChannelRecord, secret: ChannelSecret): Promise<void> {
    if (ch.usableWhileLocked) {
      this.file.upsert(ch, secret)
      if (this.vault.read(ch.id)) await this.vault.remove(ch.id)
    } else {
      await this.vault.write(ch.id, secret)
      this.file.remove(ch.id)
    }
  }

  /** Keep the file's copy of the non-secret settings current after an edit. */
  syncLocked(ch: ChannelRecord): void {
    if (ch.usableWhileLocked && this.file.read().channels[ch.id]) this.file.upsert(ch)
  }

  async remove(ch: Pick<ChannelRecord, 'id'>): Promise<void> {
    this.file.remove(ch.id)
    if (this.vault.readable() && this.vault.read(ch.id)) await this.vault.remove(ch.id)
  }
}

// --- What the UI sees --------------------------------------------------------

const last4 = (s: string) => `••••${s.replace(/\/+$/, '').slice(-4)}`

/** Host plus the last four characters. The full value never goes back to the browser. */
export function maskSecret(kind: ChannelKind, s: ChannelSecret | null, ns: ChannelNonSecret): string {
  if (kind === 'telegram') return s?.botToken ? `bot ${last4(s.botToken)}${ns.chatId ? `, chat ${ns.chatId}` : ''}` : '—'
  if (!s?.url) return '—'
  let host = ''
  try { host = new URL(s.url).host } catch { return '••••' }
  return `${host}/…/${last4(s.url)}${s.token ? ' + token' : ''}${s.signingSecret ? ' + signing secret' : ''}`
}
