// =============================================================================
//  HyperProx — writing raw lxc.* lines, which the Proxmox API refuses
//
//  The API accepts no lxc.* key from any caller (token or root@pam, measured).
//  The owner decided (2026-11-05) that only these lines may be written by
//  rewriting the guest's whole config file over the node login, and only with
//  these guards:
//    * the file's sha256 at preview must be the file's sha256 at apply (compare
//      and swap, checked again inside the node script right before the rename);
//    * never while the cluster is not quorate, never when the file has a
//      [pve:pending] section;
//    * only the main section's lxc.* lines change; snapshot sections and every
//      other line stay byte for byte;
//    * written to a temp file in the same directory and renamed (as Proxmox's
//      own file_set_contents does), never appended, never edited in place;
//    * read back afterwards and compared byte for byte, then read through the
//      API to prove Proxmox still parses it.
// =============================================================================

import { createHash } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export interface ConfSplit {
  /** Raw lxc.* lines of the main section, in order. */
  rawMain: Array<[string, string]>
  /** Snapshot (and other) section names, in order. */
  sections: string[]
  hasPending: boolean
}

const SECTION = /^\[([^\]]+)\]\s*$/

/** Where the main section ends: the first section header, or the end. */
function mainEnd(lines: string[]): number {
  const i = lines.findIndex(l => SECTION.test(l))
  return i < 0 ? lines.length : i
}

export function splitConf(text: string): ConfSplit {
  const lines = text.split('\n')
  const end = mainEnd(lines)
  const rawMain: Array<[string, string]> = []
  for (const l of lines.slice(0, end)) { const m = /^(lxc\.[A-Za-z0-9_.]+):\s?(.*)$/.exec(l); if (m) rawMain.push([m[1], m[2]]) }
  const sections = lines.filter(l => SECTION.test(l)).map(l => SECTION.exec(l)![1])
  return { rawMain, sections, hasPending: sections.includes('pve:pending') }
}

export interface RawChange { remove?: Array<[string, string]>; add?: Array<[string, string]> }

/**
 * The file with exactly these raw lines removed from and added to its main section. Every other byte is kept.
 * New lines go after the main section's last line (before the blank line that precedes the first section).
 */
export function rewriteRawLines(text: string, ch: RawChange): string {
  const remove = ch.remove ?? [], add = ch.add ?? []
  if (!remove.length && !add.length) return text
  if (splitConf(text).hasPending) throw new Error('The file has a [pve:pending] section; HyperProx does not rewrite it. Restart the guest (or apply its pending changes) first.')
  for (const [k, v] of [...remove, ...add]) {
    if (!/^lxc\.[A-Za-z0-9_.]+$/.test(k)) throw new Error(`Only lxc.* lines are written this way (not ${k}).`)
    if (/[\r\n\0]/.test(v) || /[\r\n\0]/.test(k)) throw new Error('A raw line must be one line.')
  }
  const lines = text.split('\n')
  const end = mainEnd(lines)
  const main = lines.slice(0, end), rest = lines.slice(end)
  for (const [k, v] of remove) {
    const i = main.findIndex(l => l === `${k}: ${v}` || l === `${k}:${v}`)
    if (i < 0) throw new Error(`${k}: ${v} is not in the main section.`)
    main.splice(i, 1)
  }
  // Insert after the last non-blank line of the main section, so the blank separator before [snap] stays.
  let at = main.length
  while (at > 0 && main[at - 1] === '') at--
  main.splice(at, 0, ...add.map(([k, v]) => `${k}: ${v}`))
  return [...main, ...rest].join('\n')
}

const NODE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/
function confPath(node: string, vmid: number): string {
  if (!NODE.test(node) || !Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) throw new Error('Not a guest this writer can address.')
  return `/etc/pve/nodes/${node}/lxc/${vmid}.conf`
}

/** Read the file and its hash, base64 so no byte is lost on the way. */
export function readScript(node: string, vmid: number): string {
  const f = confPath(node, vmid)
  return `set -eu\nf='${f}'\nbase64 -w0 "$f"; echo\nsha256sum "$f" | cut -d' ' -f1\n`
}

export function parseRead(out: string): { text: string; sha: string } {
  const [b64, sha] = out.trim().split('\n')
  const text = Buffer.from(b64 ?? '', 'base64').toString('utf8')
  if (!sha || sha.trim() !== sha256(text)) throw new Error('The config file could not be read intact from the node.')
  return { text, sha: sha.trim() }
}

/**
 * Compare and swap: refuse unless the file still has `expectSha`, write the new bytes to a temp file beside it,
 * rename over it, and print the new file (base64) and hash for the caller to compare.
 */
export function writeScript(node: string, vmid: number, expectSha: string, content: string): string {
  const f = confPath(node, vmid)
  if (!/^[0-9a-f]{64}$/.test(expectSha)) throw new Error('Bad hash.')
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  return [
    'set -eu',
    `f='${f}'`,
    `cur=$(sha256sum "$f" | cut -d' ' -f1)`,
    `if [ "$cur" != '${expectSha}' ]; then echo "HPX-CAS-MISMATCH $cur"; exit 3; fi`,
    `t="$f.tmp.hpx.$$"`,
    `printf '%s' '${b64}' | base64 -d > "$t"`,
    `mv -f "$t" "$f"`,
    'base64 -w0 "$f"; echo',
    `sha256sum "$f" | cut -d' ' -f1`,
    '',
  ].join('\n')
}
