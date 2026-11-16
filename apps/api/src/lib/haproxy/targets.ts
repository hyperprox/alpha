// =============================================================================
//  HyperProx — HAProxy: Prometheus's list of HAProxy metrics endpoints
//
//  config/prometheus/targets/haproxy.json, read by the "haproxy" job in
//  prometheus.yml (file_sd). HyperProx owns the whole file: one entry per
//  HAProxy that has the metrics frontend (a Catalogue install serves /metrics on
//  :8405 to HyperProx's addresses only). Written whole, atomically, and only
//  when it changes.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { targetsDir } from '../targets'

export const HAPROXY_TARGETS_FILE = 'haproxy.json'

export interface HaproxyTarget { id: string; name: string; target: string }

export function haproxyTargetList(entries: HaproxyTarget[]): Array<{ targets: string[]; labels: Record<string, string> }> {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({
    targets: [e.target], labels: { hpx_haproxy: e.id, haproxy_name: e.name.replace(/[^\w .-]/g, '').slice(0, 40) },
  }))
}

/** Writes the file when its content would change; true when it did. */
export function writeHaproxyTargets(entries: HaproxyTarget[], dir = targetsDir()): boolean {
  const p = path.join(dir, HAPROXY_TARGETS_FILE)
  const next = JSON.stringify(haproxyTargetList(entries), null, 2)
  let cur: string | null = null
  try { cur = fs.readFileSync(p, 'utf8') } catch { cur = null }
  if (cur === next) return false
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${p}.tmp`, next, { mode: 0o644 })
  // Prometheus runs as its own user: a umask must never leave the list readable by root only.
  fs.chmodSync(`${p}.tmp`, 0o644)
  fs.renameSync(`${p}.tmp`, p)
  return true
}
