'use client'

// =============================================================================
//  HyperProx — plug-in pages, drawn from each plug-in's `visual` numbers
//
//  Plex, Arr Stack, Unmanic, MikroTik and MeshCentral. Each view takes the
//  typed reading its plug-in's detail() returned and nothing else; the old
//  tables stay in the page's Details section below. Nothing here writes,
//  except the Arr Stack's existing "Map by filename" rescue, passed in by the
//  page and confirmed there.
// =============================================================================

import type { ArrVisual, MeshVisual, PlexVisual, RouterVisual, UnmanicVisual } from '@hyperprox/types'
import type { CSSProperties, ReactNode } from 'react'
import {
  Cols, FlowPipeline, GlowBars, Icon, Panel, ProgressBar, RingGauge, SemiGauge, StatusDots, Timeline, Topology,
  bytes, duration, mbps, niceMax, rate, styles as s, type StatChip,
} from '@/components/visual/kit'
import pg from './pages.module.css'

// ── Plex ─────────────────────────────────────────────────────────────────────

/** A poster block made from the title itself: same title, same colours, no image fetched from anywhere. */
function posterStyle(title: string): CSSProperties {
  let h = 0
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const palette = ['var(--crit-2)', 'var(--violet)', 'var(--warn-2)', 'var(--good)', 'var(--accent)', 'var(--violet-2)']
  return {
    ['--pc1' as any]: palette[h % palette.length], ['--pc2' as any]: palette[(h >> 3) % palette.length],
    ['--px' as any]: `${30 + (h % 50)}%`, ['--py' as any]: `${40 + ((h >> 5) % 40)}%`,
  }
}

export function plexChips(v: PlexVisual): StatChip[] {
  return [
    { label: 'watching now', value: v.counts.streams, tone: 'accent' },
    { label: 'transcoding', value: v.counts.transcodes, tone: v.counts.transcodes > 1 ? 'warn' : undefined },
    { label: 'direct play', value: v.counts.direct, tone: 'good' },
    { label: 'Mbps total', value: v.bandwidth.totalMbps },
  ]
}

export function PlexView({ v }: { v: PlexVisual }) {
  const when = (at: number | null) => at ? new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
  return (
    <>
      <Cols>
        <Panel title="Now streaming" sub={v.sessions.length ? 'LIVE' : undefined}>
          {v.sessions.length === 0 && <p className={s.empty}>Nobody is watching anything right now.</p>}
          {v.sessions.map((x, i) => (
            <article key={`${x.user}-${x.title}-${i}`} className={pg.np} aria-label={`${x.user} watching ${x.title}`}>
              <div className={pg.poster} style={posterStyle(x.title)} aria-hidden><span>{x.title}</span></div>
              <div className={pg.npInfo}>
                <h3>{x.title}{x.year && !x.episode ? <small style={{ fontSize: '.9rem', color: 'var(--text-muted)' }}> ({x.year})</small> : null}</h3>
                {x.episode && <div className={pg.ep}>{x.number ? `${x.number} · ` : ''}“{x.episode}”</div>}
                <div className={s.tags}>
                  <span className={s.tag}>{x.user}</span>
                  <span className={s.tag}>{x.player}</span>
                  {x.quality !== '—' && <span className={s.tag}>{x.quality}</span>}
                  <span className={`${s.tag} ${x.mode === 'transcode' ? s.tagWarn : s.tagGood}`}>{x.mode}</span>
                </div>
                <ProgressBar value={x.progress} label={`${x.title} progress`} />
                <small className={s.mono} style={{ color: 'var(--text-dimmer)', fontSize: '.7rem' }}>{Math.round(x.progress)}% watched · {x.state}</small>
              </div>
            </article>
          ))}
        </Panel>
        <Panel title="Bandwidth" sub="PLEX STREAMS">
          <div className={s.gauges}>
            <SemiGauge value={v.bandwidth.wanMbps} max={niceMax(v.bandwidth.wanMbps, 20)} label="Over the internet" unit="Mbps" />
            <SemiGauge value={v.bandwidth.lanMbps} max={niceMax(v.bandwidth.lanMbps, 100)} label="On the local network" unit="Mbps" color="var(--hx-violet)" />
          </div>
        </Panel>
      </Cols>
      <Cols>
        <Panel title="Who watches most" sub="30 DAYS · HOURS">
          {v.topWatchers.length === 0 ? <p className={s.empty}>Not enough history yet.</p> : (
            <GlowBars label="Hours watched per person, last 30 days" items={v.topWatchers.map(w => ({
              label: w.user, value: w.minutes, text: w.minutes >= 60 ? `${Math.round(w.minutes / 60)} h` : `${w.minutes} m`,
            }))} />
          )}
        </Panel>
        <Panel title="Most watched" sub="30 DAYS · PLAYS">
          {v.topTitles.length === 0 ? <p className={s.empty}>Not enough history yet.</p> : (
            <GlowBars warm label="Plays per title, last 30 days" items={v.topTitles.map(t => ({ label: t.title, value: t.plays, text: String(t.plays) }))} />
          )}
        </Panel>
      </Cols>
      <Panel title="Recently watched">
        {v.recent.length === 0 ? <p className={s.empty}>No history recorded yet.</p> : (
          <Timeline label="Recently watched" items={v.recent.slice(0, 10).map((r, i) => ({
            key: `${r.at}-${i}`, title: <><b>{r.user}</b> watched {r.title}</>,
            meta: `${when(r.at)} · ${r.player} · ${r.minutes} min`,
          }))} />
        )}
      </Panel>
    </>
  )
}

