// =============================================================================
//  HyperProx — Home Assistant control: the allow-list
//
//  Every control HyperProx offers is a row here: a (domain, action) pair, the
//  ONE Home Assistant service it calls, and the parameters it may send, each
//  checked against a range or a list. Nothing else can be called. There is no
//  "call any service" route and no passthrough to the Home Assistant API: a
//  request names an action from this table, and this table writes the service
//  call.
//
//  Pure functions only: no network, no storage, so all of it is unit-tested.
// =============================================================================

export interface HAState {
  entity_id:    string
  state:        string
  attributes:   Record<string, any>
  last_changed?: string
  last_updated?: string
}

export type Tier = 'normal' | 'security'

/** One control as the browser renders it. Built here, from the entity's own attributes. */
export type Control =
  | { action: string; kind: 'button'; label: string }
  | { action: string; kind: 'range'; label: string; min: number; max: number; step: number; unit: string; value: number | null }
  | { action: string; kind: 'select'; label: string; options: string[]; value: string | null }

export interface ServiceCall {
  domain:  string
  service: string
  data:    Record<string, unknown>
}

interface ActionSpec {
  label:   string
  service: string
  /** What the entity should read afterwards, for the read-back. Absent: any change counts. */
  expect?: (s: HAState, value: unknown) => boolean
  /** The parameter this action takes, if any. */
  param?:
    | { kind: 'range'; field: string; label: string; unit: string; step: number; range: (s: HAState) => [number, number]; scale?: (v: number) => number; current: (s: HAState) => number | null }
    | { kind: 'select'; field: string; label: string; options: (s: HAState) => string[]; current: (s: HAState) => string | null }
  /** Only offered when the entity says it supports it. */
  when?: (s: HAState) => boolean
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const strList = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 40) : []
const isOn  = (s: HAState) => s.state === 'on'
const isOff = (s: HAState) => s.state === 'off'

const onOff = (): Record<string, ActionSpec> => ({
  turn_on:  { label: 'On',  service: 'turn_on',  expect: isOn },
  turn_off: { label: 'Off', service: 'turn_off', expect: isOff },
})

/** Colour modes that take a colour temperature (Home Assistant's light.ColorMode). */
const supportsColorTemp = (s: HAState) => strList(s.attributes?.supported_color_modes).includes('color_temp')
const supportsBrightness = (s: HAState) =>
  strList(s.attributes?.supported_color_modes).some(m => m !== 'onoff') || num(s.attributes?.brightness) !== null

