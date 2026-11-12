// =============================================================================
//  HyperProx — ASUS router: the diagnostics read
//
//  For working out how one firmware answers: every hook the plug-in calls, and
//  a set of candidates for the firmware, uptime, CPU, memory, wireless, mode and
//  AiMesh, each sent on its own so one failing call cannot hide the others. It
//  only reads (appGet.cgi), and everything secret is taken out before the
//  answer leaves HyperProx:
//
//    - any key, nvram name or wanlink field matching SECRET_RE (passwords, Wi-Fi
//      keys, tokens, WPS PINs...) has its value replaced, in JSON and in text;
//    - every MAC address, with any separator or none, becomes a placeholder
//      that is the same for the same MAC within one read (so the shape of a
//      client list survives), including where a MAC is an object key;
//    - each answer and the whole read are capped.
// =============================================================================

import { HOOKS } from './parse'

export const SECRET_RE = /(passw|psk|key|wpa|token|secret|auth|wps|pin)/i
export const MAX_ANSWER_CHARS = 24_000
export const MAX_TOTAL_CHARS = 240_000

// One nvram value per call: Asuswrt 388 answers only the first hook of a semicolon list.
const each = (group: string, keys: string[]): Array<[string, string]> => keys.map(k => [`${group}.${k}`, `nvram_get(${k})`])
const wl = (k: string[]) => [0, 1, 2, 3].flatMap(u => k.map(x => `wl${u}_${x}`))

/** The calls a diagnostics read sends, by name: the plug-in's own, then the candidates. Fixed text, all reads. */
export const DIAGNOSTIC_HOOKS: Array<[string, string]> = [
  ...Object.entries(HOOKS).map(([k, v]) => [`plugin.${k}`, v] as [string, string]),
  ...each('firmware', ['productid', 'odmpid', 'model', 'firmver', 'buildno', 'extendno', 'innerver', 'buildinfo', '3rd-party', 'webs_state_flag', 'webs_state_info', 'webs_state_info_am']),
  ['uptime.call', 'uptime()'],
  ['uptime.sys_uptime', 'sys_uptime()'],
  ['cpu.appobj', 'cpu_usage(appobj)'],
  ['cpu.plain', 'cpu_usage()'],
  ['memory.appobj', 'memory_usage(appobj)'],
  ['memory.plain', 'memory_usage()'],
  ['netdev.appobj', 'netdev(appobj)'],
  ...each('wireless', ['wl_ifnames', ...wl(['ssid', 'nband', 'radio', 'chanspec', 'channel', 'bw'])]),
  ['wireless.control_channel', 'wl_control_channel()'],
  ['wireless.wl_extent_channel', 'wl_extent_channel()'],
  ['wireless.chanspec', 'wl_chanspec()'],
  ...each('mode', ['sw_mode', 're_mode', 'cfg_master', 'cfg_alias', 'wlc_psta', 'amas_bdl', 'amas_ethernet', 'lan_proto', 'lan_gateway']),
  ['aimesh.cfg_clientlist', 'get_cfg_clientlist()'],
  ['aimesh.onboardinglist', 'get_onboardinglist()'],
  ['aimesh.allclientlist', 'get_allclientlist()'],
  ['aimesh.wired_clientlist', 'get_wiredclientlist()'],
  ['aimesh.wclientlist', 'get_wclientlist()'],
]

const MAC_SEP = /\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b/g
const MAC_BARE = /(?<![0-9A-Fa-fxX])[0-9A-Fa-f]{12}(?![0-9A-Fa-f])/g
const MAC_DOT = /\b[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\b/g
const REDACTED = '[redacted]'

/** One read's MAC placeholders: the same MAC gets the same placeholder throughout. */
export class MacMasker {
  private seen = new Map<string, string>()
  mask(mac: string): string {
    const k = mac.replace(/[^0-9a-f]/gi, '').toUpperCase()
    let v = this.seen.get(k)
    if (!v) { v = `MAC-${String(this.seen.size + 1).padStart(2, '0')}`; this.seen.set(k, v) }
    return v
  }
  /** A bare 12-hex string counts only when it has both letters and digits or a vendor-like spread; counters keep 0x. */
  text(s: string): string {
    return s.replace(MAC_SEP, m => this.mask(m)).replace(MAC_DOT, m => this.mask(m)).replace(MAC_BARE, m => (/[A-Fa-f]/.test(m) && /\d/.test(m) ? this.mask(m) : m))
  }
}

function redactValue(v: unknown, masks: MacMasker, depth = 0): unknown {
  if (depth > 12) return '[too deep]'
  if (typeof v === 'string') return masks.text(v)
  if (Array.isArray(v)) return v.map(x => redactValue(x, masks, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const key = masks.text(k)
      out[key] = SECRET_RE.test(k) ? REDACTED : redactValue(x, masks, depth + 1)
    }
    return out
  }
  return v
}

/** Text that is not JSON: secret "key":"value" pairs, secret wanlink_x() { return ... } fields, then every MAC. */
function redactText(t: string, masks: MacMasker): string {
  return masks.text(t
    .replace(/("([^"\n]{1,80})"\s*:\s*)("(?:[^"\\\n]|\\.)*"|[^,}\]\n]*)/g, (all, head, key) => (SECRET_RE.test(key) ? `${head}"${REDACTED}"` : all))
    .replace(/(function\s+([A-Za-z0-9_]+)\s*\(\s*\)\s*\{\s*return\s+)('[^'\n]*'|"[^"\n]*"|[^;}\n]*)/g, (all, head, name) => (SECRET_RE.test(name) ? `${head}'${REDACTED}'` : all)))
}

/** One answer, redacted and capped. JSON is redacted as JSON (keys, nested values); anything else as text. */
export function redactAnswer(text: string | null, masks = new MacMasker()): { body: string | null; json: boolean; truncated: boolean; chars: number } {
  if (text === null) return { body: null, json: false, truncated: false, chars: 0 }
  let body: string, json = false
  try {
    const v = JSON.parse(text.replace(/,\s*([}\]])/g, '$1'))
    body = JSON.stringify(redactValue(v, masks), null, 1)
    json = true
  } catch { body = redactText(text, masks) }
  const truncated = body.length > MAX_ANSWER_CHARS
  return { body: truncated ? body.slice(0, MAX_ANSWER_CHARS) : body, json, truncated, chars: text.length }
}
