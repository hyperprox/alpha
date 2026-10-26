'use client'

import type { CertsManaged } from '@hyperprox/types'
import { Badge, Btn, Empty, Icon, Notice, StagingBadge, VerdictBadge, fmtDate, fmtDateTime } from './ui'

const STATUS_TONE: Record<CertsManaged['status'], 'accent' | 'good' | 'warn' | 'crit' | 'muted'> = {
  pending: 'muted', valid: 'good', renewing: 'accent', failed: 'crit',
}

/** Never issued: there is nothing to renew, and the first issuance is the one that publishes the names. */
export const neverIssued = (m: CertsManaged) => !m.notAfter

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--text-dimmer)' }}>{label}</dt>
      <dd className="mt-0.5 text-sm" style={{ color: 'var(--text)' }}>{children}</dd>
    </div>
  )
}

function Card({ m, busy, onIssue, onDeploy }: { m: CertsManaged; busy: boolean; onIssue: (m: CertsManaged) => void; onDeploy: (m: CertsManaged) => void }) {
  const renewing = m.status === 'renewing'
  const first = neverIssued(m)
  const unmanaged = m.dns.filter(d => !d.zone)
  const lock = busy || renewing
  return (
    <div className="space-y-4 rounded-[10px] border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display font-semibold" style={{ fontSize: 20, color: 'var(--text-bright)' }}>{m.label}</h3>
        <Badge tone={STATUS_TONE[m.status]}>{renewing ? 'renewing...' : m.status}</Badge>
        {m.staging && <StagingBadge />}
        <div className="ml-auto flex flex-wrap gap-2">
          <Btn kind="primary" small onClick={() => onIssue(m)} disabled={lock || unmanaged.length > 0}
               title={unmanaged.length > 0 ? 'DNS provider not managed for a name.' : undefined}>
            <Icon name="play" />{first ? 'Issue' : 'Renew now'}
          </Btn>
          <Btn small onClick={() => onDeploy(m)} disabled={lock || first} title={first ? 'Nothing to deploy until a certificate has been issued.' : undefined}>
            <Icon name="deploy" />Deploy again
          </Btn>
        </div>
      </div>

      {m.lastError && <Notice tone="crit">Last attempt failed: <span className="font-mono text-xs">{m.lastError}</span></Notice>}

      <div>
        <h4 className="mb-1 font-mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--text-dimmer)' }}>NAMES AND DNS ZONES</h4>
        <ul className="space-y-1 text-sm">
          {m.dns.length === 0 && m.names.map(n => <li key={n} className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{n}</li>)}
          {m.dns.map(d => (
            <li key={d.name} className="flex flex-wrap items-center gap-x-2">
              <span className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{d.name}</span>
              {d.zone
                ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>zone <span className="font-mono">{d.zone}</span>{d.provider && <> via {d.provider}</>}</span>
                : <span className="text-xs font-semibold" style={{ color: 'var(--warn)' }}>DNS provider not managed</span>}
            </li>
          ))}
        </ul>
        {unmanaged.length > 0 && (
          <div className="mt-2">
            <Notice tone="warn">
              {unmanaged.length === 1 ? 'This name is' : 'These names are'} not in a zone the DNS integration serves (its DNS may be hosted elsewhere), so an order would fail before any record is written.
              Issuing is blocked until the zone is served by the DNS integration.
            </Notice>
          </div>
        )}
      </div>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="ISSUER">{m.issuer ?? '—'}</Field>
        <Field label="VALID">{m.notAfter ? `${fmtDate(m.notBefore)} to ${fmtDate(m.notAfter)}` : '—'}</Field>
        <Field label="RENEW AFTER">{fmtDateTime(m.renewAfter)}</Field>
        <Field label="CA RENEWAL WINDOW (ARI)">
          {m.ariStart && m.ariEnd ? `${fmtDateTime(m.ariStart)} to ${fmtDateTime(m.ariEnd)}` : <span style={{ color: 'var(--text-muted)' }}>not offered, using two thirds of the lifetime</span>}
        </Field>
      </dl>

      <div>
        <h4 className="mb-1 font-mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--text-dimmer)' }}>TARGETS</h4>
        {m.targets.length === 0 ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No deploy targets. The certificate is issued and kept, not delivered.</p> : (
          <ul className="space-y-1.5">
            {m.targets.map(t => (
              <li key={t.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <VerdictBadge verdict={t.verdict} />
                <span className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{t.name}</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t.kind === 'hyperprox' ? 'HyperProx front door' : 'files in a guest'}
                  {' · '}{t.lastDeployAt ? `deployed ${fmtDateTime(t.lastDeployAt)}` : 'never deployed'}
                  {t.lastResult && <> · {t.lastResult}</>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function ManagedList({ items, busy, onIssue, onDeploy }: {
  items: CertsManaged[]; busy: boolean; onIssue: (m: CertsManaged) => void; onDeploy: (m: CertsManaged) => void
}) {
  if (!items.length) return <Empty>No managed certificates. Define them under <span className="font-mono">certificates:</span> in <span className="font-mono">config/certs.yaml</span>.</Empty>
  return <div className="space-y-4 p-5">{items.map(m => <Card key={m.label} m={m} busy={busy} onIssue={onIssue} onDeploy={onDeploy} />)}</div>
}
