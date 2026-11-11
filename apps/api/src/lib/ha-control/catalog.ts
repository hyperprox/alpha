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
  /** The value as checked and rounded, as a person should see it in a confirm phrase. */
  shown?:  number | string
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

/**
 * The security tier is the default for anything that can open, arm, disarm or unlock something. Everyday is the
 * exception and has to be earned: a cover only with a device class that cannot let a person in, a switch only
 * when nothing in its id or name says it drives a door, a lock or an alarm.
 */
/** Always the security tier, whatever a house's settings say. */
export const SECURITY_DOMAINS = new Set(['lock', 'alarm_control_panel', 'siren'])
/** Covers that let a person into a building: always the security tier. */
export const SECURITY_COVER_CLASSES = new Set(['garage', 'gate', 'door'])
/** The only covers that are everyday by default. Any other class, or none, is security. */
export const EVERYDAY_COVER_CLASSES = new Set(['blind', 'curtain', 'shade', 'shutter', 'awning', 'damper'])
/** Run anything Home Assistant was told to run: security until the owner says otherwise. */
export const RUNNABLE_DOMAINS = new Set(['script', 'scene', 'button'])
/** Domains whose id and name are searched for the words below. */
export const KEYWORD_DOMAINS = new Set(['switch', 'input_boolean', 'cover', 'script', 'scene', 'button'])
/**
 * Words that mean a door, a gate, a lock or an alarm, in English and the common European languages, after
 * folding (NFKC, accents removed, lower case). Long words match inside a longer one ("Garagentor"); short words
 * only as a whole word, so "motor" is not "tor" and "warm" is not "arm". A match is always security.
 */
export const SECURITY_SUBSTRINGS = ['garage', 'garaje', 'alarm', 'siren', 'opener', 'unlock', 'disarm', 'portail', 'puerta',
  'porton', 'cancello', 'serrure', 'cerradura', 'schloss', 'lucchetto']
export const SECURITY_WORDS = new Set(['arm', 'door', 'gate', 'lock', 'entry', 'porte', 'tur', 'tor', 'deur', 'poort', 'slot'])

export function fold(text: string): string {
  return String(text ?? '').normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** True when the entity's id or name says it drives a door, a gate, a lock or an alarm. */
export function soundsLikeSecurity(s: HAState): boolean {
  for (const text of [s.entity_id.split('.').slice(1).join('.'), nameOf(s)]) {
    const f = fold(text)
    if (SECURITY_SUBSTRINGS.some(w => f.includes(w))) return true
    if (f.split(/[^a-z0-9]+/).some(t => SECURITY_WORDS.has(t))) return true
  }
  return false
}

/**
 * An owner's "everyday" mark, bound to what the entity was when it was marked. If any of these change (a new
 * name, a new device class, an id reused for something else) the mark no longer applies.
 */
export interface EverydayMark { entity_id: string; domain: string; device_class: string | null; friendly_name: string }

export function markFor(s: HAState): EverydayMark {
  const dc = s.attributes?.device_class
  return { entity_id: s.entity_id, domain: domainOf(s.entity_id), device_class: typeof dc === 'string' ? dc : null, friendly_name: nameOf(s) }
}

export function markHolds(m: EverydayMark, s: HAState): boolean {
  const now = markFor(s)
  return m.entity_id === now.entity_id && m.domain === now.domain && m.device_class === now.device_class && m.friendly_name === now.friendly_name
}

export interface TierPolicy {
  /** Entity ids the owner marked protected: security tier whatever their domain. */
  protected:       string[]
  /** Extra domains promoted to the security tier on this instance. */
  securityDomains: string[]
  /**
   * Devices the owner moved to everyday. Never applies to the always-security kinds below, protected wins over
   * it, and a mark is void once the entity's name, class or kind changes. Changing it is admin, re-confirmed
   * and audited.
   */
  everyday:        EverydayMark[]
  /** The least role that may use normal controls. */
  normalRole:      'operator' | 'admin'
  /** Send `ha.security.action` to notification channels after a security action. */
  notifySecurity:  boolean
}

export const DEFAULT_POLICY: TierPolicy = { protected: [], securityDomains: [], everyday: [], normalRole: 'operator', notifySecurity: true }

export const ENTITY_ID = /^[a-z_][a-z0-9_]{0,63}\.[a-z0-9_]{1,128}$/

export const domainOf = (id: string) => id.split('.')[0] ?? ''
export const nameOf = (s: HAState) => {
  const n = s.attributes?.friendly_name
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 120) : s.entity_id
}

/**
 * Security whatever the house's settings: locks, alarms, sirens, garage/gate/door covers, and any switch,
 * cover, script, scene or button whose id or name sounds like a door, a gate, a lock or an alarm.
 */
