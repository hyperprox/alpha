'use client'

// =============================================================================
//  HyperProx — Home Assistant, drawn as a house
//
//  Presentation only: tiles that glow when on, a climate dial, a light sheet
//  with a brightness ring and a warmth slider. Every tap is handed back to the
//  Devices view, which owns the one way in: the per-device action routes with
//  their tier, role, confirm and re-confirm checks. Nothing here calls an API.
// =============================================================================

import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { Icon, styles as s } from '@/components/visual/kit'
import pg from '@/components/plugins/visual/pages.module.css'

export interface VControl {
  action: string; kind: 'button' | 'range' | 'select'; label: string
  min?: number; max?: number; step?: number; unit?: string; value?: number | string | null; options?: string[]; confirm?: string
}
export interface VDevice {
  entityId: string; name: string; domain: string; kind?: string; tier: 'normal' | 'security'; unavailable: boolean
  state: string; unit?: string; deviceClass?: string; current?: number; controls: VControl[]
}

const DOMAIN_KIND: Record<string, string> = {
  light: 'light', switch: 'switch', input_boolean: 'switch', fan: 'fan', climate: 'climate', media_player: 'media', cover: 'cover',
  lock: 'lock', alarm_control_panel: 'alarm', siren: 'siren', scene: 'scene', script: 'script', button: 'button', vacuum: 'vacuum',
}
/** The kind the API sent, or one worked out from the domain for an older API. */
export const kindOf = (d: VDevice) => d.kind ?? DOMAIN_KIND[d.domain] ?? 'switch'
export const ctl = (d: VDevice, action: string) => d.controls.find(c => c.action === action)

export function isOn(d: VDevice): boolean {
  const k = kindOf(d)
  if (d.unavailable || d.state === 'hidden') return false
  if (k === 'media') return d.state === 'playing'
  if (k === 'cover') return d.state === 'open' || d.state === 'opening'
  if (k === 'lock') return d.state === 'unlocked' || d.state === 'open'
  if (k === 'climate') return d.state !== 'off'
  if (k === 'vacuum') return d.state === 'cleaning'
  if (k === 'alarm') return d.state.startsWith('armed') || d.state === 'triggered'
  return d.state === 'on'
}

function glyph(d: VDevice): string {
  const k = kindOf(d)
  if (k === 'media') return d.deviceClass === 'speaker' ? 'speaker' : 'tv'
  if (k === 'cover') return ['garage', 'gate', 'door'].includes(d.deviceClass ?? '') ? 'garage' : 'cover'
  return ({ light: 'light', fan: 'fan', lock: 'lock', outlet: 'plug', switch: 'toggle', alarm: 'alarm', siren: 'alarm', scene: 'run', script: 'run', button: 'run', vacuum: 'vacuum', climate: 'fan' } as Record<string, string>)[k] ?? 'toggle'
}

/** What the tile says under its name. */
export function stateText(d: VDevice): string {
  if (d.unavailable) return 'offline'
  if (d.state === 'hidden') return 'hidden'
  const k = kindOf(d)
  const br = ctl(d, 'brightness')
  if (k === 'light') return isOn(d) ? (typeof br?.value === 'number' && br.value > 0 ? `${br.value}%` : 'on') : 'off'
  if (k === 'fan') { const sp = ctl(d, 'speed'); return isOn(d) ? (typeof sp?.value === 'number' ? `${sp.value}%` : 'on') : 'off' }
  if (['scene', 'script', 'button'].includes(k)) return 'run'
  return `${d.state}${d.unit ? ` ${d.unit}` : ''}`
}

/**
 * One device. The main button acts (or opens the device's controls); the small ⋯ button, when there is one,
 * opens the sheet. Two buttons side by side, never one inside the other.
 */
export function Tile({ d, busy, onPress, onMore, moreLabel, pressLabel }: {
  d: VDevice; busy: boolean; onPress: () => void; onMore?: () => void; moreLabel?: string; pressLabel: string
}) {
  const k = kindOf(d)
  const on = isOn(d)
  const sec = d.tier === 'security'
  const br = ctl(d, 'brightness')
  const ring = k === 'light' && br ? (on && typeof br.value === 'number' ? br.value / 100 : 0) : null
  const C = 2 * Math.PI * 24
  return (
    <div className={pg.tileWrap}>
      <button type="button" className={pg.tile} data-kind={k === 'outlet' || k === 'switch' ? 'switch' : k} data-on={on} data-sec={sec} data-busy={busy}
        disabled={d.unavailable || busy} onClick={onPress} aria-label={`${d.name}, ${stateText(d)}${sec ? ', security device' : ''}. ${pressLabel}`}
        aria-pressed={['light', 'switch', 'outlet', 'fan', 'siren', 'media'].includes(k) ? on : undefined}
        style={d.unavailable ? { opacity: .45, borderStyle: 'dashed' } : undefined}>
        <div className={pg.ic} aria-hidden>
          {ring !== null && (
            <svg className={pg.tileRing} viewBox="0 0 54 54"><circle className={pg.bg} cx="27" cy="27" r="24" /><circle className={pg.fg} cx="27" cy="27" r="24" strokeDasharray={C} strokeDashoffset={C * (1 - ring)} /></svg>
          )}
          <Icon name={glyph(d)} className={pg.glyph} size={30} />
        </div>
        <div>
          <span className={pg.tileName}>{d.name}</span>
          <span className={pg.tileState}>{sec && <Icon name="lock" size={11} />}{busy ? '…' : stateText(d)}</span>
        </div>
        {k === 'media' && on && <span className={pg.eq} aria-hidden><i /><i /><i /><i /></span>}
      </button>
      {onMore && !d.unavailable && (
        <button type="button" className={pg.more} onClick={onMore} aria-label={moreLabel ?? `More controls for ${d.name}`}>⋯</button>
      )}
    </div>
  )
}

