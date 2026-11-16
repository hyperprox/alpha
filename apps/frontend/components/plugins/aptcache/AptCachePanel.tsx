'use client'

// =============================================================================
//  HyperProx — the package cache picture
//
//  One reading drawn as: the flow (the internet, the cache, your guests, with
//  each stream as thick as what went through it, so what the cache saved is
//  the gap you can see), the hour-by-hour trace of what guests got and what
//  had to be fetched, the gauges (from cache by bytes and by requests, the
//  disk), then the busiest packages, the repositories and which guests use
//  it (by name, never by address). Every figure is also said in words;
//  colour only repeats it.
// =============================================================================

import { useId } from 'react'
import { GlowBars, Panel, RingGauge, SemiGauge, Tiles } from '@/components/visual/kit'
import a from './aptcache.module.css'
import { areaPath, bucketed, diskUse, pct, plural, repoName, size, type Reading } from './logic'

/** The internet, the cache and your guests, each stream as thick as its bytes. */
export function SavingsFlow({ r }: { r: Reading }) {
  const id = useId().replace(/:/g, '')
  const served = r.totals.bytes, fetched = r.totals.fetchedBytes, saved = r.totals.hitBytes
  const most = Math.max(1, served, fetched)
  const w = (b: number) => Math.max(2, Math.round((b / most) * 26))
  return (
    <figure className={a.flow} aria-label={`In the last ${r.hours} hours: ${size(fetched)} fetched from the internet, ${size(served)} handed to your guests, ${size(saved)} of it from the cache (${pct(r.byteHitRatio)}).`}>
      <svg viewBox="0 0 600 150" aria-hidden>
        <defs>
          <linearGradient id={`${id}in`} x1="0" x2="1"><stop offset="0" stopColor="var(--hx-violet)" stopOpacity=".25" /><stop offset="1" stopColor="var(--hx-violet)" stopOpacity=".9" /></linearGradient>
          <linearGradient id={`${id}out`} x1="0" x2="1"><stop offset="0" stopColor="var(--hx-accent)" stopOpacity=".95" /><stop offset="1" stopColor="var(--hx-accent)" stopOpacity=".35" /></linearGradient>
        </defs>
        <path d="M70 75 C150 75 180 75 255 75" stroke={`url(#${id}in)`} strokeWidth={w(fetched)} fill="none" strokeLinecap="round" />
        <path d="M345 75 C420 75 450 75 530 75" stroke={`url(#${id}out)`} strokeWidth={w(served)} fill="none" strokeLinecap="round" />
        <path d="M70 75 C150 75 180 75 255 75" className={a.dash} />
        <path d="M345 75 C420 75 450 75 530 75" className={a.dash} />
        <circle cx="50" cy="75" r="22" className={a.node} />
        <circle cx="300" cy="75" r="44" className={a.core} />
        <circle cx="300" cy="75" r="34" className={a.coreRing} strokeDasharray={`${Math.round((r.byteHitRatio ?? 0) * 213.6)} 213.6`} transform="rotate(-90 300 75)" />
        <circle cx="552" cy="75" r="22" className={a.node} />
        <text x="300" y="72" className={a.coreText}>{pct(r.byteHitRatio)}</text>
        <text x="300" y="90" className={a.coreSub}>FROM CACHE</text>
        <text x="50" y="118" className={a.flowLabel}>INTERNET</text>
        <text x="552" y="118" className={a.flowLabel}>GUESTS</text>
        <text x="160" y="52" className={a.flowValue}>{size(fetched)}</text>
        <text x="440" y="52" className={a.flowValue}>{size(served)}</text>
      </svg>
      <figcaption>
        <span><i className={a.keyIn} aria-hidden />fetched from the internet <b>{size(fetched)}</b></span>
        <span><i className={a.keyOut} aria-hidden />handed to guests <b>{size(served)}</b></span>
        <span>saved <b>{size(saved)}</b></span>
      </figcaption>
    </figure>
  )
}