export function alwaysSecurity(s: HAState): boolean {
  const d = domainOf(s.entity_id)
  const dc = String(s.attributes?.device_class ?? '')
  return SECURITY_DOMAINS.has(d) || dc === 'siren' || (d === 'cover' && SECURITY_COVER_CLASSES.has(dc))
    || (KEYWORD_DOMAINS.has(d) && soundsLikeSecurity(s))
}

/** Words that mark a switch as a light (whole words, after folding). */
export const LIGHT_WORDS = new Set(['light', 'lights', 'lamp', 'lamps'])

/**
 * A wall switch that drives a light: a `switch` whose name says "light", "lights" or "lamp". It is everyday and
 * shown as a light. A security word anywhere in its id or name still wins ("Garage light" stays security).
 */
export function isLightSwitch(s: HAState): boolean {
  if (domainOf(s.entity_id) !== 'switch') return false
  if (String(s.attributes?.device_class ?? '') === 'outlet') return false
  if (!fold(nameOf(s)).split(/[^a-z0-9]+/).some(t => LIGHT_WORDS.has(t))) return false
  return !soundsLikeSecurity(s)
}

/** Security by default, but an owner may move it to everyday. */
function securityByDefault(s: HAState): boolean {
  const d = domainOf(s.entity_id)
  const dc = String(s.attributes?.device_class ?? '')
  if (d === 'cover') return !EVERYDAY_COVER_CLASSES.has(dc)
  if (RUNNABLE_DOMAINS.has(d)) return true
  // A switch can be wired to anything; only a plug socket, or a switch named as a light, is everyday without the
  // owner saying so.
  if (d === 'switch') return dc !== 'outlet' && !isLightSwitch(s)
  if (d === 'input_boolean') return true
  return false
}

export function tierOf(s: HAState, policy: TierPolicy): Tier {
  if (alwaysSecurity(s)) return 'security'
  if (policy.protected.includes(s.entity_id)) return 'security'
  if (policy.securityDomains.includes(domainOf(s.entity_id))) return 'security'
  if (securityByDefault(s) && !policy.everyday.some(m => markHolds(m, s))) return 'security'
  return 'normal'
}

