'use client'

import type { CertsPolicyStatus } from '@hyperprox/types'
import { Badge, Btn, Icon, Notice, StagingBadge, fmtDateTime } from './ui'

export function PolicyStrip({ policy, error, checkedAt, refreshing, onCheck }: {
  policy: CertsPolicyStatus | null
  error: string | null
  checkedAt: string | null
  refreshing: boolean
  onCheck: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] border px-5 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex flex-wrap items-center gap-2">
          {policy ? (
            <>
              <Badge tone={policy.loaded ? 'good' : 'warn'}>{policy.loaded ? 'policy loaded' : 'policy not loaded'}</Badge>
              {policy.loaded && (
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }} title={policy.acme.email ? `ACME contact ${policy.acme.email}` : undefined}>
                  ACME {policy.acme.directory}
                </span>
              )}
              {policy.loaded && policy.acme.staging && <StagingBadge />}
              {policy.loaded && (
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span title={policy.schedule.cron}>next check {fmtDateTime(policy.schedule.nextRun)}</span>
                </span>
              )}
              {checkedAt && <span className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>last probed {fmtDateTime(checkedAt)}</span>}
            </>
          ) : (
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{error ? 'Policy status unavailable' : 'Reading policy...'}</span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Btn onClick={onCheck} disabled={refreshing}><Icon name="refresh" />{refreshing ? 'Checking...' : 'Check now'}</Btn>
        </div>
      </div>
      {error && <Notice tone="crit">{error}</Notice>}
      {policy && !policy.loaded && (
        <Notice tone="warn">
          Monitoring works without a policy file, but nothing can be issued until <span className="font-mono">config/certs.yaml</span> exists
          and validates. Copy <span className="font-mono">config/certs.example.yaml</span> and edit it for this network.
          {policy.error && <div className="mt-1 font-mono text-xs">{policy.error}</div>}
          <div className="mt-1 font-mono text-xs" style={{ opacity: 0.8 }}>{policy.path}</div>
        </Notice>
      )}
    </div>
  )
}
