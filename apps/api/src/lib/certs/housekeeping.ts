// =============================================================================
//  HyperProx — certificate housekeeping
//
//  Proxy certificates that can only ever fail: expired and attached to no host
//  (the proxy keeps trying to renew them), and certbot files on the proxy's
//  disk for certificates the proxy no longer knows about. Listing is read-only;
//  applying acts on one item, re-checks it first, and archives files rather
//  than deleting them.
// =============================================================================

import { X509Certificate } from 'node:crypto'
import type { NPMCertificate } from '../npm-client'
import type { CertsHousekeepingItem } from './types'

export interface HousekeepingDeps {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ certificate_id: number | null }[]>
  deleteNpmCertificate(id: number): Promise<void>
  /** Runs a shell script in the proxy's guest; null when no proxy guest is configured (API only). */
  guestExec: ((script: string) => Promise<{ code: number; output: string }>) | null
  /**
   * Told when the on-disk scan fails, so the API items can still be listed. Without it the failure throws:
   * a scan that fails quietly would read as "nothing to clean up".
   */
  warn?: (message: string) => void
}

const EXPIRED_PREFIX = 'npm-cert:'
const FILES_PREFIX   = 'npm-files:'
const LE_MOUNT       = '/etc/letsencrypt'
export const ARCHIVE_DIR = 'hyperprox-archived'

/** POSIX single-quoting: the only safe way to put a path from another machine into a script. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const FIND_MOUNT = `
set -u
command -v docker >/dev/null 2>&1 || { echo "ERR docker is not installed in the proxy guest"; exit 3; }
for c in $(docker ps -q); do
  docker inspect -f '{{.Config.Image}}{{"\\t"}}{{range .Mounts}}{{if eq .Destination "${LE_MOUNT}"}}{{.Source}}{{end}}{{end}}' "$c"
done
`

/** The host directory the proxy's container mounts at /etc/letsencrypt, read from `docker inspect`. */
async function findLetsencryptDir(exec: NonNullable<HousekeepingDeps['guestExec']>): Promise<string> {
  const r = await exec(FIND_MOUNT)
  if (r.code !== 0) throw new Error(`could not inspect the proxy's containers: ${r.output.trim() || `exit ${r.code}`}`)
  const mounts = r.output.split('\n').map(l => l.split('\t')).filter(p => p.length === 2 && p[1].trim())
    .map(([image, source]) => ({ image: image.trim(), source: source.trim() }))
  const dirs = [...new Set(mounts.map(m => m.source))]
  if (!dirs.length) throw new Error(`no running container in the proxy guest mounts ${LE_MOUNT}`)
  if (dirs.length === 1) return dirs[0]
  const proxy = [...new Set(mounts.filter(m => /proxy-manager/i.test(m.image)).map(m => m.source))]
  if (proxy.length === 1) return proxy[0]
  throw new Error(`several containers mount ${LE_MOUNT} at different places (${dirs.join(', ')}); not guessing which is the proxy's`)
}

function listScript(dir: string): string {
  return `
set -u
d=${shq(dir)}
[ -d "$d" ] || { echo "ERR $d is not a directory"; exit 3; }
for p in "$d"/live/npm-* "$d"/archive/npm-* "$d"/renewal/npm-*.conf; do
  [ -e "$p" ] && printf 'PATH\\t%s\\n' "$p"
done
for p in "$d"/live/npm-*/cert.pem; do
  [ -e "$p" ] && printf 'CERT\\t%s\\t%s\\n' "$(basename "$(dirname "$p")")" "$(base64 -w0 < "$p")"
done
exit 0
`
}

type OnDisk = { id: number; paths: string[]; names: string[]; expiredAt: string | null }

/** certbot's files per proxy certificate id: live/npm-N, archive/npm-N, renewal/npm-N.conf. */
async function scanDisk(exec: NonNullable<HousekeepingDeps['guestExec']>): Promise<{ dir: string; byId: Map<number, OnDisk> }> {
  const dir = await findLetsencryptDir(exec)
  const r = await exec(listScript(dir))
  if (r.code !== 0) throw new Error(`could not list ${dir} in the proxy guest: ${r.output.trim() || `exit ${r.code}`}`)
  const byId = new Map<number, OnDisk>()
  const entry = (id: number) => byId.get(id) ?? byId.set(id, { id, paths: [], names: [], expiredAt: null }).get(id)!
  for (const line of r.output.split('\n')) {
    const [kind, a, b] = line.split('\t')
    if (kind === 'PATH' && a) {
      const m = /\/npm-(\d+)(?:\.conf)?$/.exec(a)
      if (m) entry(Number(m[1])).paths.push(a)
    } else if (kind === 'CERT' && a && b) {
      const m = /^npm-(\d+)$/.exec(a)
      if (!m) continue
      try {
        const x = new X509Certificate(Buffer.from(b, 'base64'))
        const e = entry(Number(m[1]))
        e.names = (x.subjectAltName ?? '').split(/,\s*/).map(s => s.replace(/^DNS:/, '').trim()).filter(Boolean)
        e.expiredAt = new Date(x.validTo).toISOString()
      } catch { /* an unreadable certificate still leaves its paths listed */ }
    }
  }
  return { dir, byId }
}