/** Whether an entity can be marked everyday at all (and why not). */
export function everydayRefusal(s: HAState): string | null {
  if (alwaysSecurity(s)) return `${nameOf(s)} (${s.entity_id}) is always a security device and cannot be made everyday.`
  return null
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
    return { domain, service: a.service, data, shown: rounded }
  } else if (a.param?.kind === 'select') {
    const options = a.param.options(s)
    if (typeof value !== 'string' || !options.includes(value)) {
      throw new ActionRefusal('bad_value', `${a.param.label} must be one of: ${options.join(', ') || 'nothing this device offers'}.`)
    }
    data[a.param.field] = value
    return { domain, service: a.service, data, shown: value }
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

/**
 * What a security action's confirm step must say, word for word: "Unlock Front door at Second home". `shown` is the
 * value buildServiceCall checked and rounded, never the raw request value.
 */
export function confirmPhrase(s: HAState, action: string, shown: unknown, instanceName: string): string {
  return `${actionPhrase(s, action, shown)} ${nameOf(s)} at ${instanceName}`
}

/** The phrase with "{value}" where a slider or list value goes, for the browser to fill in. */
export function confirmTemplate(s: HAState, action: string, instanceName: string): string {
  return confirmPhrase(s, action, '{value}', instanceName)
}

/** The typed check: the person types the device's name. Case and surrounding spaces do not matter. */
export function typedMatches(s: HAState, typed: unknown): boolean {
  return typeof typed === 'string' && typed.trim().toLowerCase() === nameOf(s).toLowerCase()
}

/** The few attributes the Devices view needs. Never the whole attribute bag: some integrations put tokens there. */
export function displayState(s: HAState): { state: string; unit?: string; deviceClass?: string; current?: number } {
  const unit = s.attributes?.unit_of_measurement
  const dc = s.attributes?.device_class
  // A thermostat's room reading, for the climate dial. A number, or nothing.
  const current = domainOf(s.entity_id) === 'climate' ? num(s.attributes?.current_temperature) : null
  return {
    state: String(s.state).slice(0, 64),
    ...(typeof unit === 'string' ? { unit: unit.slice(0, 16) } : {}),
    ...(typeof dc === 'string' ? { deviceClass: dc.slice(0, 32) } : {}),
    ...(current !== null ? { current } : {}),
  }
}

// --- How a device is drawn ----------------------------------------------------------------------

export type DeviceKind = 'light' | 'switch' | 'outlet' | 'fan' | 'climate' | 'media' | 'cover' | 'lock' | 'alarm'
  | 'siren' | 'scene' | 'script' | 'button' | 'vacuum'

/** What a device is, for its tile and icon. A wall switch named as a light is a light. */
export function kindOf(s: HAState): DeviceKind {
  const d = domainOf(s.entity_id)
  switch (d) {
    case 'light': return 'light'
    case 'switch': return isLightSwitch(s) ? 'light' : String(s.attributes?.device_class ?? '') === 'outlet' ? 'outlet' : 'switch'
    case 'input_boolean': return 'switch'
    case 'fan': return 'fan'
    case 'climate': return 'climate'
    case 'media_player': return 'media'
    case 'cover': return 'cover'
    case 'lock': return 'lock'
    case 'alarm_control_panel': return 'alarm'
    case 'siren': return 'siren'
    case 'scene': return 'scene'
    case 'script': return 'script'
    case 'button': return 'button'
    case 'vacuum': return 'vacuum'
    default: return 'switch'
  }
}

/**
 * Indicator-LED companions: a switch named exactly like another switch or light plus " LED" (smart dimmers and
 * wall switches expose their status light as a second switch). Left out of the device list by default.
 */
export function ledCompanions(states: HAState[]): Set<string> {
  const base = new Set(states
    .filter(s => ['switch', 'light'].includes(domainOf(s.entity_id)))
    .map(s => fold(nameOf(s)).trim()))
  const out = new Set<string>()
  for (const s of states) {
    if (domainOf(s.entity_id) !== 'switch') continue
    const m = /^(.*\S)\s+led$/.exec(fold(nameOf(s)).trim())
    if (m && base.has(m[1])) out.add(s.entity_id)
  }
  return out
}

/** Room words, most specific first. Each pattern runs on the folded name. */
const ROOM_WORDS: Array<[RegExp, string]> = [
  [/\bliving\s*room\b/, 'Living Room'],
  [/\bfamily\s*room\b/, 'Family Room'],
  [/\bkitchen\b/, 'Kitchen'],
  [/\bdinn?ing\b/, 'Dining Room'],
  [/\bbed\s*rooms?\b/, 'Bedroom'],
  [/\bbath\s*rooms?\b/, 'Bathroom'],
  [/\bbasement\b/, 'Basement'],
  [/\blaundry\b/, 'Laundry'],
  [/\bhall(?:way)?s?\b/, 'Hallway'],
  [/\bstair(?:s|case|way)?\b/, 'Stairs'],
  [/\boffice\b/, 'Office'],
  [/\bgarage\b/, 'Garage'],
  [/\b(?:outside|outdoors?|porch|patio|(?:back|front)?yard)\b/, 'Outside'],
]

/** First words that are a kind of fan or a place, never a person: "Ceiling Fan" is not somebody's room. */
const NOT_A_PERSON = new Set(['ceiling', 'box', 'exhaust', 'bath', 'attic', 'floor', 'desk', 'tower', 'standing', 'pedestal',
  'window', 'portable', 'table', 'wall', 'main', 'big', 'small', 'front', 'back', 'upstairs', 'downstairs', 'guest',
  'master', 'spare', 'kids', 'baby', 'nursery', 'computer', 'game', 'games', 'play', 'tv', 'media', 'sun', 'utility',
  'mud', 'rec', 'boiler', 'furnace', 'server', 'the', 'my', 'our', 'new', 'old', 'smart', 'air', 'fan', 'room'])

/**
 * The room a device's name points at, for a house whose Home Assistant does not share its areas. Room words
 * first ("Kitchen Fan Light" is the kitchen), then a named room ("Guest Room Lamp"), then a person's room
 * ("Alex's Room speaker", "Alex Fan"). Null when the name says nothing; the caller files it under "Other".
 */
export function inferRoom(name: string): string | null {
  const raw = String(name ?? '').normalize('NFKC').replace(/[’`]/g, "'").trim()
  const f = fold(raw)
  for (const [rx, room] of ROOM_WORDS) if (rx.test(f)) return room
  const words = raw.split(/\s+/)
  const first = words[0] ?? ''
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const poss = /^([\p{L}][\p{L}-]{0,23})'s$/u.exec(first)
  if (poss && !NOT_A_PERSON.has(fold(poss[1]))) return `${cap(poss[1])}'s Room`
  const second = fold(words[1] ?? '')
  if (words.length >= 2 && second === 'room' && /^[\p{L}]{2,24}$/u.test(first)) return `${cap(first)} Room`
  if (words.length >= 2 && second === 'fan' && /^[\p{L}]{2,24}$/u.test(first) && !NOT_A_PERSON.has(fold(first))) return `${cap(first)}'s Room`
  return null
}
