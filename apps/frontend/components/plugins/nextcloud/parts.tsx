'use client'

// =============================================================================
//  HyperProx — Nextcloud page: the pieces, drawn from props only
//
//  Each setup warning is a card that glows in its severity and carries its own
//  action: a fix button, a guided step, or an "optional" note with snooze.
//  Colour is never the only signal: every card says its severity and its kind
//  of action in words.
// =============================================================================

import type { ReactNode } from 'react'
import { Feed, Icon, Pill, RingGauge, styles as vs } from '@/components/visual/kit'
import n from './nextcloud.module.css'
import {
  KIND_WORD, LEVEL_WORD, SEVERITY_TONE, SEVERITY_WORD, bytesWords, deploymentWords, groupChecks, hourWords, sinceWords,
  type Check, type Job, type Reading, type UpdatePreview,
} from './logic'

export type OnAct = (c: Check) => void

const SEV_ICON = { error: 'error', warning: 'warn', info: 'plugin', success: 'check' } as const

export function CheckCard({ c, admin, busy, onAct, onSnooze }: { c: Check; admin: boolean; busy: boolean; onAct: OnAct; onSnooze: (c: Check, days: number | 'forever' | 0) => void }) {
  const r = c.remedy
  return (
    <article className={n.check} data-sev={c.severity} data-kind={r.kind} aria-label={`${SEVERITY_WORD[c.severity].replace(/s$/, '')}: ${c.name}`}>
      <header className={n.checkHead}>
        <span className={n.sevIcon} aria-hidden><Icon name={SEV_ICON[c.severity]} size={15} /></span>
        <b className={n.checkName}>{c.name}</b>
        <Pill tone={r.kind === 'fix' ? 'accent' : r.kind === 'optional' ? 'violet' : undefined}>{KIND_WORD[r.kind]}</Pill>
        {r.kind === 'fix' && r.secure && <Pill tone="warn" title="Needs the master password">master password</Pill>}
      </header>
      <p className={n.checkText}>{c.description}</p>
      {r.kind === 'fix' && r.note && <p className={n.note}>{r.note}</p>}
      {r.kind === 'guided' && <p className={n.note}>{r.why}</p>}
      {r.kind === 'optional' && (
        <dl className={n.optional}>
          <dt>What it gives you</dt><dd>{r.gives}</dd>
          <dt>What it needs</dt><dd>{r.needs}</dd>
        </dl>
      )}
      <div className={n.acts}>
        {admin && r.kind === 'fix' && <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy} onClick={() => onAct(c)}><Icon name="check" size={14} /> {r.label}</button>}
        {admin && r.kind === 'guided' && <button type="button" className={vs.btn} disabled={busy} onClick={() => onAct(c)}><Icon name="run" size={14} /> {r.label}</button>}
        {c.doc && <a className={n.doc} href={c.doc} target="_blank" rel="noreferrer noopener">Nextcloud&apos;s docs</a>}
        {admin && (
          <span className={n.snooze}>
            <button type="button" className={n.link} onClick={() => onSnooze(c, 7)}>Snooze 7 d</button>
            <button type="button" className={n.link} onClick={() => onSnooze(c, 30)}>30 d</button>
            {r.kind === 'optional' && <button type="button" className={n.link} onClick={() => onSnooze(c, 'forever')}>Dismiss</button>}
          </span>
        )}
      </div>
    </article>
  )
}

