// =============================================================================
//  HyperProx — site metrics: adding $request_time to an existing nginx's log
//
//  The only change HyperProx offers to make inside a site it adopted, and only
//  when an admin asks, sees the exact lines, and re-enters the master password.
//
//  1. inspectScript (read-only) lists nginx's configuration files with their
//     SHA-256 and the lines that mention access_log or open the http block.
//  2. planLogFormat turns that into a plan: which `access_log <log>;` lines
//     become `access_log <log> hyperprox_metrics;`, and the one include line
//     that defines the format, right after `http {` so it exists before any
//     line uses it. A line with other options (buffer=, if=, a custom format)
//     is left alone and said so; with nothing plain to change, there is no plan.
//  3. applyScript refuses if any file's hash changed since the preview, backs
//     every file up beside itself, edits by line number, runs `nginx -t`, and
//     only then reloads (never restarts). If the test fails every file is put
//     back and nginx is not reloaded.
// =============================================================================

import { createHash } from 'node:crypto'
import { safeLogPath, safeNginxConfPath, shq } from './paths'

export const FORMAT_NAME = 'hyperprox_metrics'
export const INCLUDE_FILE = '/etc/nginx/hyperprox-metrics-log.conf'
/** The access log format the recipes use: nginx's combined, plus the request time and the proxy's X-Forwarded-For. */
export const LOG_FORMAT_LINE =
  `log_format ${FORMAT_NAME} '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent ` +
  `"$http_referer" "$http_user_agent" $request_time "$http_x_forwarded_for"';`

export function inspectScript(logPath: string): string {
  const p = safeLogPath(logPath)
  if (!p) throw new Error('Refused: the log path must be absolute, under /var/log, with no "..".')
  return [
    'set -u',
    'export LC_ALL=C',
    `LOG=${shq(p)}`,
    'if ! command -v nginx >/dev/null 2>&1; then echo "HPXF1 nonginx"; echo "HPXF1 end"; exit 0; fi',
    'T=$(nginx -T 2>/dev/null) || { echo "HPXF1 badconfig"; echo "HPXF1 end"; exit 0; }',
    `printf '%s\\n' "$T" | grep -q 'log_format[[:space:]]\\+${FORMAT_NAME}[[:space:]]' && echo "HPXF1 defined"`,
    `[ -e ${INCLUDE_FILE} ] && echo "HPXF1 includefile"`,
    `printf '%s\\n' "$T" | sed -n 's/^# configuration file \\(\\/etc\\/nginx\\/[A-Za-z0-9._\\/-]*\\):$/\\1/p' | sort -u | while read -r F; do`,
    '  [ -f "$F" ] || continue',
    '  echo "HPXF1 file $F $(sha256sum -- "$F" | cut -d" " -f1)"',
    `  grep -n -E '^[[:space:]]*(access_log[[:space:]]|http[[:space:]]*\\{)' -- "$F" | cut -c1-300`,
    'done',
    'echo "HPXF1 end"',
  ].join('\n')
}

export interface InspectFile { path: string; sha256: string; lines: Array<{ n: number; text: string }> }
export interface Inspection { nginx: boolean; configOk: boolean; defined: boolean; includeFileExists: boolean; files: InspectFile[] }

export function parseInspect(out: string): Inspection {
  const r: Inspection = { nginx: true, configOk: true, defined: false, includeFileExists: false, files: [] }
  let cur: InspectFile | null = null, ended = false
  for (const raw of out.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l === 'HPXF1 end') { ended = true; break }
    if (l === 'HPXF1 nonginx') { r.nginx = false; continue }
    if (l === 'HPXF1 badconfig') { r.configOk = false; continue }
    if (l === 'HPXF1 defined') { r.defined = true; continue }
    if (l === 'HPXF1 includefile') { r.includeFileExists = true; continue }
    const f = /^HPXF1 file (\S+) ([0-9a-f]{64})$/.exec(l)
    if (f) {
      const path = safeNginxConfPath(f[1])
      cur = path ? { path, sha256: f[2], lines: [] } : null
      if (cur) r.files.push(cur)
      continue
    }
    const m = /^(\d+):(.*)$/.exec(l)
    if (m && cur) cur.lines.push({ n: Number(m[1]), text: m[2] })
  }
  if (!ended) throw new Error('The nginx check did not finish.')
  return r
}

