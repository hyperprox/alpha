'use client'

import type { UpdatesPolicyStatus } from '@hyperprox/types'
import { Badge, Btn, Icon, Notice, fmtTime } from './ui'

export function PolicyStrip({ policy, error, busy, activeJob, onRefresh, onRun, refreshing }: {
  policy: UpdatesPolicyStatus | null
  error: string | null
  busy: boolean             // a request from this page is in flight
  activeJob: boolean
  refreshing: boolean
  onRefresh: () => void
  onRun: (mode: 'run' | 'dry-run') => void
}) {
  const loaded = !!policy?.loaded
  const why = !loaded ? 'Runs are disabled until the policy file loads.' : activeJob ? 'A job is already active.' : undefined
  // A dry run executes nothing, so it works without a policy file (it plans with the safe defaults).
  const dryWhy = activeJob ? 'A job is already active.' : undefined
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] border px-5 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex flex-wrap items-center gap-2">
          {policy ? (
            <>
              <Badge tone={loaded ? 'good' : 'warn'}>{loaded ? 'policy loaded' : 'policy not loaded'}</Badge>
              <Badge tone={policy.schedule.enabled ? 'accent' : 'muted'}>{policy.schedule.enabled ? 'schedule on' : 'schedule off'}</Badge>
              {policy.schedule.enabled && (
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span title={policy.schedule.cron}>next {fmtTime(policy.schedule.nextRun)}</span>
                  <span style={{ color: 'var(--text-dimmer)' }}> · window {policy.schedule.windowHours}h</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{error ? 'Policy status unavailable' : 'Reading policy...'}</span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span title={activeJob ? 'The running job keeps the inventory current.' : undefined}>
            <Btn onClick={onRefresh} disabled={refreshing || activeJob}><Icon name="refresh" />{refreshing ? 'Refreshing...' : 'Refresh'}</Btn>
          </span>
          <span title={dryWhy}>
            <Btn onClick={() => onRun('dry-run')} disabled={activeJob || busy}><Icon name="dry" />Dry run</Btn>
          </span>
          <span title={why}>
            <Btn kind="primary" onClick={() => onRun('run')} disabled={!loaded || activeJob || busy}><Icon name="play" />Run updates</Btn>
          </span>
        </div>
      </div>
      {error && <Notice tone="crit">{error}</Notice>}
      {policy && !loaded && (
        <Notice tone="warn">
          Runs are disabled until <span className="font-mono">config/updates.yaml</span> exists and validates; a dry run
          still works and plans with the built-in safe defaults. Copy{' '}
          <span className="font-mono">config/updates.example.yaml</span> and edit it for this cluster.
          {policy.error && <div className="mt-1 font-mono text-xs">{policy.error}</div>}
          <div className="mt-1 font-mono text-xs" style={{ opacity: 0.8 }}>{policy.path}</div>
        </Notice>
      )}
    </div>
  )
}