export function CheckGroups({ checks, admin, busy, onAct, onSnooze }: { checks: Check[]; admin: boolean; busy: boolean; onAct: OnAct; onSnooze: (c: Check, days: number | 'forever' | 0) => void }) {
  const g = groupChecks(checks)
  return (
    <div className={n.groups}>
      {!g.groups.length && <p className={n.allClear}><Icon name="check" size={16} /> Every setup check passes.</p>}
      {g.groups.map(grp => (
        <section key={grp.severity} aria-label={SEVERITY_WORD[grp.severity]}>
          <h3 className={n.groupHead} data-sev={grp.severity}>{SEVERITY_WORD[grp.severity]} <small>{grp.checks.length}</small></h3>
          <div className={n.cards}>{grp.checks.map(c => <CheckCard key={c.id} c={c} admin={admin} busy={busy} onAct={onAct} onSnooze={onSnooze} />)}</div>
        </section>
      ))}
      {g.snoozed.length > 0 && (
        <details className={n.folded}>
          <summary>Snoozed or dismissed · {g.snoozed.length}</summary>
          <ul>{g.snoozed.map(c => (
            <li key={c.id}>{c.name} <small>{c.snoozed === 'forever' ? 'dismissed' : `until ${c.snoozed!.slice(0, 10)}`}</small>
              {admin && <button type="button" className={n.link} onClick={() => onSnooze(c, 0)}>Bring back</button>}</li>
          ))}</ul>
        </details>
      )}
      {g.quiet.length > 0 && (
        <details className={n.folded}>
          <summary>Not problems here · {g.quiet.length}</summary>
          <ul>{g.quiet.map(c => <li key={c.id}>{c.name} <small>{c.remedy.kind === 'none' ? c.remedy.why : ''}</small></li>)}</ul>
        </details>
      )}
    </div>
  )
}

/** Current version → available version, as a track with a moving marker; the update button under it. */
export function VersionTrack({ r, admin, busy, onUpdate }: { r: Reading; admin: boolean; busy: boolean; onUpdate: () => void }) {
  const from = r.status?.versionString ?? '?'
  const to = r.update.core
  return (
    <div className={n.track} data-update={to ? 'yes' : 'no'}>
      <div className={n.ver}><small>running</small><b>{from}</b></div>
      <div className={n.rail} aria-hidden><i /></div>
      <div className={n.ver} data-next><small>{to ? 'available' : 'newest'}</small><b>{to ?? from}</b></div>
      <p className={n.trackNote}>
        {to ? `Nextcloud ${to} is out.` : 'Up to date.'} {deploymentWords(r.deployment)}.
        {r.update.webUpdaterDisabled ? ' The web updater is off here, so an update is a new image.' : ''}
      </p>
      {admin && to && (
        <div className={n.acts}>
          {r.deployment?.kind === 'compose'
            ? <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy} onClick={onUpdate}><Icon name="run" size={14} /> Check and update to {to}</button>
            : <button type="button" className={vs.btn} disabled={busy} onClick={onUpdate}>How to update it</button>}
        </div>
      )}
    </div>
  )
}