export interface LineEdit { file: string; line: number; before: string; after: string }
export interface LogFormatPlan {
  logPath: string
  /** sha256 of each file the plan touches, as previewed. */
  hashes: Record<string, string>
  edits: LineEdit[]
  /** The include line put after `http {`, or null when the format is already defined. */
  insert: { file: string; afterLine: number; text: string } | null
  /** The file written with the format definition, or null when it is already defined. */
  includeFile: { path: string; content: string } | null
  /** access_log lines for this log that were left alone, and why. */
  skipped: Array<{ file: string; line: number; text: string; why: string }>
  /** When there is no plan: why. */
  refusal?: string
  already?: boolean
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function planLogFormat(ins: Inspection, logPath: string): LogFormatPlan {
  const p = safeLogPath(logPath)
  const plan: LogFormatPlan = { logPath: p ?? '', hashes: {}, edits: [], insert: null, includeFile: null, skipped: [] }
  if (!p) return { ...plan, refusal: 'The log path must be absolute, under /var/log, with no "..".' }
  if (!ins.nginx) return { ...plan, refusal: 'nginx is not installed in this container.' }
  if (!ins.configOk) return { ...plan, refusal: 'nginx -T fails here, so its configuration cannot be read safely. Fix nginx first.' }
  const plain = new RegExp(`^([ \\t]*)access_log[ \\t]+${esc(p)}([ \\t]+combined)?[ \\t]*;[ \\t]*(#.*)?$`)
  const ours = new RegExp(`^[ \\t]*access_log[ \\t]+${esc(p)}[ \\t]+${FORMAT_NAME}[ \\t]*;`)
  const forLog = new RegExp(`^[ \\t]*access_log[ \\t]+${esc(p)}([ \\t;]|$)`)
  let alreadyOurs = 0
  let httpAt: { file: string; line: number } | null = null
  for (const f of ins.files) {
    for (const l of f.lines) {
      if (/^[ \t]*http[ \t]*\{/.test(l.text) && !httpAt) httpAt = { file: f.path, line: l.n }
      if (!forLog.test(l.text)) continue
      if (ours.test(l.text)) { alreadyOurs++; continue }
      const m = plain.exec(l.text)
      if (!m) { plan.skipped.push({ file: f.path, line: l.n, text: l.text.trim(), why: 'it has its own options or format, so HyperProx leaves it as it is' }); continue }
      plan.edits.push({ file: f.path, line: l.n, before: l.text, after: `${m[1]}access_log ${p} ${FORMAT_NAME};` })
      plan.hashes[f.path] = f.sha256
    }
  }
  if (!plan.edits.length) {
    if (alreadyOurs && ins.defined) return { ...plan, already: true, refusal: `${p} already uses the ${FORMAT_NAME} format.` }
    return { ...plan, refusal: plan.skipped.length
      ? `Every access_log line for ${p} has its own options, so there is nothing HyperProx can change safely. Add $request_time to that format by hand.`
      : `No configuration file has a plain "access_log ${p};" line, so there is nothing to change. Check the log path.` }
  }
  if (!ins.defined) {
    if (ins.includeFileExists) return { ...plan, edits: [], hashes: {}, refusal: `${INCLUDE_FILE} exists but does not define ${FORMAT_NAME}. Remove or fix it first.` }
    if (!httpAt) return { ...plan, edits: [], hashes: {}, refusal: 'No "http {" line was found, so there is no safe place to define the format.' }
    const f = ins.files.find(x => x.path === httpAt!.file)!
    plan.hashes[f.path] = f.sha256
    plan.insert = { file: f.path, afterLine: httpAt.line, text: `\tinclude ${INCLUDE_FILE};` }
    plan.includeFile = { path: INCLUDE_FILE, content: `# Added by HyperProx (site metrics): nginx's combined format plus the request time and X-Forwarded-For.\n${LOG_FORMAT_LINE}\n` }
  }
  return plan
}

/** A short id for a plan, from everything in it: applying a different plan under the same id is impossible. */
export function planId(plan: LogFormatPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24)
}

const SHA = /^[0-9a-f]{64}$/
const SAFE_LINE = /^[ \t]*(access_log \/var\/log\/[A-Za-z0-9._/-]+ hyperprox_metrics;|include \/etc\/nginx\/hyperprox-metrics-log\.conf;)$/

/** The apply script for a plan. Every value is checked again here, so a plan from anywhere else cannot inject. */
export function applyScript(plan: LogFormatPlan): string {
  if (plan.refusal || !plan.edits.length) throw new Error('There is nothing to apply.')
  const files = Object.keys(plan.hashes)
  for (const f of files) if (!safeNginxConfPath(f) || !SHA.test(plan.hashes[f])) throw new Error('Refused: a file in the plan is not a safe nginx path.')
  for (const e of plan.edits) {
    if (!plan.hashes[e.file] || !Number.isSafeInteger(e.line) || e.line < 1 || !SAFE_LINE.test(e.after)) throw new Error('Refused: an edit in the plan is not one HyperProx makes.')
  }
  if (plan.insert && (!plan.hashes[plan.insert.file] || !Number.isSafeInteger(plan.insert.afterLine) || !SAFE_LINE.test(plan.insert.text))) {
    throw new Error('Refused: the include in the plan is not one HyperProx makes.')
  }
  if (plan.includeFile && (plan.includeFile.path !== INCLUDE_FILE || /HPXF_EOF/.test(plan.includeFile.content))) throw new Error('Refused: unexpected include file.')
  const out: string[] = [
    'set -u',
    'export LC_ALL=C',
    'TS=$(date +%Y%m%d%H%M%S)',
    'BACKUPS=""',
    'fail() { echo "HPXF1 failed $1"; exit 3; }',
  ]
  for (const f of files) out.push(`[ "$(sha256sum -- ${shq(f)} | cut -d" " -f1)" = ${shq(plan.hashes[f])} ] || fail "changed ${f}"`)
  for (const f of files) out.push(`cp -p -- ${shq(f)} ${shq(f)}.hyperprox-bak-$TS || fail "backup ${f}"; BACKUPS="$BACKUPS ${f}"; echo "HPXF1 backup ${f}.hyperprox-bak-$TS"`)
  out.push('restore() { for F in $BACKUPS; do cat -- "$F.hyperprox-bak-$TS" > "$F"; done; }')
  out.push('edit() { awk -v n="$2" -v r="$3" \'NR==n{print r; next} {print}\' -- "$1" > "$1.hyperprox-new" && cat -- "$1.hyperprox-new" > "$1" && rm -f -- "$1.hyperprox-new"; }')
  out.push('insert() { awk -v n="$2" -v r="$3" \'{print} NR==n{print r}\' -- "$1" > "$1.hyperprox-new" && cat -- "$1.hyperprox-new" > "$1" && rm -f -- "$1.hyperprox-new"; }')
  if (plan.includeFile) {
    out.push(`[ -e ${INCLUDE_FILE} ] && fail "exists ${INCLUDE_FILE}"`)
    out.push(`umask 022; cat > ${INCLUDE_FILE} <<'HPXF_EOF'`, plan.includeFile.content.replace(/\n$/, ''), 'HPXF_EOF', 'MADE=1')
  } else out.push('MADE=0')
  for (const e of plan.edits) out.push(`edit ${shq(e.file)} ${e.line} ${shq(e.after)} || { restore; fail "edit ${e.file}"; }`)
  if (plan.insert) out.push(`insert ${shq(plan.insert.file)} ${plan.insert.afterLine} ${shq(plan.insert.text)} || { restore; fail "insert ${plan.insert.file}"; }`)
  out.push(
    'if nginx -t >/tmp/hyperprox-nginx-t.$$ 2>&1; then',
    '  rm -f /tmp/hyperprox-nginx-t.$$',
    '  if systemctl reload nginx 2>/dev/null || nginx -s reload; then echo "HPXF1 ok"; else echo "HPXF1 reloadfailed"; fi',
    'else',
    '  echo "HPXF1 testfailed"; tail -n 5 /tmp/hyperprox-nginx-t.$$ | cut -c1-300; rm -f /tmp/hyperprox-nginx-t.$$',
    `  restore; [ "$MADE" = 1 ] && rm -f ${INCLUDE_FILE}`,
    '  echo "HPXF1 restored"; exit 4',
    'fi',
  )
  return out.join('\n')
}

export interface ApplyResult { ok: boolean; backups: string[]; message: string }

export function parseApply(out: string, code: number | null): ApplyResult {
  const backups = [...out.matchAll(/^HPXF1 backup (\S+)$/gm)].map(m => m[1])
  if (/^HPXF1 ok$/m.test(out)) return { ok: true, backups, message: 'nginx passed its test and was reloaded. New lines carry the request time.' }
  if (/^HPXF1 reloadfailed$/m.test(out)) return { ok: false, backups, message: 'The change passed nginx -t, but the reload failed. The new format starts at nginx\'s next reload.' }
  const f = /^HPXF1 failed (.*)$/m.exec(out)
  if (f) return { ok: false, backups, message: /^changed /.test(f[1]) ? `${f[1].slice(8)} changed since the preview. Nothing was changed; preview again.` : `Stopped: ${f[1]}. Every file was put back.` }
  if (/^HPXF1 testfailed$/m.test(out)) return { ok: false, backups, message: 'nginx -t refused the change, so every file was put back and nginx was not reloaded.' }
  return { ok: false, backups, message: `The change did not report back (exit ${code ?? 'unknown'}).` }
}