function expiredUnused(certs: NPMCertificate[], hosts: { certificate_id: number | null }[], now: Date): NPMCertificate[] {
  const used = new Set(hosts.map(h => h.certificate_id).filter((id): id is number => typeof id === 'number' && id > 0))
  return certs.filter(c => {
    const exp = new Date(c.expires_on)
    return !Number.isNaN(exp.getTime()) && exp <= now && !used.has(c.id)
  })
}

export async function listHousekeeping(d: HousekeepingDeps, now: Date): Promise<CertsHousekeepingItem[]> {
  const [certs, hosts] = await Promise.all([d.npmCertificates(), d.npmHosts()])
  const items: CertsHousekeepingItem[] = expiredUnused(certs, hosts, now).map(c => ({
    id:        `${EXPIRED_PREFIX}${c.id}`,
    kind:      'proxy-expired-unused',
    names:     c.domain_names,
    expiredAt: new Date(c.expires_on).toISOString(),
    detail:    `Proxy certificate #${c.id}${c.nice_name ? ` (${c.nice_name})` : ''} has expired and no proxy host uses it, so its renewal can only fail. Applying deletes it through the proxy's API.`,
  }))

  if (d.guestExec) {
    try {
      const known = new Set(certs.map(c => c.id))
      const { dir, byId } = await scanDisk(d.guestExec)
      for (const f of [...byId.values()].sort((a, b) => a.id - b.id)) {
        if (known.has(f.id) || !f.paths.length) continue
        items.push({
          id:        `${FILES_PREFIX}${f.id}`,
          kind:      'proxy-orphan-files',
          names:     f.names,
          expiredAt: f.expiredAt && new Date(f.expiredAt) <= now ? f.expiredAt : null,
          detail:    `certbot files for npm-${f.id} remain in ${dir}, but the proxy has no certificate #${f.id}: ${f.paths.join(', ')}. Applying moves them into ${dir}/${ARCHIVE_DIR}/; nothing is deleted.`,
        })
      }
    } catch (e) {
      const msg = `Housekeeping could not check the proxy's certificate files: ${(e as Error).message}`
      if (!d.warn) throw new Error(msg)
      d.warn(msg)
    }
  }
  return items
}

function archiveScript(dir: string, stamp: string, paths: string[]): string {
  const dest = `${dir}/${ARCHIVE_DIR}/${stamp}`
  const lines = paths.map(p => {
    // Keep certbot's layout (live/, archive/, renewal/) inside the archive so a restore is a plain move back.
    const sub = p.slice(dir.length + 1).split('/')[0]
    return `mkdir -p ${shq(`${dest}/${sub}`)} && mv -n ${shq(p)} ${shq(`${dest}/${sub}/`)} && [ ! -e ${shq(p)} ] && echo "moved ${p.replace(/["$`\\]/g, '')}"`
  })
  return `set -eu\n${lines.join('\n')}\n`
}

export async function applyHousekeeping(item: CertsHousekeepingItem, d: HousekeepingDeps): Promise<string> {
  if (item.id.startsWith(EXPIRED_PREFIX)) {
    const id = Number(item.id.slice(EXPIRED_PREFIX.length))
    if (!Number.isInteger(id) || id <= 0) throw new Error(`not a proxy certificate item: ${item.id}`)
    // Re-check against the proxy now: a host may have been given this certificate since the list was made.
    const [certs, hosts] = await Promise.all([d.npmCertificates(), d.npmHosts()])
    const c = certs.find(x => x.id === id)
    if (!c) return `Proxy certificate #${id} is already gone.`
    if (!expiredUnused([c], hosts, new Date()).length) {
      throw new Error(`proxy certificate #${id} is no longer both expired and unused; nothing was deleted`)
    }
    await d.deleteNpmCertificate(id)
    return `Deleted proxy certificate #${id} (${c.domain_names.join(', ')}).`
  }

  if (item.id.startsWith(FILES_PREFIX)) {
    const id = Number(item.id.slice(FILES_PREFIX.length))
    if (!Number.isInteger(id) || id <= 0) throw new Error(`not a proxy files item: ${item.id}`)
    if (!d.guestExec) throw new Error('no proxy guest is configured, so its files cannot be reached')
    const [certs, scan] = await Promise.all([d.npmCertificates(), scanDisk(d.guestExec)])
    if (certs.some(c => c.id === id)) throw new Error(`the proxy now has a certificate #${id}; its files were left alone`)
    const files = scan.byId.get(id)
    if (!files?.paths.length) return `Nothing left for npm-${id} in ${scan.dir}.`
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const r = await d.guestExec(archiveScript(scan.dir, stamp, files.paths))
    if (r.code !== 0) throw new Error(`archiving npm-${id} failed part-way: ${r.output.trim() || `exit ${r.code}`}`)
    return `Archived ${files.paths.length} path(s) for npm-${id} into ${scan.dir}/${ARCHIVE_DIR}/${stamp}.`
  }

  throw new Error(`unknown housekeeping item: ${item.id}`)
}