export const CATALOG: Record<string, Record<string, ActionSpec>> = {
  light: {
    ...onOff(),
    brightness: {
      label: 'Brightness', service: 'turn_on', when: supportsBrightness,
      expect: (s, v) => Number(v) === 0 ? isOff(s) : isOn(s) && Math.abs(Math.round((num(s.attributes?.brightness) ?? -999) / 2.55) - Number(v)) <= 2,
      param: { kind: 'range', field: 'brightness_pct', label: 'Brightness', unit: '%', step: 1, range: () => [0, 100],
        current: s => isOn(s) && num(s.attributes?.brightness) !== null ? Math.round(num(s.attributes.brightness)! / 2.55) : (isOff(s) ? 0 : null) },
    },
    color_temp: {
      label: 'Colour temperature', service: 'turn_on', when: supportsColorTemp,
      expect: (s, v) => isOn(s) && Math.abs((num(s.attributes?.color_temp_kelvin) ?? -99_999) - Number(v)) <= 100,
      param: { kind: 'range', field: 'color_temp_kelvin', label: 'Colour temperature', unit: 'K', step: 50,
        range: s => [num(s.attributes?.min_color_temp_kelvin) ?? 2000, num(s.attributes?.max_color_temp_kelvin) ?? 6500],
        current: s => num(s.attributes?.color_temp_kelvin) },
    },
  },
  switch:        onOff(),
  input_boolean: onOff(),
  fan: {
    ...onOff(),
    speed: {
      label: 'Speed', service: 'set_percentage',
      when: s => num(s.attributes?.percentage) !== null || num(s.attributes?.percentage_step) !== null,
      expect: (s, v) => Number(v) === 0 ? isOff(s) : Math.abs((num(s.attributes?.percentage) ?? -999) - Number(v)) <= Math.max(2, num(s.attributes?.percentage_step) ?? 0),
      param: { kind: 'range', field: 'percentage', label: 'Speed', unit: '%', step: 1, range: () => [0, 100],
        current: s => num(s.attributes?.percentage) },
    },
  },
  cover: {
    open:  { label: 'Open',  service: 'open_cover',  expect: s => ['open', 'opening'].includes(s.state) },
    close: { label: 'Close', service: 'close_cover', expect: s => ['closed', 'closing'].includes(s.state) },
    stop:  { label: 'Stop',  service: 'stop_cover' },
    position: {
      label: 'Position', service: 'set_cover_position', when: s => num(s.attributes?.current_position) !== null,
      expect: (s, v) => Math.abs((num(s.attributes?.current_position) ?? -999) - Number(v)) <= 2 || ['opening', 'closing'].includes(s.state),
      param: { kind: 'range', field: 'position', label: 'Position', unit: '%', step: 1, range: () => [0, 100],
        current: s => num(s.attributes?.current_position) },
    },
  },
  climate: {
    target_temperature: {
      label: 'Target temperature', service: 'set_temperature', when: s => num(s.attributes?.temperature) !== null || num(s.attributes?.min_temp) !== null,
      expect: (s, v) => Math.abs((num(s.attributes?.temperature) ?? -999) - Number(v)) < 0.05,
      param: { kind: 'range', field: 'temperature', label: 'Target', unit: '°', step: 0.5,
        range: s => [num(s.attributes?.min_temp) ?? 5, num(s.attributes?.max_temp) ?? 35],
        current: s => num(s.attributes?.temperature) },
    },
    hvac_mode: {
      label: 'Mode', service: 'set_hvac_mode', when: s => strList(s.attributes?.hvac_modes).length > 0,
      expect: (s, v) => s.state === v,
      param: { kind: 'select', field: 'hvac_mode', label: 'Mode', options: s => strList(s.attributes?.hvac_modes), current: s => s.state },
    },
  },
  media_player: {
    play:  { label: 'Play',  service: 'media_play',  expect: s => s.state === 'playing' },
    pause: { label: 'Pause', service: 'media_pause', expect: s => s.state === 'paused' || s.state === 'idle' },
    volume: {
      label: 'Volume', service: 'volume_set', when: s => num(s.attributes?.volume_level) !== null,
      expect: (s, v) => Math.abs(Math.round((num(s.attributes?.volume_level) ?? -9) * 100) - Number(v)) <= 1,
      param: { kind: 'range', field: 'volume_level', label: 'Volume', unit: '%', step: 1, range: () => [0, 100], scale: v => v / 100,
        current: s => num(s.attributes?.volume_level) === null ? null : Math.round(num(s.attributes.volume_level)! * 100) },
    },
  },
  scene:  { run:   { label: 'Run',   service: 'turn_on' } },
  script: { run:   { label: 'Run',   service: 'turn_on' } },
  button: { press: { label: 'Press', service: 'press' } },
  vacuum: {
    start: { label: 'Start', service: 'start',          expect: s => s.state === 'cleaning' },
    dock:  { label: 'Dock',  service: 'return_to_base', expect: s => ['returning', 'docked'].includes(s.state) },
  },
  // Security domains: every action here needs admin, a fresh master password, and a named confirmation.
  lock: {
    lock:   { label: 'Lock',   service: 'lock',   expect: s => ['locked', 'locking'].includes(s.state) },
    unlock: { label: 'Unlock', service: 'unlock', expect: s => ['unlocked', 'unlocking', 'open'].includes(s.state) },
  },
  alarm_control_panel: {
    arm_home: { label: 'Arm (home)', service: 'alarm_arm_home', expect: s => ['armed_home', 'arming'].includes(s.state) },
    arm_away: { label: 'Arm (away)', service: 'alarm_arm_away', expect: s => ['armed_away', 'arming'].includes(s.state) },
    disarm:   { label: 'Disarm',     service: 'alarm_disarm',   expect: s => s.state === 'disarmed' },
  },
  siren: onOff(),
}

/** Domains HyperProx can control at all. Anything else is shown nowhere and refused everywhere. */
export const CONTROLLABLE = new Set(Object.keys(CATALOG))

/** Always the security tier. A per-instance policy can add to these; it can never take one away. */
export const SECURITY_DOMAINS = new Set(['lock', 'alarm_control_panel', 'siren'])
/** Covers that let a person into a building. */
export const SECURITY_COVER_CLASSES = new Set(['garage', 'gate', 'door'])

export interface TierPolicy {
  /** Entity ids the owner marked protected: security tier whatever their domain. */
  protected:       string[]
  /** Extra domains promoted to the security tier on this instance. */
  securityDomains: string[]
  /** The least role that may use normal controls. */
  normalRole:      'operator' | 'admin'
  /** Send `ha.security.action` to notification channels after a security action. */
  notifySecurity:  boolean
}

export const DEFAULT_POLICY: TierPolicy = { protected: [], securityDomains: [], normalRole: 'operator', notifySecurity: true }

export const ENTITY_ID = /^[a-z_][a-z0-9_]{0,63}\.[a-z0-9_]{1,128}$/

export const domainOf = (id: string) => id.split('.')[0] ?? ''
export const nameOf = (s: HAState) => {
  const n = s.attributes?.friendly_name
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 120) : s.entity_id
}

