// =============================================================================
//  HyperProx — self-update: keep secrets out of the progress log
//
//  Everything the updater prints goes through here before it reaches the
//  state file, the log file or the journal: the build and deploy output is
//  shown to admins in the browser. Two layers:
//
//    1. the install's own secrets, by value: every .env entry whose name says
//       it is one (PASSWORD, SECRET, TOKEN, KEY, HASH, DATABASE_URL);
//    2. shapes that are secrets whatever they belong to: a password in a URL,
//       `password=...`, a bearer token, a private key block.
//
//  Builtins only (see state.ts).
// =============================================================================

import fs from 'fs'

const SECRET_NAME = /PASS|SECRET|TOKEN|KEY|HASH|DATABASE_URL|CREDENTIAL|WEBHOOK/i
export const MASK = '••••'

const SHAPES: Array<[RegExp, string]> = [
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // password=..., token: ..., "secret":"..."
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|token)\s+)?[^\s"',;&]+/gi, `$1${MASK}`],
  [/((?:pass(?:word|phrase)?|secret|token|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1${MASK}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${MASK}`],
  // HyperProx API tokens and common provider tokens
  [/\b(?:hpx_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, `${MASK} (private key)`],
]

export type Redactor = (line: string) => string

/** The secret values in an .env file's text: entries named like secrets, at least 6 characters long. */
export function envSecrets(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!m || !SECRET_NAME.test(m[1])) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v.length >= 6) out.push(v)
    // The password inside a database URL is a secret of its own, printed without the rest of the URL.
    const pw = /:\/\/[^:/@\s]+:([^@\s]+)@/.exec(v)
    if (pw && pw[1].length >= 4) out.push(pw[1])
  }
  // Longest first, so a secret that contains another is masked whole.
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

export function makeRedactor(secrets: string[] = []): Redactor {
  const values = secrets.filter(s => s.length >= 4)
  return (line: string) => {
    let out = line
    for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK)
    for (const [re, rep] of SHAPES) out = out.replace(re, rep)
    return out
  }
}

/** A redactor for the install at `dir`: its .env's secrets plus the shapes. A missing .env leaves the shapes. */
export function redactorForInstall(dir: string): Redactor {
  let text = ''
  try { text = fs.readFileSync(`${dir}/.env`, 'utf8') } catch { /* shapes only */ }
  return makeRedactor(envSecrets(text))
}
