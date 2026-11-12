'use client'

// =============================================================================
//  Settings → Notifications
//  Where HyperProx tells you that something needs attention: a chat app, a
//  phone push service, or your own webhook. Each channel picks how serious a
//  message must be, which kinds of events it gets, and its quiet hours.
//  Addresses and tokens are saved in the vault and never shown again: the page
//  only ever sees a mask. Owners can mark a channel "works while locked".
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Details, Feed, HudHeader, Page, Panel, Pill, styles as ks, type FeedTone, type PillTone, type StatChip } from '@/components/visual/kit'
import ss from '../settings.module.css'
import { exact, inWords } from '../when'

type Kind = 'discord' | 'slack' | 'teams' | 'ntfy' | 'gotify' | 'telegram' | 'webhook'
type Severity = 'info' | 'warning' | 'critical'
type Family = 'vault' | 'updates' | 'certs' | 'jobs' | 'backups' | 'resources' | 'home' | 'media'
interface QuietHours { start: string; end: string; tz?: string; days?: number[]; criticalBreaksThrough: boolean }
interface LastResult { ok: boolean; status?: number; code?: string; at: string; text: string }

interface Channel {
  id: string; name: string; kind: Kind; enabled: boolean; minSeverity: Severity; eventFilter: 'all' | Family[]
  quietHours: QuietHours | null; lanOverride: boolean; usableWhileLocked: boolean; private?: boolean; chatId: string | null
  mask: string; secretReadable: boolean; hasToken: boolean; hasSigningSecret: boolean
  lastResult: LastResult | null; lastSentAt: string | null; failingSince: string | null; seededFrom: string | null
}
interface Meta { canSetUsableWhileLocked: boolean; publicUrlSet: boolean }
interface Delivery { id: string; channelId: string; type: string; severity: Severity; title: string; status: string; createdAt: string; text: string }

const KINDS: Record<Kind, { label: string; help: string; urlHint?: string; selfHost: boolean; lockedOk: boolean }> = {
  discord:  { label: 'Discord', help: 'In Discord: Server Settings, Integrations, Webhooks, New Webhook, then Copy Webhook URL.', urlHint: 'https://discord.com/api/webhooks/...', selfHost: false, lockedOk: true },
  slack:    { label: 'Slack', help: 'An incoming webhook from a Slack app.', urlHint: 'https://hooks.slack.com/services/...', selfHost: false, lockedOk: true },
  teams:    { label: 'Microsoft Teams', help: 'In Teams, add the workflow "When a Teams webhook request is received" to a channel and copy its URL.', urlHint: 'https://....logic.azure.com/workflows/...', selfHost: false, lockedOk: true },
  ntfy:     { label: 'ntfy (phone push)', help: 'The topic address, e.g. https://ntfy.sh/your-own-topic. Add an access token if the topic is protected.', urlHint: 'https://ntfy.sh/your-topic', selfHost: true, lockedOk: true },
  gotify:   { label: 'Gotify', help: "Your Gotify server's /message address and an application token.", urlHint: 'https://gotify.example.com/message', selfHost: true, lockedOk: true },
  telegram: { label: 'Telegram', help: 'A bot token from @BotFather, and the chat to post to (a number like -1001234567890, or @channelname).', selfHost: false, lockedOk: true },
  webhook:  { label: 'Generic webhook', help: 'HyperProx POSTs a small JSON message (see docs/notifications.md). A signing secret adds an HMAC signature you can check.', urlHint: 'https://example.com/hooks/hyperprox', selfHost: true, lockedOk: true },
}

const FAMILY_LABEL: Record<Family, string> = {
  vault: 'Lock alerts', updates: 'Updates', certs: 'Certificates', jobs: 'Jobs (wizard, catalogue, file copies)', backups: 'Backups', resources: 'Cluster health',
  home: 'Home Assistant security actions',
  media: 'Plex: new in the library',
}
const SEVERITY_LABEL: Record<Severity, string> = { info: 'Everything', warning: 'Warnings and critical', critical: 'Critical only' }
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function detectKind(url: string): Kind | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const h = u.hostname.toLowerCase()
  const under = (d: string) => h === d || h.endsWith(`.${d}`)
  if ((under('discord.com') || under('discordapp.com')) && u.pathname.startsWith('/api/webhooks/')) return 'discord'
  if (h === 'hooks.slack.com') return 'slack'
  if (under('logic.azure.com') || under('powerplatform.com') || under('webhook.office.com')) return 'teams'
  if (/\/message\/?$/.test(u.pathname)) return 'gotify'
  if (h.includes('ntfy')) return 'ntfy'
  return 'webhook'
}