/** Hour by hour: what guests got (teal) and what had to come from the internet (violet). */
export function HitTrace({ r }: { r: Reading }) {
  const id = useId().replace(/:/g, '')
  const W = 600, H = 120
  const hours = bucketed(r.perHour)
  const max = Math.max(1, ...hours.map(h => Math.max(h.bytes, h.fetchedBytes)))
  const got = areaPath(hours.map(h => h.bytes), W, H, max)
  const fetched = areaPath(hours.map(h => h.fetchedBytes), W, H, max)
  const busiest = hours.reduce((x, y) => (y.bytes > x.bytes ? y : x), hours[0] ?? { at: 0, bytes: 0, hitBytes: 0 } as any)
  return (
    <figure className={a.trace} aria-label={`Over the last ${r.hours} hours, ${size(r.totals.hitBytes)} of ${size(r.totals.bytes)} came from the cache; the busiest ${hours.length === r.perHour.length ? 'hour' : 'stretch'} moved ${size(busiest?.bytes ?? 0)}.`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={`${id}g`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--hx-accent)" stopOpacity=".38" /><stop offset="1" stopColor="var(--hx-accent)" stopOpacity="0" /></linearGradient>
          <linearGradient id={`${id}f`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--hx-violet)" stopOpacity=".3" /><stop offset="1" stopColor="var(--hx-violet)" stopOpacity="0" /></linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(y => <line key={y} x1="0" x2={W} y1={H * y} y2={H * y} className={a.grid} />)}
        {got.area && <path d={got.area} fill={`url(#${id}g)`} />}
        {got.line && <path d={got.line} className={a.gotLine} />}
        {fetched.area && <path d={fetched.area} fill={`url(#${id}f)`} />}
        {fetched.line && <path d={fetched.line} className={a.fetchLine} />}
      </svg>
      <figcaption>
        <span><i className={a.keyOut} aria-hidden />handed to guests</span>
        <span><i className={a.keyIn} aria-hidden />fetched from the internet</span>
        <span>the gap between them is what the cache saved</span>
      </figcaption>
    </figure>
  )
}

export function CacheGauges({ r }: { r: Reading }) {
  const use = diskUse(r)
  return (
    <div className={a.gauges}>
      <RingGauge value={r.byteHitRatio ?? 0} text={pct(r.byteHitRatio)} label="from cache (bytes)" size={108} />
      <RingGauge value={r.hitRatio ?? 0} text={pct(r.hitRatio)} label="from cache (requests)" size={108} color="var(--hx-violet)" />
      <SemiGauge value={Math.round((use ?? 0) * 100)} max={100} unit="%" label={r.disk ? `cache disk ${size(r.disk.usedKb * 1024)} of ${size(r.disk.sizeKb * 1024)}` : 'cache disk'}
        color={use !== null && use >= 0.9 ? 'var(--warn)' : undefined} />
    </div>
  )
}

/** The whole picture for one reading. */
export function AptCachePanel({ r }: { r: Reading }) {
  return (
    <>
      <Panel title="What it saved" sub={`last ${r.hours} hours`}>
        <SavingsFlow r={r} />
        <HitTrace r={r} />
        <Tiles label="Totals" items={[
          { label: 'saved', value: size(r.totals.hitBytes), tone: 'good' },
          { label: 'fetches', value: r.totals.requests, tone: 'accent' },
          { label: 'from cache', value: plural(r.totals.hits, 'fetch', 'fetches') },
          { label: 'refused today', value: r.refused, tone: r.refused ? 'warn' : 'dim' },
        ]} />
      </Panel>
      <Panel title="Cache and disk" sub={r.active ? 'running' : 'not running'}>
        <CacheGauges r={r} />
      </Panel>
      <Panel title="Busiest packages" sub="names only">
        {r.packages.length
          ? <GlowBars label="Busiest packages by fetches" items={r.packages.slice(0, 10).map(p => ({ key: p.name, label: p.name, value: p.requests, text: `${p.requests} · ${p.hits} from cache · ${size(p.bytes)}` }))} />
          : <p className={a.quiet}>No package was fetched in the window.</p>}
      </Panel>
      <div className={a.twoCol}>
        <Panel title="Repositories">
          {r.repos.length
            ? <GlowBars label="Traffic by repository" items={r.repos.slice(0, 8).map(x => ({ key: x.name, label: repoName(x.name), value: x.bytes, text: `${size(x.bytes)} · ${pct(x.requests ? x.hits / x.requests : null)} cached` }))} />
            : <p className={a.quiet}>Nothing came through in the window.</p>}
          <p className={a.quiet}>Cached: the plain-HTTP Debian and Ubuntu archives. HTTPS repositories are fetched directly by each guest and never show here.</p>
        </Panel>
        <Panel title="Who uses it" sub="guest names, never addresses">
          {r.clients.length
            ? <GlowBars warm label="Traffic by guest" items={r.clients.slice(0, 10).map(c => ({ key: `${c.kind}:${c.name}`, label: c.name, value: c.bytes, text: `${size(c.bytes)} · ${plural(c.requests, 'fetch', 'fetches')}` }))} />
            : <p className={a.quiet}>No guest used it in the window.</p>}
        </Panel>
      </div>
    </>
  )
}