// ── Arr Stack ────────────────────────────────────────────────────────────────

export interface Stuck { id: string; title: string; series: string; path: string; reason: string; files: number; mappable: number; unmappable: string[] }

export function arrChips(v: ArrVisual): StatChip[] {
  return [
    { label: 'in queue', value: v.pipeline.queued, tone: 'accent' },
    { label: 'blocked imports', value: v.pipeline.importBlocked, tone: v.pipeline.importBlocked ? 'crit' : 'good' },
    { label: 'stalled', value: v.pipeline.stalled, tone: v.pipeline.stalled ? 'warn' : undefined },
    ...(v.pipeline.downBps !== null ? [{ label: 'download', value: rate(v.pipeline.downBps) }] : []),
  ]
}

function AlertCard({ title, children, actions, warn }: { title: ReactNode; children: ReactNode; actions?: ReactNode; warn?: boolean }) {
  return (
    <div className={`${s.alert} ${warn ? s.alertWarn : ''}`} role="group" aria-label={typeof title === 'string' ? title : undefined}>
      <Icon name="warn" size={22} label={warn ? 'Warning' : 'Needs you'} />
      <div className={s.alertBody}><b>{title}</b><small>{children}</small></div>
      {actions && <div className={s.alertAct}>{actions}</div>}
    </div>
  )
}

/** "the.show.s01e09.720p.web[group].mkv" read as words. */
const tidy = (n: string) => n.replace(/\[[^\]]*\]/g, '').replace(/\.(mkv|mp4|avi|zip)$/i, '').replace(/[._]+/g, ' ').trim() || n

