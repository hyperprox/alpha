// =============================================================================
//  HyperProx — secrets in guest configs never leave the cluster
//
//  A guest config can carry a secret under a telling key (cipassword, sshkeys)
//  or inside an ordinary value: OCI `env` variables, `lxc.environment` lines,
//  hook arguments, a description someone pasted a password into. History rows,
//  API responses and stored config files go through these functions first.
//  Names stay, so a change is still readable; values go.
// =============================================================================

import type { PveConfig } from './keys'

export const REDACTED = '**redacted**'

/** Keys whose whole value is a secret. */
export const SECRET_KEY = /(pass(word|wd)?|secret|token|sshkeys|apikey|api_key|credential|private)/i
export function isSecretKey(k: string): boolean { return SECRET_KEY.test(k) }

/** Keys whose value is a list of NAME=value pairs: every value goes, names stay. */
const ENV_KEY = /^(env|lxc\.environment)$/

const PATTERNS: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // PEM private keys, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // name=value / name: value / --name value where the name says secret (also URL-encoded '=' as %3D).
  [/((?:^|[\s,;&?"'(])-{0,2}[\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|auth|credential|private[_-]?key)[\w.-]*)(\s*(?:=|%3D|:)\s*|\s+)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, (_m, name, sep) => `${name}${sep}${REDACTED}`],
  // Well-known token shapes.
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|hpx_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})\b/g, () => REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, () => REDACTED],
]

/** Free text with secret-looking parts replaced. */
export function redactText(s: string): string {
  let out = s
  for (const [re, f] of PATTERNS) out = out.replace(re, f as any)
  return out
}

/** One config value, given its key. */
export function redactValue(key: string, value: string): string {
  if (isSecretKey(key)) return value === '' ? value : REDACTED
  if (ENV_KEY.test(key)) return value.split(/(\u0000|\n)/).map(p => (/^[\u0000\n]$/.test(p) ? p : p.replace(/^([^=]*)=.*$/s, `$1=${REDACTED}`))).join('')
  return redactText(value)
}

export function redactConfig<T extends PveConfig | null>(cfg: T): T {
  if (!cfg) return cfg
  const out: PveConfig = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'lxc' && Array.isArray(v)) out.lxc = (v as Array<[string, string]>).map(([rk, rv]) => [rk, redactValue(rk, String(rv))] as [string, string])
    else if (typeof v === 'string') out[k] = redactValue(k, v)
    else out[k] = v
  }
  return out as T
}

/** For display: "set" or "not set" for a secret key, everything else redacted by value. */
export function maskConfig(cfg: PveConfig): PveConfig {
  const out = redactConfig(cfg)
  for (const k of Object.keys(cfg)) if (isSecretKey(k)) out[k] = cfg[k] === undefined || cfg[k] === '' ? 'not set' : 'set'
  return out
}

/** A whole /etc/pve guest config file, every section, line by line. Comments (descriptions) are text too. */
export function redactConfFile(text: string): string {
  return text.split('\n').map(line => {
    if (line.startsWith('#')) return `#${redactText(decodeURIComponent(safe(line.slice(1))))}`
    const m = /^([A-Za-z0-9_.-]+):(\s?)(.*)$/.exec(line)
    if (!m) return line
    const v = m[1] === 'description' ? redactText(decodeURIComponent(safe(m[3]))) : redactValue(m[1], m[3])
    return `${m[1]}:${m[2]}${v}`
  }).join('\n')
}
function safe(s: string): string { try { decodeURIComponent(s); return s } catch { return encodeURIComponent(s) } }

export function hasRedacted(v: unknown): boolean { return JSON.stringify(v ?? '').includes(REDACTED) }