function fmt(s: string | null) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

function eventsText(f: Channel['eventFilter']) {
  return f === 'all' ? 'All events' : f.map(x => FAMILY_LABEL[x]).join(', ')
}

function quietText(q: QuietHours | null) {
  if (!q) return null
  const days = q.days && q.days.length && q.days.length < 7 ? ` on ${q.days.map(d => DAY[d]).join(', ')}` : ''
  return `Quiet ${q.start}–${q.end}${days}${q.criticalBreaksThrough ? ' (critical still comes through)' : ''}`
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: PillTone }) {
  return <Pill tone={tone}>{children}</Pill>
}

// A channel's health, as the dot on its tile and the word beside it (the word is what carries it).
type ChannelHealth = 'good' | 'warn' | 'bad' | 'unknown'
function channelHealth(c: Channel): { tone: ChannelHealth; word: string } {
  if (c.failingSince) return { tone: 'bad', word: 'Failing' }
  if (!c.enabled) return { tone: 'unknown', word: 'Paused' }
  if (!c.lastResult) return { tone: 'unknown', word: 'Not tested yet' }
  return c.lastResult.ok ? { tone: 'good', word: 'Working' } : { tone: 'warn', word: 'Last send failed' }
}

/** A delivery's tone for the feed dot; its text (always shown) says the same in words. */
function deliveryTone(status: string): FeedTone {
  if (status === 'sent') return 'ok'
  if (status === 'failed') return 'bad'
  if (status.startsWith('held') || status === 'dropped') return 'off'
  return 'warn'
}

