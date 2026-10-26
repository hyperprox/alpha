// =============================================================================
//  HyperProx — certificate housekeeping
//
//  Proxy certificates that can only ever fail: expired and attached to no host
//  of any kind (the proxy keeps trying to renew them), and certbot files on the
//  proxy's disk for certificates the proxy no longer knows about. Listing is
//  read-only; applying acts on one item, re-checks it first, and archives files
//  rather than deleting them. Anything that cannot be checked completely is
//  refused rather than guessed: a wrong "unused" deletes a live certificate.
// =============================================================================

import { X509Certificate } from 'node:crypto'
import type { NPMCertificate } from '../npm-client'
import type { CertsHousekeepingItem } from './types'

export interface HousekeepingDeps {
  npmCertificates(): Promise<NPMCertificate[]>
  /**
   * Everything in the proxy that can hold a certificate: proxy hosts, redirection hosts, 404 hosts and
   * streams. Must reject if any of those lists cannot be read; a partial list would make used look unused.
   */
  npmCertificateUsers(): Promise<{ certificate_id: number | null }[]>
  deleteNpmCertificate(id: number): Promise<void>
  /**
   * Whether the proxy login is an administrator. A lesser login does not see other users' disabled hosts, and a
   * disabled host has no nginx config on disk, so its certificate would look orphaned to every other check.
   */
  npmLoginIsAdmin(): Promise<boolean>
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
const DATA_MOUNT     = '/data'
export const ARCHIVE_DIR = 'hyperprox-archived'

/** POSIX single-quoting: the only safe way to put a path from another machine into a script. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const FIND_MOUNT = `
set -u
command -v docker >/dev/null 2>&1 || { echo "ERR docker is not installed in the proxy guest"; exit 3; }
for c in $(docker ps -q); do
  docker inspect -f '{{.Config.Image}}{{"\\t"}}{{range .Mounts}}{{if eq .Destination "${LE_MOUNT}"}}{{.Source}}{{end}}{{end}}{{"\\t"}}{{range .Mounts}}{{if eq .Destination "${DATA_MOUNT}"}}{{.Source}}{{end}}{{end}}' "$c"
done
`

/**
 * The host directories the proxy's container mounts at /etc/letsencrypt and at /data, read from
 * `docker inspect`. `data` is null when that container has no /data mount.
 */
async function findProxyDirs(exec: NonNullable<HousekeepingDeps['guestExec']>): Promise<{ le: string; data: string | null }> {
  const r = await exec(FIND_MOUNT)
  if (r.code !== 0) throw new Error(`could not inspect the proxy's containers: ${r.output.trim() || `exit ${r.code}`}`)
  const mounts = r.output.split('\n').map(l => l.split('\t')).filter(p => p.length >= 2 && p[1].trim())
    .map(([image, le, data]) => ({ image: image.trim(), le: le.trim(), data: (data ?? '').trim() }))
  const dirs = [...new Set(mounts.map(m => m.le))]
  if (!dirs.length) throw new Error(`no running container in the proxy guest mounts ${LE_MOUNT}`)
  let le: string
  if (dirs.length === 1) le = dirs[0]
  else {
    const proxy = [...new Set(mounts.filter(m => /proxy-manager/i.test(m.image)).map(m => m.le))]
    if (proxy.length !== 1) throw new Error(`several containers mount ${LE_MOUNT} at different places (${dirs.join(', ')}); not guessing which is the proxy's`)
    le = proxy[0]
  }
  const datas = [...new Set(mounts.filter(m => m.le === le && m.data).map(m => m.data))]
  return { le, data: datas.length === 1 ? datas[0] : null }
}

/**
 * Which of `ids` the proxy's own nginx configuration still points at (live/npm-N/), searched in the guest
 * under <data>/nginx. A read error is a failure, not a "no".
 */
function refScript(data: string, ids: number[]): string {
  return `
set -u
d=${shq(data)}/nginx
[ -d "$d" ] || { echo "ERR $d is not a directory"; exit 3; }
for id in ${ids.map(String).join(' ')}; do
  grep -rqF -- "${LE_MOUNT}/live/npm-$id/" "$d"; rc=$?
  if [ $rc -eq 0 ]; then printf 'REF\t%s\n' "$id"; elif [ $rc -ne 1 ]; then echo "ERR could not search $d for npm-$id"; exit 3; fi
done
exit 0
`
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
async function scanDisk(exec: NonNullable<HousekeepingDeps['guestExec']>): Promise<{ dir: string; data: string | null; byId: Map<number, OnDisk> }> {
  const { le: dir, data } = await findProxyDirs(exec)
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
  return { dir, data, byId }
}

function usedIds(users: { certificate_id: number | null }[]): Set<number> {
  return new Set(users.map(h => h.certificate_id).filter((id): id is number => typeof id === 'number' && id > 0))
}

function expiredUnused(certs: NPMCertificate[], used: Set<number>, now: Date): NPMCertificate[] {
  return certs.filter(c => {
    const exp = new Date(c.expires_on)
    return !Number.isNaN(exp.getTime()) && exp <= now && !used.has(c.id)
  })
}

/**
 * Certbot directories for ids the proxy's API does not list, minus any its nginx configuration still uses.
 * Refused outright when a host uses a certificate the list does not show: then the API user cannot see every
 * certificate, and "not in the list" means nothing.
 */
async function requireAdminLogin(d: HousekeepingDeps): Promise<void> {
  let admin = false
  try { admin = await d.npmLoginIsAdmin() } catch { /* unknown counts as no */ }
  if (!admin) throw new Error('the proxy login is not an administrator (or its role could not be read), so it may not see every host; no file is called orphaned')
}

async function orphanFiles(exec: NonNullable<HousekeepingDeps['guestExec']>, certs: NPMCertificate[], used: Set<number>,
  warn?: (m: string) => void): Promise<{ dir: string; orphans: OnDisk[] }> {
  const known = new Set(certs.map(c => c.id))
  const hidden = [...used].filter(id => !known.has(id))
  if (hidden.length) {
    throw new Error(`hosts use certificate${hidden.length === 1 ? '' : 's'} ${hidden.map(i => `#${i}`).join(', ')}, which the certificate list does not show; the proxy login cannot see every certificate, so no file is called orphaned`)
  }
  const { dir, data, byId } = await scanDisk(exec)
  const candidates = [...byId.values()].filter(f => !known.has(f.id) && f.paths.length).sort((a, b) => a.id - b.id)
  if (!candidates.length) return { dir, orphans: [] }
  if (!data) throw new Error(`could not find where the proxy's container mounts ${DATA_MOUNT}, so its configuration cannot be checked for references`)
  const r = await exec(refScript(data, candidates.map(f => f.id)))
  if (r.code !== 0) throw new Error(`could not search the proxy's configuration: ${r.output.trim() || `exit ${r.code}`}`)
  const referenced = new Set(r.output.split('\n').map(l => /^REF\t(\d+)$/.exec(l)?.[1]).filter(Boolean).map(Number))
  for (const id of referenced) warn?.(`npm-${id} is not in the proxy's certificate list, but its nginx configuration still uses it; left alone`)
  return { dir, orphans: candidates.filter(f => !referenced.has(f.id)) }
}

export async function listHousekeeping(d: HousekeepingDeps, now: Date): Promise<CertsHousekeepingItem[]> {
  const [certs, users] = await Promise.all([d.npmCertificates(), d.npmCertificateUsers()])
  const used = usedIds(users)
  const items: CertsHousekeepingItem[] = expiredUnused(certs, used, now).map(c => ({
    id:        `${EXPIRED_PREFIX}${c.id}`,
    kind:      'proxy-expired-unused',
    names:     c.domain_names,
    expiredAt: new Date(c.expires_on).toISOString(),
    detail:    `Proxy certificate #${c.id}${c.nice_name ? ` (${c.nice_name})` : ''} has expired and no proxy host, redirection, 404 host or stream uses it, so its renewal can only fail. Applying deletes it through the proxy's API.`,
  }))

  if (d.guestExec) {
    try {
      await requireAdminLogin(d)
      const { dir, orphans } = await orphanFiles(d.guestExec, certs, used, d.warn)
      for (const f of orphans) {
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
    // Re-check against the proxy now, every kind of host: one may have been given this certificate since.
    const [certs, users] = await Promise.all([d.npmCertificates(), d.npmCertificateUsers()])
    const c = certs.find(x => x.id === id)
    if (!c) return `Proxy certificate #${id} is already gone.`
    if (!expiredUnused([c], usedIds(users), new Date()).length) {
      throw new Error(`proxy certificate #${id} is no longer both expired and unused; nothing was deleted`)
    }
    await d.deleteNpmCertificate(id)
    return `Deleted proxy certificate #${id} (${c.domain_names.join(', ')}).`
  }

  if (item.id.startsWith(FILES_PREFIX)) {
    const id = Number(item.id.slice(FILES_PREFIX.length))
    if (!Number.isInteger(id) || id <= 0) throw new Error(`not a proxy files item: ${item.id}`)
    if (!d.guestExec) throw new Error('no proxy guest is configured, so its files cannot be reached')
    const [certs, users] = await Promise.all([d.npmCertificates(), d.npmCertificateUsers()])
    if (certs.some(c => c.id === id)) throw new Error(`the proxy now has a certificate #${id}; its files were left alone`)
    // The same checks as the list, in full: visibility, what is on disk, what nginx still references.
    const referenced: string[] = []
    await requireAdminLogin(d)
    const { dir, orphans } = await orphanFiles(d.guestExec, certs, usedIds(users), m => referenced.push(m))
    const files = orphans.find(f => f.id === id)
    if (!files) {
      if (referenced.some(m => m.startsWith(`npm-${id} `))) throw new Error(`the proxy's nginx configuration uses npm-${id}; its files were left alone`)
      return `Nothing left for npm-${id} in ${dir}.`
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const r = await d.guestExec(archiveScript(dir, stamp, files.paths))
    if (r.code !== 0) throw new Error(`archiving npm-${id} failed part-way: ${r.output.trim() || `exit ${r.code}`}`)
    return `Archived ${files.paths.length} path(s) for npm-${id} into ${dir}/${ARCHIVE_DIR}/${stamp}.`
  }

  throw new Error(`unknown housekeeping item: ${item.id}`)
}