/** The update check: every refusal reason, the warnings, where the dump goes, the steps and the rollback. */
export function UpdateCheckView({ p }: { p: UpdatePreview }) {
  return (
    <div className={n.preview}>
      <p className={n.previewHead}>Nextcloud <b>{p.from ?? '?'}</b> → <b>{p.to ?? '?'}</b>{p.source ? <> · {p.source === 'build' ? 'rebuilt from your Dockerfile with --pull' : 'new image pulled'}</> : null}</p>
      {p.problems.length > 0 && (
        <div role="alert">
          <b className={n.refuse}>Not now:</b>
          <ul className={n.problems}>{p.problems.map(x => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {p.warnings.length > 0 && <ul className={n.warnings}>{p.warnings.map(x => <li key={x}>{x}</li>)}</ul>}
      <dl className={n.facts}>
        <dt>People online</dt><dd>{p.activeUsers === null ? 'could not tell' : p.activeUsers === 0 ? 'nobody (HyperProx\'s own login is not counted)' : p.activeUsers}</dd>
        <dt>Talk calls</dt><dd>{p.activeCalls === null ? '—' : p.activeCalls === 0 ? 'none' : p.activeCalls}</dd>
        <dt>Database dump</dt><dd className={n.mono}>{p.backupDir ?? '—'}</dd>
      </dl>
      {p.snapshotNote && <p className={n.snapNote}><Icon name="warn" size={14} /> {p.snapshotNote}</p>}
      {!p.snapshotNote && <p className={n.note}>Take a Proxmox snapshot of the guest first if you can; HyperProx&apos;s own rollback is the database dump plus the previous image, kept under a hyperprox-pre tag.</p>}
      <ol className={n.steps}>{p.steps.map(s => <li key={s}>{s}</li>)}</ol>
      {p.rollback && <details className={n.folded}><summary>How to roll back</summary><pre className={n.pre}>{p.rollback}</pre></details>}
    </div>
  )
}

const STEP_WORD = { pending: 'waiting', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped' } as const

/** A background job: its steps as a vertical rail, the newest output lines, and the result. */
export function JobView({ job, onStopWatching }: { job: Job; onStopWatching?: () => void }) {
  return (
    <div className={n.job} data-state={job.state} aria-live="polite">
      <ol className={n.rail2} aria-label="Steps">
        {job.steps.map(s => (
          <li key={s.key} data-state={s.state}>
            <span className={n.dot} aria-hidden />
            <b>{s.label}</b> <small>{STEP_WORD[s.state]}{s.detail ? ` · ${s.detail}` : ''}</small>
          </li>
        ))}
      </ol>
      {job.lines.length > 0 && <pre className={n.pre} aria-label="Output">{job.lines.slice(-14).join('\n')}</pre>}
      {job.maintenance && <p className={job.maintenance === 'on' ? n.snapNote : n.note}>Maintenance mode: {job.maintenance === 'on' ? 'ON (people see the maintenance page)' : job.maintenance === 'off' ? 'off' : 'could not be read'}</p>}
      {job.detached && job.state === 'running' && <p className={n.note}>It runs inside the guest, so it keeps going if this page closes or HyperProx restarts. Its log: <span className={n.mono}>{job.detached.backupDir}/jobs/{job.id}/log</span></p>}
      {job.result && <p className={n.result} data-state={job.state} role="status">{job.result}</p>}
      {job.state === 'problems' && <p className={n.snapNote} role="alert"><Icon name="warn" size={14} /> Finished with problems: check Nextcloud before relying on it.</p>}
      {(job.state === 'failed' || job.state === 'problems') && job.rollback && <details className={n.folded} open><summary>How to roll back</summary><pre className={n.pre}>{job.rollback}</pre></details>}
      {job.state === 'running' && onStopWatching && (
        <div className={n.acts}><button type="button" className={n.link} onClick={onStopWatching}>Stop watching this job (it may still be running in the guest)</button></div>
      )}
    </div>
  )
}

/** Talk: the signalling server's version and image, live calls, and the three parts of Client Push. */
export function TalkView({ r, admin, busy, onHpb, onPush }: { r: Reading; admin: boolean; busy: boolean; onHpb: () => void; onPush: () => void }) {
  const t = r.talk
  const push: Array<[string, boolean, string]> = [
    ['App', t.push.app === 'enabled', t.push.app === 'enabled' ? 'installed' : t.push.app === 'disabled' ? 'installed, off' : 'not installed'],
    ['Daemon', t.push.daemon === 'running', t.push.daemon === 'running' ? 'running' : t.push.daemon === 'stopped' ? 'stopped' : 'not found'],
    ['Address', !!t.push.endpoint, t.push.endpoint ?? 'not set'],
  ]
  return (
    <div className={n.talk}>
      <article className={n.tcard} data-ok={t.hpb && !t.hpb.missing.length ? 'yes' : 'no'}>
        <h3>High-performance backend</h3>
        {t.hpb ? (
          <>
            <p className={n.big}>{t.hpb.version ?? 'unknown version'}</p>
            {t.hpb.image && <small className={n.mono}>{t.hpb.image}</small>}
            {t.hpb.missing.length > 0 && <p className={n.warnLine}>Talk wants features it lacks: {t.hpb.missing.join(', ')}. A newer signalling release adds them.</p>}
            {admin && t.hpb.container && <div className={n.acts}><button type="button" className={vs.btn} disabled={busy} onClick={onHpb}><Icon name="run" size={14} /> Pull the newest and recreate</button></div>}
          </>
        ) : <p className={n.note}>No signalling server is configured: Talk relays calls peer to peer, which works for a few people.</p>}
        <small className={n.calls}>{t.activeCalls === null ? '' : t.activeCalls === 0 ? 'No call running' : `${t.activeCalls} call${t.activeCalls === 1 ? '' : 's'} running`}</small>
      </article>
      <article className={n.tcard} data-ok={push.every(p => p[1]) ? 'yes' : 'no'}>
        <h3>Client Push</h3>
        <ol className={n.pushSteps}>{push.map(([k, ok, w]) => <li key={k} data-ok={ok ? 'yes' : 'no'}><b>{k}</b> <small>{w}</small></li>)}</ol>
        {admin && !push.every(p => p[1]) && <div className={n.acts}><button type="button" className={vs.btn} disabled={busy} onClick={onPush}><Icon name="run" size={14} /> Set up Client Push</button></div>}
      </article>
    </div>
  )
}

/** PHP, database, users, storage, background jobs: small dials and facts. */
export function SystemView({ r }: { r: Reading }) {
  const s = r.server
  const cronOk = r.background.mode === 'cron'
  const lastMin = r.background.lastRun ? (Date.now() / 1000 - r.background.lastRun) / 60 : null
  return (
    <div className={n.system}>
      <div className={n.dial}>
        <RingGauge value={lastMin === null ? 0 : Math.max(0.05, 1 - Math.min(1, lastMin / 60))} text={r.background.mode.toUpperCase()} label="background jobs" size={96} color={cronOk ? 'var(--hx-accent)' : 'var(--warn)'} />
        <small>last run {sinceWords(r.background.lastRun)}</small>
      </div>
      <dl className={n.facts}>
        <dt>PHP</dt><dd>{r.php ?? '—'}{s?.php.memoryLimit ? ` · ${bytesWords(s.php.memoryLimit)} memory` : ''}</dd>
        <dt>Database</dt><dd>{[s?.db.type ?? r.deployment?.db?.engine, r.dbVersion].filter(Boolean).join(' ') || '—'}{s?.db.size ? ` · ${bytesWords(s.db.size)}` : ''}</dd>
        <dt>Users</dt><dd>{r.users.total ?? s?.storage.users ?? '—'}{r.users.disabled ? ` (${r.users.disabled} disabled)` : ''}{s?.activeUsers.last24hours != null ? ` · ${s.activeUsers.last24hours} active today` : ''}</dd>
        <dt>Files</dt><dd>{s?.storage.files != null ? s.storage.files.toLocaleString('en') : '—'}{s?.storage.freeSpace != null ? ` · ${bytesWords(s.storage.freeSpace)} free` : ''}</dd>
        <dt>Apps</dt><dd>{r.apps.enabled} on{r.apps.exApps ? ` · ${r.apps.exApps} External Apps` : ''}</dd>
        <dt>Maintenance</dt><dd>{r.config.maintenanceWindowStart === null ? 'no window set' : `from ${hourWords(r.config.maintenanceWindowStart)}`}</dd>
      </dl>
      {!s && <p className={n.note}>Add the optional web login (an app password) in Settings for storage, active users and PHP limits.</p>}
    </div>
  )
}

export function LogView({ entries }: { entries: Reading['log'] }) {
  if (!entries) return <p className={n.note}>The log is shown to admins.</p>
  if (!entries.length) return <p className={n.note}>No warnings or errors in the recent log.</p>
  return (
    <Feed label="Recent warnings and errors" items={entries.slice(0, 15).map((e, i) => ({
      key: `${e.time}${i}`, tone: e.level >= 3 ? 'bad' : 'warn',
      title: e.message, meta: `${LEVEL_WORD[e.level] ?? e.level} · ${e.app} · ${e.time.replace('T', ' ').slice(0, 16)}`,
    }))} />
  )
}

export function Steps({ items }: { items: ReactNode[] }) {
  return <ol className={n.steps}>{items.map((x, i) => <li key={i}>{x}</li>)}</ol>
}