function Toggle({ id, checked, onChange, label, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm" style={{ color: disabled ? 'var(--text-dimmer)' : 'var(--text-soft)', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="mt-1" />
      <span>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------

interface Form {
  name: string; kind: Kind; kindTouched: boolean; enabled: boolean; minSeverity: Severity
  allEvents: boolean; families: Family[]
  quiet: boolean; qStart: string; qEnd: string; qTz: string; qDays: number[]; qBreak: boolean
  lanOverride: boolean; usableWhileLocked: boolean; private: boolean
  url: string; token: string; botToken: string; chatId: string; signingSecret: string
  clearToken: boolean; clearSigningSecret: boolean
}

function emptyForm(): Form {
  let tz = ''
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { /* none */ }
  return {
    name: '', kind: 'ntfy', kindTouched: false, enabled: true, minSeverity: 'warning', allEvents: true, families: [],
    quiet: false, qStart: '22:00', qEnd: '07:00', qTz: tz, qDays: [], qBreak: true,
    lanOverride: false, usableWhileLocked: false, private: false,
    url: '', token: '', botToken: '', chatId: '', signingSecret: '', clearToken: false, clearSigningSecret: false,
  }
}

function formFrom(c: Channel): Form {
  const f = emptyForm()
  return {
    ...f, name: c.name, kind: c.kind, kindTouched: true, enabled: c.enabled, minSeverity: c.minSeverity,
    allEvents: c.eventFilter === 'all', families: c.eventFilter === 'all' ? [] : c.eventFilter,
    quiet: !!c.quietHours, qStart: c.quietHours?.start ?? f.qStart, qEnd: c.quietHours?.end ?? f.qEnd,
    qTz: c.quietHours?.tz ?? f.qTz, qDays: c.quietHours?.days ?? [], qBreak: c.quietHours?.criticalBreaksThrough ?? true,
    lanOverride: c.lanOverride, usableWhileLocked: c.usableWhileLocked, private: !!c.private, chatId: c.chatId ?? '',
  }
}

function payloadFrom(f: Form, editing: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: f.name.trim(), kind: f.kind, enabled: f.enabled, minSeverity: f.minSeverity,
    eventFilter: f.allEvents ? 'all' : f.families,
    quietHours: f.quiet ? { start: f.qStart, end: f.qEnd, ...(f.qTz ? { tz: f.qTz } : {}), ...(f.qDays.length ? { days: f.qDays } : {}), criticalBreaksThrough: f.qBreak } : null,
    lanOverride: KINDS[f.kind].selfHost ? f.lanOverride : false,
    usableWhileLocked: f.usableWhileLocked,
    private: f.private,
  }
  if (f.kind === 'telegram') { p.chatId = f.chatId.trim(); if (f.botToken.trim()) p.botToken = f.botToken.trim() }
  else {
    if (f.url.trim()) p.url = f.url.trim()
    if ((f.kind === 'ntfy' || f.kind === 'gotify') && f.token.trim()) p.token = f.token.trim()
    if (f.kind === 'webhook' && f.signingSecret.trim()) p.signingSecret = f.signingSecret.trim()
    if (editing && f.clearToken) p.clearToken = true
    if (editing && f.clearSigningSecret) p.clearSigningSecret = true
  }
  return p
}

function ChannelModal({ editing, meta, onSaved, onClose }: {
  editing: Channel | null; meta: Meta; onSaved: (c: Channel, created: boolean) => void; onClose: () => void
}) {
  const [f, setF] = useState<Form>(() => (editing ? formFrom(editing) : emptyForm()))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(prev => ({ ...prev, [k]: v }))
  const k = KINDS[f.kind]
  const kindChanged = !!editing && editing.kind !== f.kind
  const needSecret = !editing || kindChanged || !editing.secretReadable
  const lockChange = f.usableWhileLocked !== (editing?.usableWhileLocked ?? false)

  function onUrl(v: string) {
    setF(prev => {
      const next = { ...prev, url: v }
      const d = detectKind(v.trim())
      if (d && !prev.kindTouched && !editing) next.kind = d
      return next
    })
  }

  async function save() {
    setBusy(true); setError('')
    const r = editing
      ? await apiJson<{ channel: Channel }>(`/api/settings/notifications/channels/${encodeURIComponent(editing.id)}`, 'PUT', payloadFrom(f, true))
      : await apiJson<{ channel: Channel }>('/api/settings/notifications/channels', 'POST', payloadFrom(f, false))
    setBusy(false)
    if (r.ok && r.body?.channel) { onSaved(r.body.channel, !editing); return }
    // Marking a channel private (sign-in links go there) asks for the master password again.
    if (r.code === 'reconfirm_required') { setReconfirm(true); return }
    setError(r.error ?? 'Could not save the channel')
  }
  const [reconfirm, setReconfirm] = useState(false)

  const canSave = f.name.trim() && (!needSecret || (f.kind === 'telegram' ? f.botToken.trim() && f.chatId.trim() : f.url.trim())) &&
    (f.allEvents || f.families.length > 0) && !(f.kind === 'gotify' && needSecret && !f.token.trim())

  return (
    <Modal title={editing ? `Edit "${editing.name}"` : 'Add a channel'} onClose={onClose}>
      {reconfirm && <ReconfirmModal onDone={() => { setReconfirm(false); save() }} onClose={() => setReconfirm(false)} />}
      <form onSubmit={e => { e.preventDefault(); save() }} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label htmlFor="n-name" style={LABEL}>Name</label>
            <input id="n-name" autoFocus value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. My phone" maxLength={60} style={INPUT} /></div>
          <div><label htmlFor="n-kind" style={LABEL}>Kind</label>
            <select id="n-kind" value={f.kind} onChange={e => setF(p => ({ ...p, kind: e.target.value as Kind, kindTouched: true }))} style={{ ...INPUT, cursor: 'pointer' }}>
              {(Object.keys(KINDS) as Kind[]).map(x => <option key={x} value={x}>{KINDS[x].label}</option>)}
            </select></div>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{k.help}</p>

        {f.kind === 'telegram' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label htmlFor="n-bot" style={LABEL}>Bot token</label>
              <input id="n-bot" type="password" autoComplete="off" value={f.botToken} onChange={e => set('botToken', e.target.value)}
                     placeholder={needSecret ? '123456:ABC...' : `Saved (${editing?.mask}); leave blank to keep`} style={INPUT} /></div>
            <div><label htmlFor="n-chat" style={LABEL}>Chat id</label>
              <input id="n-chat" value={f.chatId} onChange={e => set('chatId', e.target.value)} placeholder="-1001234567890" style={INPUT} /></div>
          </div>
        ) : (
          <>
            <div><label htmlFor="n-url" style={LABEL}>Address</label>
              <input id="n-url" type="password" autoComplete="off" value={f.url} onChange={e => onUrl(e.target.value)}
                     placeholder={needSecret ? k.urlHint : `Saved (${editing?.mask}); leave blank to keep`} style={{ ...INPUT, fontFamily: 'var(--font-mono)' }} />
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Saved in the vault. HyperProx never shows it again, only the end of it.</p></div>
            {(f.kind === 'ntfy' || f.kind === 'gotify') && (
              <div><label htmlFor="n-token" style={LABEL}>{f.kind === 'gotify' ? 'Application token' : 'Access token (optional)'}</label>
                <input id="n-token" type="password" autoComplete="off" value={f.token} onChange={e => set('token', e.target.value)}
                       placeholder={editing?.hasToken && !kindChanged ? 'Saved; leave blank to keep' : ''} style={INPUT} />
                {editing?.hasToken && f.kind === 'ntfy' && !kindChanged && (
                  <div className="mt-2"><Toggle id="n-cleartok" checked={f.clearToken} onChange={v => set('clearToken', v)} label="Remove the saved token" /></div>
                )}</div>
            )}
            {f.kind === 'webhook' && (
              <div><label htmlFor="n-sig" style={LABEL}>Signing secret (optional)</label>
                <input id="n-sig" type="password" autoComplete="off" value={f.signingSecret} onChange={e => set('signingSecret', e.target.value)}
                       placeholder={editing?.hasSigningSecret && !kindChanged ? 'Saved; leave blank to keep' : ''} style={INPUT} />
                {editing?.hasSigningSecret && !kindChanged && (
                  <div className="mt-2"><Toggle id="n-clearsig" checked={f.clearSigningSecret} onChange={v => set('clearSigningSecret', v)} label="Remove the signing secret" /></div>
                )}</div>
            )}
          </>
        )}

        <div><label htmlFor="n-sev" style={LABEL}>Send me</label>
          <select id="n-sev" value={f.minSeverity} onChange={e => set('minSeverity', e.target.value as Severity)} style={{ ...INPUT, cursor: 'pointer' }}>
            <option value="critical">Critical only: something is down or about to break</option>
            <option value="warning">Warnings and critical (recommended)</option>
            <option value="info">Everything, including reports that all went well</option>
          </select></div>

        <fieldset className="space-y-2">
          <legend style={LABEL}>About</legend>
          <Toggle id="n-all" checked={f.allEvents} onChange={v => set('allEvents', v)} label="Everything HyperProx reports" />
          {!f.allEvents && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-6">
              {(Object.keys(FAMILY_LABEL) as Family[]).map(fam => (
                <Toggle key={fam} id={`n-fam-${fam}`} checked={f.families.includes(fam)} label={FAMILY_LABEL[fam]}
                        onChange={v => set('families', v ? [...f.families, fam] : f.families.filter(x => x !== fam))} />
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend style={LABEL}>Quiet hours</legend>
          <Toggle id="n-quiet" checked={f.quiet} onChange={v => set('quiet', v)} label="Hold messages during quiet hours, and send one summary when they end" />
          {f.quiet && (
            <div className="space-y-2 pl-6">
              <div className="grid grid-cols-3 gap-2">
                <div><label htmlFor="n-qs" style={LABEL}>From</label><input id="n-qs" type="time" value={f.qStart} onChange={e => set('qStart', e.target.value)} style={INPUT} /></div>
                <div><label htmlFor="n-qe" style={LABEL}>Until</label><input id="n-qe" type="time" value={f.qEnd} onChange={e => set('qEnd', e.target.value)} style={INPUT} /></div>
                <div><label htmlFor="n-qtz" style={LABEL}>Time zone</label><input id="n-qtz" value={f.qTz} onChange={e => set('qTz', e.target.value)} placeholder="server's" style={INPUT} /></div>
              </div>
              <div className="flex flex-wrap gap-3">
                {DAY.map((d, i) => (
                  <Toggle key={d} id={`n-day-${i}`} checked={f.qDays.includes(i)} label={d}
                          onChange={v => set('qDays', v ? [...f.qDays, i].sort() : f.qDays.filter(x => x !== i))} />
                ))}
                <span className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>No day ticked: every day.</span>
              </div>
              <Toggle id="n-qbreak" checked={f.qBreak} onChange={v => set('qBreak', v)} label="Critical messages still come through" />
            </div>
          )}
        </fieldset>

        {k.selfHost && (
          <div className="space-y-1">
            <Toggle id="n-lan" checked={f.lanOverride} onChange={v => set('lanOverride', v)} label="Self-hosted on my network" />
            {f.lanOverride && <Notice kind="warn">Allows a private address. Only use this for a notification server you run yourself; HyperProx will send to whatever answers there.</Notice>}
          </div>
        )}

        <div className="space-y-1">
          <Toggle id="n-private" checked={f.private} onChange={v => set('private', v)} label="Private: only I (or people I trust) read this channel" />
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Only private channels receive VPN sign-in links, which let whoever opens them add a machine to your network.
          </p>
        </div>

        {k.lockedOk && (
          <div className="space-y-1">
            <Toggle id="n-locked" checked={f.usableWhileLocked} onChange={v => set('usableWhileLocked', v)} disabled={!meta.canSetUsableWhileLocked}
                    label={<>Works while HyperProx is locked{!meta.canSetUsableWhileLocked && <span className="text-xs"> (owners only)</span>}</>} />
            {f.usableWhileLocked && lockChange && (
              <Notice kind="warn">
                This takes the {f.kind === 'telegram' ? 'bot token' : 'address'} out of the vault and keeps it in a file on the HyperProx machine,
                so lock alerts can still be sent while everything else is locked. Anyone who can read that file (root on the machine, or a copy of
                its disk or backups) can post to this channel.
                {f.kind === 'telegram' && ' A Telegram bot token controls the whole bot, not just this chat: prefer a bot made only for HyperProx.'}
              </Notice>
            )}
          </div>
        )}

        <Toggle id="n-enabled" checked={f.enabled} onChange={v => set('enabled', v)} label="On (untick to pause this channel)" />

        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !canSave}>{busy ? 'Saving...' : 'Save'}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}

function DeleteModal({ c, onConfirm, onClose }: { c: Channel; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={`Delete "${c.name}"?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          HyperProx stops sending to it and removes its saved address{c.usableWhileLocked ? ' from the lock-alert file' : ' from the vault'}.
          {c.seededFrom === 'lock-alert' && ' This is the channel lock alerts go to; without another one set to work while locked, nobody hears about a lock.'}
        </p>
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={onConfirm} style={{ background: 'var(--crit)', color: 'var(--accent-ink)' }}>Delete</PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

export default function NotificationsPage() {
  const { role } = useSession()
  const canUse = atLeast(role, 'admin')
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [meta, setMeta] = useState<Meta>({ canSetUsableWhileLocked: false, publicUrlSet: true })
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Channel | null | 'new'>(null)
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [justMade, setJustMade] = useState<Channel | null>(null)
  const [toast, setToast] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const load = useCallback(async () => {
    const r = await apiJson<{ channels: Channel[]; meta: Meta }>('/api/settings/notifications/channels')
    if (r.status === 403) { setError('Only owners and admins can manage notifications.'); setChannels([]); return }
    if (!r.ok) { setError(r.error ?? 'Could not load the channels'); setChannels([]); return }
    setError(''); setChannels(r.body?.channels ?? []); if (r.body?.meta) setMeta(r.body.meta)
    const d = await apiJson<{ deliveries: Delivery[] }>('/api/settings/notifications/deliveries?limit=20')
    if (d.ok) setDeliveries(d.body?.deliveries ?? [])
  }, [])
  useEffect(() => { if (role === undefined || canUse) load() }, [load, role, canUse])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flash = (kind: 'info' | 'error', text: string) => {
    setToast({ kind, text }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 6000)
  }

  async function test(c: Channel) {
    setTesting(c.id)
    const r = await apiJson<{ result: { ok: boolean; text: string } }>(`/api/settings/notifications/channels/${encodeURIComponent(c.id)}/test`, 'POST')
    setTesting(null)
    if (r.ok && r.body?.result) flash(r.body.result.ok ? 'info' : 'error', `${c.name}: ${r.body.result.text}`)
    else flash('error', r.error ?? 'Could not send the test')
    setJustMade(null)
    load()
  }

  async function remove(c: Channel) {
    const r = await apiJson(`/api/settings/notifications/channels/${encodeURIComponent(c.id)}`, 'DELETE')
    setDeleting(null)
    if (r.ok) { flash('info', `Deleted "${c.name}".`); load() } else flash('error', r.error ?? 'Could not delete')
  }

  const nameOf = (id: string) => channels?.find(c => c.id === id)?.name ?? 'Former channel'

  const list = channels ?? []
  const failing = list.filter(c => c.failingSince).length
  const on = list.filter(c => c.enabled).length
  const locked = list.filter(c => c.usableWhileLocked).length
  const chips: StatChip[] = [
    { label: 'channels', value: channels ? list.length : '…', tone: 'accent' },
    { label: 'on', value: channels ? on : '…', tone: channels && on ? 'good' : undefined },
    { label: 'failing', value: channels ? failing : '…', tone: failing ? 'crit' : undefined },
    { label: 'work while locked', value: channels ? locked : '…', tone: channels && list.length > 0 && !locked ? 'warn' : undefined },
  ]
  const title = channels === null ? 'Loading channels...'
    : list.length === 0 ? 'No channels yet'
    : failing ? `${failing} channel${failing === 1 ? '' : 's'} failing`
    : `${on} of ${list.length} channel${list.length === 1 ? '' : 's'} on`

  return (
    <Page>
      <HudHeader level={2} label="Notifications overview" icon="alarm"
        eyebrow={<><Link href="/settings" style={{ color: 'inherit' }}>&larr; Settings</Link> · Notifications</>}
        title={title} chips={chips}
        actions={canUse && <PrimaryButton onClick={() => setEditing('new')}>Add a channel</PrimaryButton>}>
        <p className="text-sm max-w-3xl" style={{ margin: 0, color: 'var(--text-soft)' }}>
          Where HyperProx tells you that something needs attention: when it locks itself, when an update run ends, when a certificate
          is about to expire. Messages are short, so they read well on a phone or a watch. Each channel decides how serious a message must
          be, what it is about, and when to stay quiet.
        </p>
      </HudHeader>

      {toast && <Notice kind={toast.kind === 'error' ? 'error' : 'info'}>{toast.text}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {!meta.publicUrlSet && canUse && (
        <Notice kind="info">Messages say which page to open instead of linking to it. Set HYPERPROX_PUBLIC_URL to the address you open HyperProx at for one-tap links.</Notice>
      )}
      {justMade && (
        <Notice kind="info">
          Saved &quot;{justMade.name}&quot;. <button className="underline" onClick={() => test(justMade)} disabled={testing === justMade.id}>Send a test message now</button> to check it arrives.
        </Notice>
      )}

      <Panel title="Channels" sub="where alerts go">
        {channels === null ? (
          <p className={`${ks.empty} animate-pulse`}>Loading channels...</p>
        ) : channels.length === 0 && !error ? (
          <Notice kind="info">No channels yet, so HyperProx tells nobody when something goes wrong. Add one: ntfy is the simplest way to get alerts on a phone.</Notice>
        ) : (
          <ul className={ss.items} aria-label="Notification channels">
            {channels.map(c => {
              const h = channelHealth(c)
              return (
                <li key={c.id} className={ss.item} data-tone={c.failingSince ? 'bad' : undefined} data-dim={c.enabled ? undefined : 'true'}>
                  <div className={ss.itemHead}>
                    <i className={ks.hdot} data-tone={h.tone} aria-hidden />
                    <span className="font-display" style={{ fontWeight: 700, fontSize: 16, letterSpacing: '0.04em', color: 'var(--text-bright)', overflowWrap: 'anywhere', minWidth: 0 }}>{c.name}</span>
                    <span className="font-mono" style={{ marginLeft: 'auto', fontSize: 11, color: h.tone === 'bad' ? 'var(--crit)' : h.tone === 'warn' ? 'var(--warn)' : h.tone === 'good' ? 'var(--good)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h.word}</span>
                  </div>
                  <div className={ss.pills}>
                    <Tag>{KINDS[c.kind]?.label ?? c.kind}</Tag>
                    {!c.enabled && <Tag>Paused</Tag>}
                    {c.usableWhileLocked && <Tag tone="accent">Works while locked</Tag>}
                    {c.lanOverride && <Tag tone="warn">Self-hosted</Tag>}
                    {c.private && <Tag tone="good">Private</Tag>}
                    {c.failingSince && <Tag tone="bad">Failing since {fmt(c.failingSince)}</Tag>}
                  </div>
                  <p className={ss.meta}>{c.secretReadable ? c.mask : 'Saved in the vault'}</p>
                  <p className={ss.said}>
                    {SEVERITY_LABEL[c.minSeverity]} · {eventsText(c.eventFilter)}{quietText(c.quietHours) ? ` · ${quietText(c.quietHours)}` : ''}
                  </p>
                  <p className={ss.meta} style={{ color: c.lastResult && !c.lastResult.ok ? 'var(--crit-soft)' : undefined }} title={exact(c.lastResult?.at)}>
                    {c.lastResult ? `Last: ${c.lastResult.text}, ${inWords(c.lastResult.at) ?? fmt(c.lastResult.at)}` : 'Nothing sent yet'}
                  </p>
                  {canUse && (
                    <div className={ss.acts}>
                      <button type="button" onClick={() => test(c)} disabled={testing === c.id || !c.secretReadable} className={ss.mini} data-tone="accent"
                              aria-label={`Send a test to ${c.name}`}>{testing === c.id ? 'Sending...' : 'Send test'}</button>
                      <button type="button" onClick={() => setEditing(c)} className={ss.mini} aria-label={`Edit ${c.name}`}>Edit</button>
                      <button type="button" onClick={() => setDeleting(c)} className={ss.mini} data-tone="bad" aria-label={`Delete ${c.name}`}>Delete</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {role && !canUse && <div style={{ marginTop: 12 }}><Notice kind="info">Only owners and admins can manage notifications.</Notice></div>}
        <p className="text-xs" style={{ margin: '12px 0 0', color: 'var(--text-muted)' }}>
          A channel that keeps failing is reported on the other channels. At most six messages go to one channel in ten minutes; past that,
          one &quot;many alerts at once&quot; message, and the rest is here in HyperProx.
        </p>
      </Panel>

      {deliveries.length > 0 && (
        <>
          <Panel title="Recent messages" sub={`last ${deliveries.length}`}>
            <Feed label="Recent messages" items={deliveries.map(d => ({
              key: d.id, tone: deliveryTone(d.status), title: d.title, detail: <span style={{ color: d.status === 'failed' ? 'var(--crit-soft)' : undefined }}>· {d.text}</span>,
              meta: `${nameOf(d.channelId)} · ${inWords(d.createdAt) ?? fmt(d.createdAt)}`,
            }))} />
          </Panel>
          <Details summary="Details" sub="recent messages, exact times">
            <div className={ks.tableWrap}>
              <table className={ks.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Channel</th>
                    <th>Message</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map(d => (
                    <tr key={d.id}>
                      <td className="whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{fmt(d.createdAt)}</td>
                      <td style={{ color: 'var(--text-soft)' }}>{nameOf(d.channelId)}</td>
                      <td style={{ color: 'var(--text-bright)' }}>{d.title}</td>
                      <td style={{ color: d.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-soft)' }}>{d.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Details>
        </>
      )}

      {editing && (
        <ChannelModal
          editing={editing === 'new' ? null : editing}
          meta={meta}
          onClose={() => setEditing(null)}
          onSaved={(c, created) => { setEditing(null); if (created) setJustMade(c); else flash('info', `Saved "${c.name}".`); load() }}
        />
      )}
      {deleting && <DeleteModal c={deleting} onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)} />}
    </Page>
  )
}