export function ArrView({ v, stuck, rescuing, onRescue, rescueNote }: {
  v: ArrVisual; stuck: Stuck[]; rescuing: string | null; onRescue: (s: Stuck) => void; rescueNote: string | null
}) {
  const p = v.pipeline
  const down = v.services.filter(x => !x.up)
  const failing = v.indexers.filter(i => i.state === 'failing')
  return (
    <>
      <Panel title="Pipeline" sub="LIVE">
        <FlowPipeline label="Download pipeline" stages={[
          { key: 'search', label: 'Search', value: p.indexersOn, state: failing.length ? 'warn' : 'ok',
            sub: p.indexersTotal ? `${p.indexersOn} of ${p.indexersTotal} indexers${failing.length ? ` · ${failing.length} failing` : ''}` : 'no Prowlarr',
            status: failing.length ? `${failing.length} indexers failing` : undefined },
          { key: 'grab', label: 'Grabbed', value: p.queued, sub: 'in queue' },
          { key: 'dl', label: 'Downloading', value: p.downloading + p.stalled, state: p.stalled ? 'warn' : 'ok',
            sub: p.downBps !== null ? `↓ ${rate(p.downBps)} · ↑ ${rate(p.upBps ?? 0)}` : 'no download client', status: p.stalled ? `${p.stalled} stalled` : undefined },
          { key: 'import', label: 'Import', value: p.importBlocked, state: p.importBlocked ? 'bad' : 'ok',
            sub: p.importBlocked ? `${p.importBlocked} blocked` : 'clear', status: p.importBlocked ? 'blocked, needs you' : 'clear' },
          { key: 'lib', label: 'Library', value: <Icon name="check" size={22} />, state: 'done', sub: p.seeding ? `${p.seeding} sharing` : 'files land here', status: 'done' },
        ]} />
      </Panel>

      {down.map(x => <AlertCard key={x.name} title={`${x.name} is not answering`}>Its queue and health are missing below until it answers again.</AlertCard>)}
      {rescueNote && <p className={pg.toast} role="status">{rescueNote}</p>}
      {v.blocked.map(b => {
        const st = stuck.find(x => b.downloadId && x.id === b.downloadId)
        return (
          <AlertCard key={`${b.service}-${b.downloadId ?? b.title}`} title={tidy(b.title)} actions={st ? (
            <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={!st.mappable || rescuing === st.id} onClick={() => onRescue(st)}>
              {rescuing === st.id ? 'Importing…' : `Map by filename (${st.mappable} of ${st.files})`}
            </button>
          ) : undefined}>
            {b.service} cannot import it: {b.reason}. It will not fix itself.
            {st && st.unmappable.length > 0 && ` ${st.unmappable.length} file(s) cannot be read and would be left alone.`}
          </AlertCard>
        )
      })}

      <Cols>
        <Panel title="Downloads" sub={`${v.downloads.length} ACTIVE`}>
          {v.downloads.length === 0 ? <p className={s.empty}>Nothing is transferring.</p> : (
            <ul className={s.dl}>
              {v.downloads.map((d, i) => {
                const variant = d.state === 'stalled' ? 'stall' : d.state === 'seeding' ? 'seed' : 'normal'
                const what = d.state === 'stalled' ? 'stuck · no progress' : d.state === 'seeding' ? `done · sharing ↑ ${rate(d.upBps)}`
                  : d.state === 'downloading' ? `↓ ${rate(d.downBps)}${d.etaSec ? ` · ${duration(d.etaSec)} left` : ''}` : d.state
                return (
                  <li key={`${d.name}-${i}`} className={s.dlItem}>
                    <div className={s.dlHead}><span title={d.name}>{tidy(d.name)}</span><span>{bytes(d.sizeBytes)}</span></div>
                    <ProgressBar value={d.progress} variant={variant} label={`${tidy(d.name)}: ${d.state}`} />
                    <span className={s.dlMeta} style={d.state === 'stalled' ? { color: 'var(--warn)' } : undefined}>{d.progress}% · {what}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Indexers" sub={v.indexers.length ? `${p.indexersOn} ON${failing.length ? ` · ${failing.length} FAILING` : ''}` : undefined}>
          {v.indexers.length === 0 ? <p className={s.empty}>Prowlarr is not configured.</p> : (
            <StatusDots label="Indexers" items={v.indexers.map(i => ({ label: i.name, state: i.state === 'ok' ? 'ok' : i.state === 'failing' ? 'bad' : 'off' }))} />
          )}
          {v.health.map((h, i) => (
            <p key={i} className={s.note} style={h.level === 'error' ? { color: 'var(--crit)' } : h.level === 'notice' ? { color: 'var(--text-muted)' } : undefined}>
              {h.service} {h.level}: {h.message}
            </p>
          ))}
        </Panel>
      </Cols>
    </>
  )
}

// ── Unmanic ──────────────────────────────────────────────────────────────────

export function unmanicChips(v: UnmanicVisual): StatChip[] {
  return [
    { label: 'encoding', value: v.totals.busy, tone: v.totals.busy ? 'violet' : undefined },
    { label: 'idle slots', value: v.totals.idle },
    { label: 'queued', value: v.totals.pending, tone: v.totals.pending && !v.totals.busy ? 'warn' : undefined },
    { label: 'workers up', value: `${v.workers.filter(w => w.up).length}/${v.workers.length}`, tone: v.workers.some(w => !w.up) ? 'crit' : 'good' },
  ]
}

export function UnmanicView({ v }: { v: UnmanicVisual }) {
  const t = v.totals
  const encoding = v.workers.flatMap(w => w.encoding.map(e => ({ ...e, node: w.name })))
  const banner = t.busy ? { title: `Encoding ${t.busy} file${t.busy === 1 ? '' : 's'}`, warn: false }
    : t.pending ? { title: `${t.pending} queued, nothing encoding`, warn: true }
    : { title: 'All caught up', warn: false }
  return (
    <>
      <Panel label="Status">
        <div className={pg.calm} style={banner.warn ? { color: 'var(--warn)' } : undefined}>
          <Icon name={banner.warn ? 'warn' : 'encode'} size={30} />
          <div role="status"><b>{banner.title}</b>
            <span>{t.pending} QUEUED · {t.busy} ENCODING · {v.workers.filter(w => w.up).length} OF {v.workers.length} WORKERS ONLINE</span></div>
        </div>
      </Panel>
      <div className={pg.workers}>
        {v.workers.map(w => (
          <section key={w.name} className={pg.wk} data-up={w.up} aria-label={`${w.name}: ${w.up ? `${w.busy} of ${w.slots} slots encoding` : 'unreachable'}`}>
            <RingGauge value={w.slots ? w.busy / w.slots : 0} size={110} stroke={8} sweep={0.75} color="var(--hx-violet)" spin
              text={w.up ? `${w.busy}/${w.slots}` : '—'} label={w.up ? 'encoding' : 'offline'} />
            <h3>{w.name}</h3>
            {w.slots > 0 && (
              <ul className={pg.slots} aria-label={`${w.slots} slots`}>
                {Array.from({ length: w.slots }, (_, i) => {
                  const st = i < w.busy ? 'busy' : i < w.busy + w.paused ? 'paused' : 'idle'
                  return <li key={i} data-s={st} title={st}><span className={s.srOnly}>{st}</span></li>
                })}
              </ul>
            )}
            <small>{!w.up ? 'not answering' : `${w.pending} waiting · ${w.busy ? 'working' : 'standing by'}`}</small>
          </section>
        ))}
      </div>
      <Panel title="Encoding now">
        {encoding.length === 0 ? <p className={s.empty}>Nothing right now. When a file is encoding it shows here with its progress.</p> : (
          <ul className={s.dl}>
            {encoding.map((e, i) => (
              <li key={`${e.node}-${e.worker}-${i}`} className={s.dlItem}>
                <div className={s.dlHead}><span title={e.file}>{e.file}</span><span>{e.node} · {e.worker}</span></div>
                <ProgressBar value={e.progress} label={`${e.file} encoding`} />
                <span className={s.dlMeta}>{e.progress !== null ? `${Math.round(e.progress)}%` : 'progress not reported'}{e.elapsedSec ? ` · ${duration(e.elapsedSec)} so far` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}

// ── Router ───────────────────────────────────────────────────────────────────

export function routerChips(v: RouterVisual): StatChip[] {
  return [
    { label: 'Mbps down', value: mbps(v.total.downBps), tone: 'accent' },
    { label: 'Mbps up', value: mbps(v.total.upBps), tone: 'violet' },
    { label: 'devices', value: v.subnets.reduce((t, n) => t + n.devices, 0) },
    { label: 'CPU', value: `${v.health.cpuPct}%`, tone: v.health.cpuPct > 80 ? 'crit' : v.health.cpuPct > 50 ? 'warn' : undefined },
  ]
}

export function RouterView({ v }: { v: RouterVisual }) {
  const h = v.health
  const rings: Array<{ label: string; value: number; max: number; text: string; color: string }> = [
    { label: 'CPU', value: h.cpuPct, max: 100, text: `${h.cpuPct}%`, color: h.cpuPct > 80 ? 'var(--crit)' : 'var(--hx-accent)' },
    { label: 'Memory', value: h.memPct, max: 100, text: `${h.memPct}%`, color: h.memPct > 85 ? 'var(--crit)' : 'var(--hx-violet)' },
    ...(h.tempC !== null ? [{ label: 'Temp', value: h.tempC, max: 85, text: `${h.tempC}°C`, color: h.tempC > 70 ? 'var(--crit)' : 'var(--hx-warm)' }] : []),
    ...(h.voltage !== null ? [{ label: 'Power in', value: h.voltage, max: h.voltage > 30 ? 57 : 30, text: `${h.voltage}V`, color: 'var(--good)' }] : []),
  ]
  const maxTalk = Math.max(...v.talkers.map(t => Math.max(t.downBps, t.upBps)), 1)
  return (
    <>
      <Panel title={v.router.name} sub={[v.router.model, v.router.version && `ROUTEROS ${v.router.version}`, v.router.uptime && `UP ${v.router.uptime}`].filter(Boolean).join(' · ')}>
        <Topology label="Network map"
          internet={{ name: 'Internet' }}
          wans={v.wans.map(w => ({ key: w.name, name: w.name, sub: `↓ ${mbps(w.downBps)} ↑ ${mbps(w.upBps)} Mbps`, active: w.downBps + w.upBps > 0 }))}
          core={{ name: v.router.name, lines: [`↓ ${mbps(v.total.downBps)} · ↑ ${mbps(v.total.upBps)} Mbps`, `CPU ${h.cpuPct}%${h.tempC !== null ? ` · ${h.tempC}°C` : ''}`] }}
          subnets={v.subnets.slice(0, 4).map(n => ({ key: n.net, name: n.net, sub: `${n.devices} devices${n.uplink ? ` · ${n.uplink}` : ''}`, active: n.downBps + n.upBps > 0 }))} />
        {v.subnets.length > 4 && <p className={s.note} style={{ color: 'var(--text-muted)' }}>{v.subnets.length - 4} more subnets are in Details.</p>}
      </Panel>
      <Cols>
        <Panel title="Router health">
          <div className={s.rings}>
            {rings.map(r => <RingGauge key={r.label} value={r.value / r.max} text={r.text} label={r.label} color={r.color} />)}
          </div>
        </Panel>
        <Panel title="Top talkers" sub={<><span style={{ color: 'var(--hx-accent)' }} aria-hidden>■</span> DOWN <span style={{ color: 'var(--hx-violet)' }} aria-hidden>■</span> UP · MBPS</>}>
          {v.talkers.length === 0 ? <p className={s.empty}>Nothing is moving traffic right now.</p> : (
            <ul className={s.bars} aria-label="Busiest devices, download and upload">
              {v.talkers.map(t => (
                <li key={t.ip} className={s.talk}>
                  <span title={`${t.name ?? t.ip} (${t.ip})${t.source === 'cluster' ? ', a cluster guest' : ''}`}>{t.name ?? t.ip}</span>
                  <span className={s.two} aria-hidden>
                    <i className={s.down} style={{ width: `${(t.downBps / maxTalk) * 100}%` }} />
                    <i className={s.up} style={{ width: `${(t.upBps / maxTalk) * 100}%` }} />
                  </span>
                  <em>{mbps(t.downBps)}/{mbps(t.upBps)}</em>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Cols>
      <Cols>
        <Panel title="Open to the internet" sub={`${v.forwardsActive} PORT FORWARD${v.forwardsActive === 1 ? '' : 'S'}${v.forwards.length > 12 ? ' · TOP 12' : ''}`}>
          {v.forwards.length === 0 ? <p className={s.empty}>Nothing is published from the internet.</p> : (
            <ul className={pg.ports}>
              {v.forwards.slice(0, 12).map((f, i) => (
                <li key={`${f.name}-${i}`} className={pg.port} data-active={f.active}>
                  <em>{bytes(f.bytes)}</em><b title={f.name}>{f.name}</b>
                  <span title={f.to}>{f.proto} {f.port} → {f.toName ?? f.to}{f.active ? '' : ' (off)'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Live log" sub={v.log.some(l => l.level === 'error') ? `${v.log.filter(l => l.level === 'error').length} ERRORS` : undefined}>
          {v.log.length === 0 ? <p className={s.empty}>The log is empty.</p> : (
            <ol className={pg.log} aria-label="Router log, newest first">
              {v.log.map((l, i) => (
                <li key={i} data-level={l.level} title={l.message}>
                  <time>{l.time.length > 8 ? l.time.slice(-8) : l.time}</time>
                  {l.level !== 'info' && <span className={s.srOnly}>{l.level}: </span>}{l.message}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </Cols>
    </>
  )
}

// ── MeshCentral ──────────────────────────────────────────────────────────────

type MeshDevice = NonNullable<MeshVisual['devices']>[number]

/**
 * One computer in the fleet. `action` is the slot for opening a remote desktop on it; until that is built (its
 * own, security-reviewed piece of work) the slot holds a disabled "Coming next" button, so wiring it later changes
 * no layout.
 */
export function FleetTile({ d, action }: { d: MeshDevice; action?: ReactNode }) {
  return (
    <li className={pg.fl} data-online={d.online} aria-label={`${d.name}, ${d.online ? 'online' : 'offline'}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={s.hdot} data-tone={d.online ? 'good' : 'unknown'} aria-hidden />
        <b>{d.name}</b>
      </div>
      <small>{d.os ?? 'unknown OS'} · {d.online ? 'online' : 'offline'}</small>
      {d.group && <small>{d.group}</small>}
      <div style={{ marginTop: 'auto' }}>
        {action ?? <button type="button" className={s.btn} disabled aria-disabled="true" style={{ width: '100%' }} title="Remote desktop is coming next">Remote desktop · Coming next</button>}
      </div>
    </li>
  )
}

export function MeshView({ v }: { v: MeshVisual }) {
  if (v.connected && v.devices?.length) {
    const groups = [...new Set(v.devices.map(d => d.group ?? 'Devices'))]
    return (
      <>
        {groups.map(g => {
          const list = v.devices!.filter(d => (d.group ?? 'Devices') === g)
          return (
            <Panel key={g} title={g} sub={`${list.filter(d => d.online).length} OF ${list.length} ONLINE`}>
              <ul className={pg.fleet}>{list.map(d => <FleetTile key={d.id} d={d} />)}</ul>
            </Panel>
          )
        })}
      </>
    )
  }
  return (
    <section className={pg.ghost} aria-label="Connect MeshCentral">
      <h2>Connect MeshCentral to see devices</h2>
      <p style={{ margin: 0 }}>
        Today this plug-in keeps MeshCentral updated from the Updates page. Connected, this page shows every computer
        MeshCentral manages as a tile (name, operating system, group, online ones glowing), each with a remote-desktop
        button, which is coming next. To read the device list HyperProx needs:
      </p>
      <ul>{v.needs.map(n => <li key={n}>{n}</li>)}</ul>
      {v.publicUrl && <p className={s.note} style={{ color: 'var(--text-muted)' }}>MeshCentral: <a href={v.publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--hx-accent)' }}>{v.publicUrl}</a></p>}
    </section>
  )
}
