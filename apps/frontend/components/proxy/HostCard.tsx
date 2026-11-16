// A proxy host as a card: its domain, provider and state, certificate status in words, the flow
// domain → proxy → upstream, and (for admins, on hosts HyperProx may change) Edit, On/Off and Delete.
// The card owns no requests: the page opens the editor or asks for a preview, as it always did.

import { alpha } from '@/lib/theme'
import { Pill, type PillTone } from '@/components/visual/kit'

export type Kind = 'npm' | 'traefik' | 'caddy' | 'haproxy' | 'pangolin' | 'nginx'

export interface HostView {
  id: string; instanceId: string; instanceName: string; kind: Kind
  domains: string[]; forwardScheme: 'http' | 'https'; forwardHost: string; forwardPort: number
  enabled: boolean; readOnly: boolean; readOnlyReason?: string
  tls: { kind: 'none' | 'certificate' | 'auto'; certificateId?: string; expiresAt?: string | null; forced?: boolean }
  online?: boolean | null; websockets?: boolean; detail?: string; native?: Record<string, any>
}

export type HostAction = 'enable' | 'disable' | 'delete'

export const KIND_SHORT: Record<Kind, string> = { npm: 'NPM', traefik: 'Traefik', caddy: 'Caddy', haproxy: 'HAProxy', pangolin: 'Pangolin', nginx: 'NGINX' }
export const KIND_COLOR: Record<Kind, string> = { npm: 'var(--accent)', traefik: 'var(--accent-2)', caddy: 'var(--good)', haproxy: 'var(--violet-2)', pangolin: 'var(--warn-2)', nginx: 'var(--good-2, var(--good))' }

export function daysLeft(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso.replace(' ', 'T'))
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86_400_000) : null
}

export function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span title={title} className="font-mono px-1.5 py-0.5 rounded whitespace-nowrap" style={{
      fontSize: 10, background: `${alpha(color, 8)}`, color, border: `1px solid ${alpha(color, 19)}`,
    }}>{label}</span>
  )
}

/** The request the page sends to preview an on/off/delete on a host (the plan dialog is the confirmation). */
export function hostActionRequest(h: Pick<HostView, 'id' | 'instanceId'>, action: HostAction): { url: string; init: RequestInit } {
  return { url: `/api/proxy/instances/${h.instanceId}/preview`, init: { method: 'POST', body: JSON.stringify({ action, hostId: h.id }) } }
}

const ACTION_BTN = { minHeight: 32, padding: '2px 12px', fontSize: 13, borderRadius: 6, background: 'transparent' } as const

/** A host as a card. Viewers get no actions; a host made outside HyperProx says read-only and offers none. */
export function HostCard({ h, admin, onEdit, onAction }: {
  h: HostView; admin: boolean; onEdit: (h: HostView) => void; onAction: (h: HostView, a: HostAction) => void
}) {
  const days = daysLeft(h.tls.expiresAt)
  const state: { text: string; tone: PillTone | undefined } = !h.enabled ? { text: 'off', tone: undefined }
    : h.online === false ? { text: 'not answering', tone: 'warn' } : { text: 'live', tone: 'good' }
  const tls: { text: string; tone: PillTone | undefined } = h.tls.kind === 'none' ? { text: 'no TLS', tone: undefined }
    : days !== null && days < 0 ? { text: 'cert expired', tone: 'bad' }
    : days !== null && days < 30 ? { text: `TLS ${days}d left`, tone: 'warn' }
    : { text: h.tls.kind === 'auto' ? 'auto TLS' : 'TLS ok', tone: 'good' }
  const upstream = h.forwardHost ? `${h.forwardHost}:${h.forwardPort}` : null
  const name = h.domains[0] ?? 'host without a domain'
  const canAct = admin && !h.readOnly
  return (
    <li className="rounded-lg p-3" data-enabled={h.enabled} style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-soft)', minWidth: 0, opacity: h.enabled ? 1 : 0.75, display: 'flex', flexDirection: 'column' }}>
      <div className="flex items-start gap-2">
        <div className="font-mono text-sm flex-1" style={{ color: 'var(--text-bright)', overflowWrap: 'anywhere', minWidth: 0 }}>
          {h.domains[0] ?? <span style={{ color: 'var(--text-dim)' }}>(no Host rule)</span>}
          {h.domains.length > 1 && <div className="text-xs" style={{ color: 'var(--text-dim)' }} title={h.domains.join(', ')}>+{h.domains.length - 1} more</div>}
        </div>
        <Badge label={KIND_SHORT[h.kind]} color={KIND_COLOR[h.kind]} title={h.instanceName} />
      </div>
      <div className="flex gap-1.5 flex-wrap mt-2">
        <Pill tone={state.tone}>{state.text}</Pill>
        <Pill tone={tls.tone} title={days !== null ? `Certificate: ${days} days left` : undefined}>{tls.text}</Pill>
        {days !== null && h.tls.kind !== 'none' && <span className="text-xs font-mono self-center" style={{ color: days < 14 ? 'var(--crit-2)' : 'var(--text-dim)' }}>{days}d</span>}
        {h.readOnly && <Pill title={h.readOnlyReason ?? 'Made outside HyperProx; never rewritten'}>read-only</Pill>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-2 font-mono text-xs" style={{ color: 'var(--text-soft)' }} aria-label={`Flow: domain to ${h.instanceName} to ${upstream ?? 'no upstream'}`}>
        <span>domain</span><span aria-hidden style={{ color: 'var(--accent)' }}>→</span>
        <span title={KIND_SHORT[h.kind]}>{h.instanceName}</span><span aria-hidden style={{ color: 'var(--accent)' }}>→</span>
        <span style={{ overflowWrap: 'anywhere' }}>{upstream ? `${h.forwardScheme}://${upstream}` : 'no upstream'}</span>
      </div>
      {h.detail && h.kind !== 'npm' && <div className="text-xs font-mono truncate mt-1" style={{ color: 'var(--text-dim)' }} title={h.detail}>{h.detail}</div>}
      {canAct && (
        <div className="flex items-center gap-2 flex-wrap mt-3 pt-3" role="group" aria-label={`Actions for ${name}`} style={{ borderTop: '1px solid var(--border-soft)' }}>
          <button type="button" onClick={() => onEdit(h)} aria-label={`Edit ${name}`} style={{ ...ACTION_BTN, color: 'var(--accent)', border: '1px solid var(--accent)' }}>Edit</button>
          <button type="button" onClick={() => onAction(h, h.enabled ? 'disable' : 'enable')} aria-label={`${h.enabled ? 'Turn off' : 'Turn on'} ${name}`}
            style={{ ...ACTION_BTN, color: h.enabled ? 'var(--crit)' : 'var(--good)', border: `1px solid ${h.enabled ? 'var(--crit)' : 'var(--good)'}` }}>{h.enabled ? 'Off' : 'On'}</button>
          <button type="button" onClick={() => onAction(h, 'delete')} aria-label={`Delete ${name}`} className="ml-auto"
            style={{ ...ACTION_BTN, color: 'var(--text-dim)', border: '1px solid var(--border-strong)' }}>Delete</button>
        </div>
      )}
    </li>
  )
}