export function tierOf(s: HAState, policy: TierPolicy): Tier {
  const d = domainOf(s.entity_id)
  if (SECURITY_DOMAINS.has(d)) return 'security'
  if (d === 'cover' && SECURITY_COVER_CLASSES.has(String(s.attributes?.device_class ?? ''))) return 'security'
  if (policy.securityDomains.includes(d)) return 'security'
  if (policy.protected.includes(s.entity_id)) return 'security'
  return 'normal'
}

/** The controls offered for an entity, from what its own attributes say it supports. */
export function controlsFor(s: HAState): Control[] {
  const spec = CATALOG[domainOf(s.entity_id)]
  if (!spec) return []
  const out: Control[] = []
  for (const [action, a] of Object.entries(spec)) {
    if (a.when && !a.when(s)) continue
    if (!a.param) { out.push({ action, kind: 'button', label: a.label }); continue }
    if (a.param.kind === 'range') {
      const [min, max] = a.param.range(s)
      if (!(max > min)) continue
      out.push({ action, kind: 'range', label: a.param.label, min, max, step: a.param.step, unit: a.param.unit, value: a.param.current(s) })
    } else {
      const options = a.param.options(s)
      if (options.length) out.push({ action, kind: 'select', label: a.param.label, options, value: a.param.current(s) })
    }
  }
  return out
}

export class ActionRefusal extends Error {
  constructor(public code: string, message: string, public status = 400, public extra: Record<string, string> = {}) { super(message); this.name = 'ActionRefusal' }
}

/**
 * The one service call this action maps to, with its parameter checked. Throws ActionRefusal for anything not
 * in the table, or a value outside the entity's own range or list.
 */
export function buildServiceCall(s: HAState, action: string, value: unknown): ServiceCall {
  const domain = domainOf(s.entity_id)
  const spec = CATALOG[domain]
  if (!spec) throw new ActionRefusal('domain_not_allowed', `HyperProx does not control ${domain} entities.`)
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(spec, action)) {
    throw new ActionRefusal('action_not_allowed', `"${String(action).slice(0, 40)}" is not something HyperProx can do to a ${domain}.`)
  }
  const a = spec[action]
  if (a.when && !a.when(s)) throw new ActionRefusal('action_not_supported', `${nameOf(s)} does not support ${a.label.toLowerCase()}.`)
  const data: Record<string, unknown> = { entity_id: s.entity_id }
  if (a.param?.kind === 'range') {
    const n = num(value)
    const [min, max] = a.param.range(s)
    if (n === null) throw new ActionRefusal('bad_value', `${a.param.label} needs a number.`)
    if (n < min || n > max) throw new ActionRefusal('bad_value', `${a.param.label} must be between ${min} and ${max}${a.param.unit}.`)
    const rounded = a.param.step >= 1 ? Math.round(n) : Math.round(n / a.param.step) * a.param.step
    data[a.param.field] = a.param.scale ? a.param.scale(rounded) : rounded
  } else if (a.param?.kind === 'select') {
    const options = a.param.options(s)
    if (typeof value !== 'string' || !options.includes(value)) {
      throw new ActionRefusal('bad_value', `${a.param.label} must be one of: ${options.join(', ') || 'nothing this device offers'}.`)
    }
    data[a.param.field] = value
  } else if (value !== undefined && value !== null && value !== '') {
    throw new ActionRefusal('bad_value', `${a.label} takes no value.`)
  }
  return { domain, service: a.service, data }
}

/** True when the entity now reads as this action intended (or, for actions with no expectation, changed at all). */
export function readBackMatches(before: HAState, after: HAState, action: string, value: unknown): boolean {
  const a = CATALOG[domainOf(after.entity_id)]?.[action]
  if (a?.expect) return a.expect(after, value)
  return after.last_updated !== before.last_updated || after.state !== before.state
}

/** The word for the action in a sentence: "Unlock", "Set Brightness to 40%". */
export function actionPhrase(s: HAState, action: string, value: unknown): string {
  const a = CATALOG[domainOf(s.entity_id)]?.[action]
  if (!a) return action
  if (a.param?.kind === 'range') return `Set ${a.param.label.toLowerCase()} to ${value}${a.param.unit}`
  if (a.param?.kind === 'select') return `Set ${a.param.label.toLowerCase()} to ${value}`
  return a.label
}

/** What a security action's confirm step must say, word for word: "Unlock Front door at Second home". */
export function confirmPhrase(s: HAState, action: string, value: unknown, instanceName: string): string {
  return `${actionPhrase(s, action, value)} ${nameOf(s)} at ${instanceName}`
}

/** The few attributes the Devices view needs. Never the whole attribute bag: some integrations put tokens there. */
export function displayState(s: HAState): { state: string; unit?: string; deviceClass?: string } {
  const unit = s.attributes?.unit_of_measurement
  const dc = s.attributes?.device_class
  return {
    state: String(s.state).slice(0, 64),
    ...(typeof unit === 'string' ? { unit: unit.slice(0, 16) } : {}),
    ...(typeof dc === 'string' ? { deviceClass: dc.slice(0, 32) } : {}),
  }
}