/**
 * A thermostat: the target on a dial, − and + in the device's own step, its modes as buttons. A run of taps is
 * gathered for a moment and sent as one target, so five taps are one command (and one audit row), not five.
 */
export function ClimateCard({ d, allowed, busy, onSet, why }: {
  d: VDevice; allowed: boolean; busy: boolean; why: string; onSet: (c: VControl, value: number | string) => void
}) {
  const target = ctl(d, 'target_temperature')
  const mode = ctl(d, 'hvac_mode')
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const shown = draft ?? (typeof target?.value === 'number' ? target.value : null)
  const min = target?.min ?? 16, max = target?.max ?? 30, step = target?.step ?? 0.5
  const nudge = (by: number) => {
    if (!target || shown === null) return
    const next = Math.max(min, Math.min(max, Math.round((shown + by * step) / step) * step))
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setDraft(null); onSet(target, next) }, 900)
  }
  const pct = shown === null ? 0 : (shown - min) / (max - min || 1)
  const C = 2 * Math.PI * 54 * 0.75
  const can = allowed && !busy && !d.unavailable
  return (
    <div className={`${pg.tileWrap} ${pg.tileWrapWide}`}>
      <section className={pg.climate} data-sec={d.tier === 'security'} aria-label={`${d.name} climate`}>
        <div className={s.ring} style={{ width: 132, height: 132 }} role="img" aria-label={`Target ${shown ?? 'unknown'}${target?.unit ?? '°'}`}>
          <svg viewBox="0 0 132 132" aria-hidden>
            <g transform="rotate(135 66 66)">
              <circle cx="66" cy="66" r="54" fill="none" stroke="var(--track)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C} 999`} />
              <circle cx="66" cy="66" r="54" fill="none" stroke="var(--hx-violet)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C * Math.max(0, Math.min(1, pct))} 999`}
                style={{ filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--hx-violet) var(--glow), transparent))', transition: 'stroke-dasharray .3s' }} />
            </g>
          </svg>
          <div className={s.ringMid} aria-hidden><b style={{ fontSize: '2.3rem' }}>{shown ?? '—'}°</b><span>target</span></div>
        </div>
        <div className={pg.cside}>
          <span className={pg.tileName}>{d.name}</span>
          <span className={pg.tileState} style={{ color: 'var(--hx-violet)' }}>
            {d.tier === 'security' && <Icon name="lock" size={11} />}{busy ? '…' : d.state}{typeof d.current === 'number' ? ` · room ${d.current}°` : ''}
          </span>
          {!allowed ? <small style={{ color: 'var(--text-dimmer)' }}>{why}</small> : (
            <>
              {target && (
                <div className={pg.pm}>
                  <button type="button" disabled={!can || shown === null || shown <= min} onClick={() => nudge(-1)} aria-label={`Cooler, ${d.name}`}>−</button>
                  <button type="button" disabled={!can || shown === null || shown >= max} onClick={() => nudge(1)} aria-label={`Warmer, ${d.name}`}>+</button>
                </div>
              )}
              {mode && (
                <div className={pg.modes} role="group" aria-label={`${d.name} mode`}>
                  {(mode.options ?? []).map(o => (
                    <button key={o} type="button" aria-pressed={mode.value === o} disabled={!can || mode.value === o} onClick={() => onSet(mode, o)}>{o.replace(/_/g, ' ')}</button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

/** The bottom sheet every device's full controls open in. */
export function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className={s.veil} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={s.sheet} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <h3>{title}</h3>
        {sub && <div className={s.sheetSub}>{sub}</div>}
        {children}
      </div>
    </div>
  )
}

/**
 * A light: drag the ring (or use the arrow keys on it) for brightness, the slider for warmth. A value is sent
 * once, when the finger lifts or the keys stop, through the same action route as every other control.
 */
export function LightSheet({ d, room, allowed, busy, note, why, onClose, onSet, onToggle }: {
  d: VDevice; room: string; allowed: boolean; busy: boolean; note?: { text: string; ok: boolean }; why: string
  onClose: () => void; onSet: (c: VControl, value: number) => void; onToggle: () => void
}) {
  const br = ctl(d, 'brightness')
  const ct = ctl(d, 'color_temp')
  const on = isOn(d)
  const live = typeof br?.value === 'number' ? br.value : on ? 100 : 0
  const [val, setVal] = useState<number | null>(null)
  const [warm, setWarm] = useState<number | null>(null)
  const drag = useRef(false)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const big = useRef<HTMLDivElement>(null)
  useEffect(() => () => { if (keyTimer.current) clearTimeout(keyTimer.current) }, [])
  const shown = val ?? live
  const C = 2 * Math.PI * 90 * 0.75
  const can = allowed && !busy && !d.unavailable
  const commit = (v: number) => { if (br && can) onSet(br, Math.max(br.min ?? 0, Math.min(br.max ?? 100, Math.round(v)))) }
  const fromPointer = (e: RPointerEvent) => {
    const r = big.current!.getBoundingClientRect()
    let a = (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI
    a = (a - 135 + 360) % 360
    if (a > 270) a = a > 315 ? 0 : 270
    const v = Math.max(1, Math.round((a / 270) * 100))
    setVal(v)
    return v
  }
  const onKey = (e: RKeyboardEvent) => {
    const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 10, PageDown: -10 }[e.key as string]
    const next: number | null = step ? Math.max(1, Math.min(100, shown + step)) : e.key === 'Home' ? 1 : e.key === 'End' ? 100 : null
    if (next === null) return
    e.preventDefault()
    setVal(next)
    if (keyTimer.current) clearTimeout(keyTimer.current)
    keyTimer.current = setTimeout(() => { commit(next!); setVal(null) }, 600)
  }
  const ctVal = warm ?? (typeof ct?.value === 'number' ? ct.value : ct?.min ?? 2700)
  return (
    <Sheet title={d.name} sub={room} onClose={onClose}>
      {!allowed && <small style={{ color: 'var(--text-dimmer)' }}>{why}</small>}
      {br && (
        <div ref={big} className={pg.big} role="slider" tabIndex={can ? 0 : -1} aria-label={`Brightness of ${d.name}`} aria-valuemin={1} aria-valuemax={100}
          aria-valuenow={shown} aria-valuetext={`${shown}%`} aria-disabled={!can}
          onPointerDown={e => { if (!can) return; drag.current = true; big.current?.setPointerCapture(e.pointerId); fromPointer(e) }}
          onPointerMove={e => { if (drag.current) fromPointer(e) }}
          onPointerUp={e => { if (!drag.current) return; drag.current = false; const v = fromPointer(e); commit(v); setVal(null) }}
          onPointerCancel={() => { drag.current = false; setVal(null) }}
          onKeyDown={onKey}>
          <svg viewBox="0 0 220 220" aria-hidden>
            <g transform="rotate(135 110 110)">
              <circle cx="110" cy="110" r="90" fill="none" stroke="var(--track)" strokeWidth="16" strokeLinecap="round" strokeDasharray={`${C} 999`} />
              <circle cx="110" cy="110" r="90" fill="none" stroke="var(--hx-warm)" strokeWidth="16" strokeLinecap="round" strokeDasharray={`${(C * shown) / 100} 999`}
                style={{ filter: 'drop-shadow(0 0 10px color-mix(in srgb, var(--hx-warm) var(--glow), transparent))' }} />
            </g>
          </svg>
          <div className={pg.bigVal}><b>{busy ? '…' : `${shown}%`}</b><span>{can ? 'drag the ring' : 'brightness'}</span></div>
        </div>
      )}
      {ct && typeof ct.min === 'number' && typeof ct.max === 'number' && (
        <div className={pg.ct}>
          <label htmlFor={`ct-${d.entityId}`}><span>Warmth</span><span>{ctVal} K</span></label>
          <input id={`ct-${d.entityId}`} className={pg.warmth} type="range" min={ct.min} max={ct.max} step={ct.step ?? 50} value={ctVal} disabled={!can}
            aria-label={`Colour temperature of ${d.name}, warm to cool`}
            onChange={e => setWarm(Number(e.target.value))}
            onPointerUp={() => { if (warm !== null) { onSet(ct, warm); setWarm(null) } }}
            onKeyUp={e => { if (warm !== null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) { onSet(ct, warm); setWarm(null) } }} />
        </div>
      )}
      {note && <small role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)', textAlign: 'center' }}>{note.text}</small>}
      <div className={s.sheetRow}>
        <button type="button" className={s.btn} onClick={onClose}>Close</button>
        {(ctl(d, 'turn_on') || ctl(d, 'turn_off')) && (
          <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={!can} onClick={onToggle}>{on ? 'Turn off' : 'Turn on'}</button>
        )}
      </div>
    </Sheet>
  )
}
