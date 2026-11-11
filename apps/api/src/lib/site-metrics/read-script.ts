// =============================================================================
//  HyperProx — site metrics: the one script that reads a site's access log
//
//  HyperProx pulls; nothing is installed in the site's container. Every five
//  minutes this fixed script runs in the container through the same pct path
//  the Sites page uses (lib/node-exec.ts: the script travels on standard input,
//  never on a command line). It is read-only: stat, tail and head on one file,
//  and on the file logrotate just moved it to. The only values in it are a
//  checked log path in single quotes and three integers.
//
//  It sends back base64, so a chunk cut in the middle of a character still has
//  the exact byte count the next offset is built from. Rotation:
//    - the log has a new inode and the old one is now <log>.1 (logrotate's
//      "create" with delaycompress, Debian's default): the rest of .1 is read
//      from the old offset, then the new log from 0;
//    - the old inode is gone (compressed straight away): the new log from 0, and
//      the part HyperProx had not read yet is reported as a gap;
//    - same inode but shorter than the offset (copytruncate): from 0.
// =============================================================================

import { safeLogPath, shq } from './paths'

/** Bytes read per section per run; more waits for the next run (or the next round of the same tick). */
export const READ_CHUNK = 4 * 1024 * 1024
/** A log seen for the first time is read from at most this far back. */
export const FIRST_READ_BACKLOG = 16 * 1024 * 1024

export interface ReadCursor { inode: string; offset: number }

export function readLogScript(logPath: string, cur: ReadCursor, chunk = READ_CHUNK): string {
  const p = safeLogPath(logPath)
  if (!p) throw new Error('Refused: the log path must be absolute, under /var/log, with no "..".')
  const inode = /^\d{1,20}$/.test(cur.inode) ? cur.inode : '0'
  const off = Number.isSafeInteger(cur.offset) && cur.offset >= 0 ? cur.offset : 0
  const max = Number.isSafeInteger(chunk) && chunk > 0 ? chunk : READ_CHUNK
  return [
    'set -u',
    'export LC_ALL=C',
    `LOG=${shq(p)}`,
    `OLD=${inode}`,
    `OFF=${off}`,
    `MAX=${max}`,
    `BACK=${FIRST_READ_BACKLOG}`,
    'section() { echo "HPXM1 section $1 $2 $3 $4"; if [ "$5" -gt 0 ]; then tail -c +$(( $4 + 1 )) -- "$6" | head -c "$5" | base64 -w0; fi; echo; }',
    'if [ ! -f "$LOG" ]; then echo "HPXM1 missing"; exit 0; fi',
    'if [ ! -r "$LOG" ]; then echo "HPXM1 unreadable"; exit 0; fi',
    'INODE=$(stat -c %i -- "$LOG"); SIZE=$(stat -c %s -- "$LOG")',
    'if [ "$OLD" = 0 ]; then',
    '  if [ "$SIZE" -gt "$BACK" ]; then OFF=$(( SIZE - BACK )); echo "HPXM1 skipfirst"; else OFF=0; fi',
    'elif [ "$INODE" != "$OLD" ]; then',
    '  R="$LOG.1"',
    '  if [ -f "$R" ] && [ "$(stat -c %i -- "$R")" = "$OLD" ]; then',
    '    RS=$(stat -c %s -- "$R"); N=$(( RS - OFF )); [ "$N" -lt 0 ] && N=0; [ "$N" -gt "$MAX" ] && N=$MAX',
    '    section rotated "$OLD" "$RS" "$OFF" "$N" "$R"',
    '  else echo "HPXM1 gap"; fi',
    '  OFF=0',
    'elif [ "$SIZE" -lt "$OFF" ]; then echo "HPXM1 truncated"; OFF=0; fi',
    'N=$(( SIZE - OFF )); [ "$N" -gt "$MAX" ] && N=$MAX',
    'section current "$INODE" "$SIZE" "$OFF" "$N" "$LOG"',
    'echo "HPXM1 end"',
  ].join('\n')
}

export interface ReadSection { kind: 'rotated' | 'current'; inode: string; size: number; from: number; data: Buffer }

export interface ReadResult {
  missing: boolean
  unreadable: boolean
  /** Lines between the last read and a rotation were lost (the old file was compressed or removed). */
  gap: boolean
  truncated: boolean
  /** First read of a big log: the first line of the chunk is probably cut, so drop it. */
  skipFirst: boolean
  sections: ReadSection[]
  complete: boolean
}

/** Read the script's answer. Throws when it is not one (so a broken run never moves the cursor). */
export function parseReadOutput(out: string): ReadResult {
  const r: ReadResult = { missing: false, unreadable: false, gap: false, truncated: false, skipFirst: false, sections: [], complete: false }
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l === 'HPXM1 missing') { r.missing = true; r.complete = true; continue }
    if (l === 'HPXM1 unreadable') { r.unreadable = true; r.complete = true; continue }
    if (l === 'HPXM1 gap') { r.gap = true; continue }
    if (l === 'HPXM1 truncated') { r.truncated = true; continue }
    if (l === 'HPXM1 skipfirst') { r.skipFirst = true; continue }
    if (l === 'HPXM1 end') { r.complete = true; continue }
    const m = /^HPXM1 section (rotated|current) (\d{1,20}) (\d+) (\d+)$/.exec(l)
    if (m) {
      const b64 = (lines[i + 1] ?? '').trim()
      if (b64 && !/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('The log reader sent something that is not base64.')
      r.sections.push({ kind: m[1] as 'rotated' | 'current', inode: m[2], size: Number(m[3]), from: Number(m[4]), data: Buffer.from(b64, 'base64') })
      i++
    }
  }
  if (!r.complete) throw new Error('The log reader did not finish.')
  return r
}
