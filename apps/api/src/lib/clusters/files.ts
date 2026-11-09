// =============================================================================
//  HyperProx — copying folders between clusters (and within one)
//
//  Data moves node to node: rsync over SSH from a node of the source cluster to a node of the destination
//  cluster, over the private link. HyperProx never relays a byte; it checks, starts, watches and verifies.
//
//  Keys: one ed25519 key per (source cluster, destination cluster, destination node, destination folder),
//  made by HyperProx and kept in the vault (hyperprox:xfer-key/<src>-<dst>). Its public half is installed on
//  the destination node restricted to rsync in that one folder, write-only and unable to delete (it could
//  overwrite inside that folder; HyperProx's copy never replaces an existing file)
//  (rrsync -wo -no-del). Its private half is on the source node only while a job runs, in a root-only
//  directory under /run (memory), and is removed when the job ends. The destination's host keys are read over
//  HyperProx's own pinned connection and checked against the confirmed pin before they are trusted.
//
//  Paths: the destination must be inside a folder allowed for that cluster (Edit server -> folders), and so
//  must the source. "..", control characters and system folders are refused here; on the nodes the real path
//  (symlinks resolved) is checked against the real root before anything runs, and rsync's --safe-links skips
//  any link that points outside the copied tree.
//
//  Only Copy is offered. Sync and Move delete files, and are not offered until they have been run against real
//  servers.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { clusterRow, cleanRoot, ClusterRefusal, HOME_ID } from './registry'
import { runInCluster } from './context'
import { nodeCredential, execOnNode } from '../node-exec'
import { pveFromEnv } from '../pve-env'
import { pinnedKey, pinSource, isConfirmedSource } from '../hostkey-pins'
import { fingerprintOf } from '../ssh-broker'
import { getCredential, setCredential, deleteCredential, deleteProviderCredentials } from '../credentials'
import { isUnlocked, cachedSecrets } from '../vault/state'
import { assertSafeScript } from './monitoring'
import { auditCredentialUse } from '../audit'

// ---------------------------------------------------------------------------
//  Paths
// ---------------------------------------------------------------------------

/** The allowed root `p` is inside, or null. Both are normalised; no symlinks are resolved here (see the node checks). */
export function rootFor(p: string, roots: string[]): string | null {
  let clean: string
  try { clean = cleanRoot(p) } catch { return null }
  const hit = roots.map(r => { try { return cleanRoot(r) } catch { return null } }).filter((r): r is string => !!r)
    .filter(r => clean === r || clean.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0]
  return hit ?? null
}

export const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** A node-side check: the real path of `p` (it must exist) is the real root or inside it. Prints OK or a reason. */
export function containmentScript(p: string, root: string, mustBeDir: boolean): string {
  return [
    `R="$(realpath -e -- ${q(root)} 2>/dev/null)" || { echo "NO-ROOT"; exit 0; }`,
    `P="$(realpath -e -- ${q(p)} 2>/dev/null)" || { echo "NO-PATH"; exit 0; }`,
    `case "$P/" in "$R"/*) ;; *) echo "OUTSIDE $P"; exit 0;; esac`,
    mustBeDir ? `[ -d "$P" ] || { echo "NOT-DIR"; exit 0; }` : '',
    `echo "OK $P"`,
  ].filter(Boolean).join('\n')
}

export function parseContainment(out: string, what: string, p: string): string {
  const line = String(out ?? '').trim().split('\n').pop() ?? ''
  if (line.startsWith('OK ')) return line.slice(3)
  if (line === 'NO-ROOT') throw new ClusterRefusal(`The allowed folder for ${what} does not exist on that node.`)
  if (line === 'NO-PATH') throw new ClusterRefusal(`${p} does not exist on that node.`)
  if (line === 'NOT-DIR') throw new ClusterRefusal(`${p} is not a folder.`)
  if (line.startsWith('OUTSIDE')) throw new ClusterRefusal(`${p} leads outside the allowed folder (through a link), so it is refused.`)
  throw new ClusterRefusal(`Could not check ${p} on that node.`)
}

// ---------------------------------------------------------------------------
//  Running things on a node of a cluster
// ---------------------------------------------------------------------------

export interface NodeRunner {
  /** Run a script on `node` of `clusterId` over its saved, pinned login. */
  run(clusterId: string, node: string, script: string, timeoutMs?: number): Promise<{ code: number; output: string }>
  /** The address HyperProx SSHes to for that node. */
  sshAddress(clusterId: string, node: string): Promise<string | null>
  /** The address OTHER nodes reach that node on (the private link): saved per cluster. */
  linkAddress(clusterId: string, node: string): string | null
}

export const liveNodeRunner: NodeRunner = {
  async sshAddress(clusterId, node) {
    return runInCluster(clusterId, async () => {
      const r = clusterRow(clusterId)!
      if (r.kind === 'remote') return r.nodeAddresses[node] ?? null
      const rows = await pveFromEnv().fetchNode<any[]>('/cluster/status').catch(() => [])
      return (rows ?? []).find((x: any) => x?.type === 'node' && x.name === node)?.ip ?? null
    })
  },
  linkAddress(clusterId, node) { return clusterRow(clusterId)?.nodeAddresses[node] ?? null },
  async run(clusterId, node, script, timeoutMs = 120_000) {
    assertSafeScript(script)
    return runInCluster(clusterId, async () => {
      const host = await liveNodeRunner.sshAddress(clusterId, node)
      if (!host) throw new ClusterRefusal(`No address is known for ${node}.`)
      const cred = await nodeCredential(node)
      if (!cred) throw new ClusterRefusal(`No node login is saved for ${node}. Add one first (${clusterId === HOME_ID ? 'Settings -> Setup checklist' : 'Edit server -> Nodes and logins'}).`)
      await auditCredentialUse('node_login.use', `node:${node}`, { purpose: 'file copy', cluster: clusterId })
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, requirePin: true, timeoutMs })
      return { code: r.code, output: r.output }
    })
  },
}

// ---------------------------------------------------------------------------
//  Sending keys
// ---------------------------------------------------------------------------

const KEY_CATEGORY = 'xfer-key'
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
export const pairProvider = (src: string, dst: string) => `${src}-${dst}`
export const pairField = (dstNode: string, root: string) => `${dstNode}~${sha8(root)}`

export interface SendKey { private: string; public: string; knownHosts: string; dstAddress: string }

export async function sendKey(src: string, dst: string, dstNode: string, root: string): Promise<SendKey | null> {
  const raw = await getCredential(KEY_CATEGORY, pairProvider(src, dst), pairField(dstNode, root))
  if (!raw) return null
  try { return JSON.parse(raw) as SendKey } catch { return null }
}

/** Fingerprints of the host keys a node printed (`cat /etc/ssh/ssh_host_*_key.pub`). */
export function hostKeyLines(text: string): Array<{ type: string; key: string; fingerprint: string }> {
  return String(text ?? '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => /^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa)$/.test(p[0] ?? '') && /^[A-Za-z0-9+/=]+$/.test(p[1] ?? ''))
    .map(p => ({ type: p[0], key: p[1], fingerprint: fingerprintOf(Buffer.from(p[1], 'base64')) }))
}

const MARK = 'hyperprox-xfer'

/** The authorized_keys line: rsync only, into that one folder, write-only, no deletes, nothing else. */
export function authorizedLine(rrsync: string, root: string, publicKey: string, tag: string): string {
  const pk = publicKey.trim().split(/\s+/).slice(0, 2).join(' ')
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(pk)) throw new Error('Not an ed25519 public key.')
  if (!/^\/[A-Za-z0-9/._-]+$/.test(rrsync)) throw new Error('rrsync path looks wrong.')
  // sshd runs a forced command through the user's shell, so the folder is single-quoted (a space stays one
  // argument) and anything that could end the quote or be expanded is refused outright.
  if (/['"\\`$\n\r]/.test(root)) throw new ClusterRefusal('That folder name contains a quote, backslash, backtick, $ or line break, which a sending key cannot carry safely. Rename the folder or pick another.')
  return `restrict,command="${rrsync} -wo -no-del '${root}'" ${pk} ${MARK}:${tag}`
}

/**
 * Set up sending from cluster `src` to `dstNode` of cluster `dst`, into `root`. Run once per destination folder.
 * Re-running replaces the key (the old line is removed first).
 */
export async function setupSending(o: { src: string; dst: string; dstNode: string; root: string; by: string }, runner: NodeRunner = liveNodeRunner): Promise<{ words: string }> {
  const dstRow = clusterRow(o.dst), srcRow = clusterRow(o.src)
  if (!dstRow || !srcRow) throw new ClusterRefusal('No such cluster.', 'not-found')
  const root = rootFor(o.root, dstRow.allowedRoots)
  if (!root || root !== cleanRoot(o.root)) throw new ClusterRefusal(`${o.root} is not one of ${dstRow.name}'s allowed folders. Add it under Edit server -> folders first.`)
  const dstAddress = runner.linkAddress(o.dst, o.dstNode)
  if (!dstAddress) throw new ClusterRefusal(`Save the private-link address that other servers reach ${o.dstNode} on first (Edit server -> Nodes).`)
  const sshAddr = await runner.sshAddress(o.dst, o.dstNode)
  if (!sshAddr) throw new ClusterRefusal(`No address is known for ${o.dstNode}.`)
  const pin = await pinnedKey(sshAddr, 22)
  if (!pin || !isConfirmedSource(await pinSource(sshAddr, 22))) throw new ClusterRefusal(`${o.dstNode}'s host key is not confirmed yet. Confirm it first.`)

  const { utils } = require('ssh2') as typeof import('ssh2')
  const tag = `${o.src}:${sha8(root)}`
  const kp = utils.generateKeyPairSync('ed25519', { comment: `${MARK}:${tag}` })
  const facts = await runner.run(o.dst, o.dstNode, [
    'command -v rsync >/dev/null 2>&1 || { echo "NO-RSYNC"; exit 0; }',
    'RR="$(command -v rrsync)" || { echo "NO-RRSYNC"; exit 0; }',
    '"$RR" -h 2>&1 | grep -q -- -no-del || { echo "OLD-RRSYNC"; exit 0; }',
    'echo "RRSYNC $RR"',
    'cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null',
    containmentScript(root, root, true),
  ].join('\n'))
  const out = facts.output
  if (/NO-RSYNC/.test(out)) throw new ClusterRefusal(`rsync is not installed on ${o.dstNode}. Install it there (apt install rsync), then try again.`)
  if (/NO-RRSYNC|OLD-RRSYNC/.test(out)) throw new ClusterRefusal(`${o.dstNode} has no rrsync that can refuse deletes (rsync 3.2.4 or newer has it), so HyperProx will not install a key there.`)
  const rrsync = /^RRSYNC (\S+)$/m.exec(out)?.[1] ?? ''
  parseContainment(out, dstRow.name, root)
  const keys = hostKeyLines(out)
  if (!keys.some(k => k.fingerprint === pin)) throw new ClusterRefusal(`${o.dstNode}'s host keys do not include the confirmed one, so they are not trusted. Nothing was installed.`)
  const knownHosts = keys.map(k => `${dstAddress} ${k.type} ${k.key}`).join('\n') + '\n'

  const line = authorizedLine(rrsync, root, kp.public, tag)
  const install = await runner.run(o.dst, o.dstNode, [
    'set -e', 'umask 077', 'mkdir -p /root/.ssh', 'touch /root/.ssh/authorized_keys',
    // Drop an older line for the same source and folder, keep every other line exactly.
    `grep -v -F ${q(`${MARK}:${tag}`)} /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.hpx-tmp || true`,
    `printf '%s\\n' ${q(line)} >> /root/.ssh/authorized_keys.hpx-tmp`,
    'chmod 600 /root/.ssh/authorized_keys.hpx-tmp', 'mv -f /root/.ssh/authorized_keys.hpx-tmp /root/.ssh/authorized_keys',
    `grep -c -F ${q(`${MARK}:${tag}`)} /root/.ssh/authorized_keys`,
  ].join('\n'))
  if (install.code !== 0 || !/^1\s*$/m.test(install.output)) throw new Error(`Installing the key on ${o.dstNode} did not work.`)
  const key: SendKey = { private: kp.private, public: kp.public, knownHosts, dstAddress }
  await setCredential(KEY_CATEGORY, pairProvider(o.src, o.dst), pairField(o.dstNode, root), JSON.stringify(key), true)
  await auditCredentialUse('cluster.files.key', `cluster:${o.dst}`, { by: o.by, from: o.src, node: o.dstNode, folder: root })
  return { words: `${srcRow.name} can now send files to ${root} on ${o.dstNode} (${dstRow.name}). The key there can only write into that folder and cannot delete anything (it could overwrite a file there; HyperProx's copy never does).` }
}

/** Every sending key that involves cluster `id`, as source or destination. */
export function sendingKeysOf(id: string): Array<{ provider: string; src: string; dst: string; field: string; dstNode: string; tag: string }> {
  const out = []
  for (const item of cachedSecrets()) {
    const m = /^hyperprox:xfer-key\/([a-z0-9]+)-([a-z0-9]+)$/.exec(item.name)
    if (!m || (m[1] !== id && m[2] !== id)) continue
    for (const field of Object.keys(item.fields)) {
      const f = /^(.+)~([0-9a-f]{12})$/.exec(field)
      if (f) out.push({ provider: `${m[1]}-${m[2]}`, src: m[1], dst: m[2], field, dstNode: f[1], tag: `${m[1]}:${f[2]}` })
    }
  }
  return out
}

const dropLineScript = (tag: string) => `[ -f /root/.ssh/authorized_keys ] || exit 0\numask 077\ngrep -v -F ${q(`${MARK}:${tag}`)} /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.hpx-tmp || true\nchmod 600 /root/.ssh/authorized_keys.hpx-tmp\nmv -f /root/.ssh/authorized_keys.hpx-tmp /root/.ssh/authorized_keys\necho DROPPED`
export const manualDropCommand = (tag: string) => `sed -i '/${MARK}:${tag.replace(/[^a-z0-9:]/g, '')}/d' /root/.ssh/authorized_keys`

/**
 * Before a cluster is removed: take every sending key it is part of off the destination nodes (best effort) and
 * out of the vault. What could not be reached is returned with the exact command to run there by hand.
 */
export async function forgetClusterSending(id: string, runner: NodeRunner = liveNodeRunner): Promise<{ removed: string[]; manual: Array<{ where: string; command: string }> }> {
  const removed: string[] = [], manual: Array<{ where: string; command: string }> = []
  const keys = sendingKeysOf(id)
  for (const k of keys) {
    const where = `${clusterRow(k.dst)?.name ?? k.dst} / ${k.dstNode}`
    try {
      const r = await runner.run(k.dst, k.dstNode, dropLineScript(k.tag))
      if (!/DROPPED/.test(r.output)) throw new Error('no answer')
      removed.push(where)
    } catch { manual.push({ where, command: manualDropCommand(k.tag) }) }
  }
  for (const provider of new Set(keys.map(k => k.provider))) await deleteProviderCredentials(KEY_CATEGORY, provider).catch(() => undefined)
  return { removed, manual }
}

export async function removeSending(o: { src: string; dst: string; dstNode: string; root: string }, runner: NodeRunner = liveNodeRunner): Promise<void> {
  const root = cleanRoot(o.root)
  const tag = `${o.src}:${sha8(root)}`
  await runner.run(o.dst, o.dstNode, `[ -f /root/.ssh/authorized_keys ] || exit 0\numask 077\ngrep -v -F ${q(`${MARK}:${tag}`)} /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.hpx-tmp || true\nchmod 600 /root/.ssh/authorized_keys.hpx-tmp\nmv -f /root/.ssh/authorized_keys.hpx-tmp /root/.ssh/authorized_keys`)
  await deleteCredential(KEY_CATEGORY, pairProvider(o.src, o.dst), pairField(o.dstNode, root))
}

// ---------------------------------------------------------------------------
//  Browse
// ---------------------------------------------------------------------------

export async function browse(clusterId: string, node: string, p: string, runner: NodeRunner = liveNodeRunner) {
  const row = clusterRow(clusterId)
  if (!row) throw new ClusterRefusal('No such cluster.', 'not-found')
  if (!row.allowedRoots.length) return { path: null, roots: [], entries: [] as Array<{ name: string; dir: boolean; size: number }> }
  const target = p ? cleanRoot(p) : null
  if (!target) return { path: null, roots: row.allowedRoots, entries: [] }
  const root = rootFor(target, row.allowedRoots)
  if (!root) throw new ClusterRefusal(`${target} is not inside an allowed folder.`)
  const r = await runner.run(clusterId, node, `${containmentScript(target, root, true)}\nP="$(realpath -e -- ${q(target)})"\nfind "$P" -mindepth 1 -maxdepth 1 -not -name '.*' -printf '%y\\t%s\\t%f\\n' 2>/dev/null | head -2000`)
  parseContainment(r.output.split('\n').find(l => /^(OK|NO-|OUTSIDE|NOT-DIR)/.test(l)) ?? '', row.name, target)
  const entries = r.output.split('\n').map(l => l.split('\t')).filter(x => x.length === 3 && /^[dfl]$/.test(x[0]))
    .map(([t, s, n]) => ({ name: n, dir: t === 'd', size: Number(s) || 0 })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { path: target, roots: row.allowedRoots, entries }
}

// ---------------------------------------------------------------------------
//  Preview
// ---------------------------------------------------------------------------

export interface Endpoint { cluster: string; node: string; path: string }
export interface CopyInput { src: Endpoint; dst: Endpoint; speedKBps: number; plexScan: boolean }
export interface PreviewResult { files: number; bytes: number; skipped: number; totalFiles: number; seconds: number | null; words: string }

/** Parse rsync --stats. */
export function parseStats(text: string): { totalFiles: number; regular: number; transferred: number; bytes: number } {
  // rsync groups digits with "," (or "." in some locales): take the digit run, drop the separators.
  const num = (re: RegExp) => Number((re.exec(text)?.[1] ?? '0').replace(/[,.]/g, ''))
  const N = '(\\d(?:[\\d,.]*\\d)?)'
  return {
    totalFiles: num(new RegExp(`Number of files:\\s*${N}`)),
    regular: num(new RegExp(`Number of files:[^\\n]*reg:\\s*${N}`)),
    transferred: num(new RegExp(`Number of regular files transferred:\\s*${N}`)),
    bytes: num(new RegExp(`Total transferred file size:\\s*${N}`)),
  }
}

/** The shell for a one-shot rsync from the source node: key and known_hosts in a root-only temp dir, removed after. */
export function oneShotScript(o: { key: SendKey | null; dstHost: string | null; body: string }): string {
  const lines = ['set -u', 'umask 077', 'D="$(mktemp -d /run/hyperprox-xfer-XXXXXX)"', `trap 'rm -rf "$D"' EXIT`]
  if (o.key && o.dstHost) {
    lines.push(`cat > "$D/key" <<'HPXKEY'\n${o.key.private.trim()}\nHPXKEY`, `cat > "$D/known_hosts" <<'HPXKH'\n${o.key.knownHosts.trim()}\nHPXKH`)
    lines.push(`RSH="ssh -i $D/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$D/known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"`)
  } else lines.push('RSH=""')
  lines.push(o.body)
  return lines.join('\n')
}

const hostUri = (h: string) => (h.includes(':') ? `[${h}]` : h)

interface Resolved { input: CopyInput; srcRoot: string; dstRoot: string; dstRel: string; sameNode: boolean; dstHost: string | null; key: SendKey | null }

async function resolve(input: CopyInput, runner: NodeRunner): Promise<Resolved> {
  const sRow = clusterRow(input.src.cluster), dRow = clusterRow(input.dst.cluster)
  if (!sRow || !dRow) throw new ClusterRefusal('No such cluster.', 'not-found')
  const srcRoot = rootFor(input.src.path, sRow.allowedRoots)
  if (!srcRoot) throw new ClusterRefusal(`${input.src.path} is not inside one of ${sRow.name}'s allowed folders.`)
  const dstRoot = rootFor(input.dst.path, dRow.allowedRoots)
  if (!dstRoot) throw new ClusterRefusal(`${input.dst.path} is not inside one of ${dRow.name}'s allowed folders.`)
  const srcPath = cleanRoot(input.src.path), dstPath = cleanRoot(input.dst.path)
  if (srcPath === srcRoot) throw new ClusterRefusal('Pick a folder or file inside the allowed folder, not the whole allowed folder.')
  const sameNode = input.src.cluster === input.dst.cluster && input.src.node === input.dst.node
  if (sameNode && (dstPath === srcPath || dstPath.startsWith(srcPath + '/'))) throw new ClusterRefusal('The destination is inside what is being copied.')
  const dstRel = dstPath === dstRoot ? '.' : dstPath.slice(dstRoot.length + 1)
  let key: SendKey | null = null, dstHost: string | null = null
  if (!sameNode) {
    key = await sendKey(input.src.cluster, input.dst.cluster, input.dst.node, dstRoot)
    if (!key) throw new ClusterRefusal(`${sRow.name} is not set up to send to ${dstRoot} on ${input.dst.node} yet. Press "Set up sending" first.`, 'invalid')
    dstHost = key.dstAddress
  }
  // Real paths on both ends, links resolved, inside their roots.
  parseContainment((await runner.run(input.src.cluster, input.src.node, containmentScript(srcPath, srcRoot, false))).output, sRow.name, srcPath)
  parseContainment((await runner.run(input.dst.cluster, input.dst.node, containmentScript(dstPath, dstRoot, true))).output, dRow.name, dstPath)
  return { input: { ...input, src: { ...input.src, path: srcPath }, dst: { ...input.dst, path: dstPath } }, srcRoot, dstRoot, dstRel, sameNode, dstHost, key }
}

function targetOf(r: Resolved): string {
  return r.sameNode ? `${q(r.input.dst.path + '/')}` : `${q(`root@${hostUri(r.dstHost!)}:${r.dstRel}/`)}`
}

interface HeldPreview { id: string; owner: string; at: number; input: CopyInput; result: PreviewResult }
const previews = new Map<string, HeldPreview>()
const PREVIEW_MS = 15 * 60_000

export async function previewCopy(owner: string, input: CopyInput, runner: NodeRunner = liveNodeRunner): Promise<PreviewResult & { previewId: string }> {
  if (!Number.isInteger(input.speedKBps) || input.speedKBps < 0 || input.speedKBps > 10_000_000) throw new ClusterRefusal('The speed limit is in KB/s, 0 for none.')
  const r = await resolve(input, runner)
  const body = `rsync -a --dry-run --stats --ignore-existing --safe-links ${r.sameNode ? '' : '-e "$RSH" '}${q(r.input.src.path)} ${targetOf(r)} 2>&1 | tail -40`
  const out = await runner.run(input.src.cluster, input.src.node, oneShotScript({ key: r.key, dstHost: r.dstHost, body }), 30 * 60_000)
  if (!/Number of files:/.test(out.output)) throw new ClusterRefusal(`The dry run did not finish: ${out.output.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)
  const s = parseStats(out.output)
  const regular = s.regular || s.transferred
  const seconds = input.speedKBps > 0 ? Math.round(s.bytes / (input.speedKBps * 1024)) : null
  const sRow = clusterRow(input.src.cluster)!, dRow = clusterRow(input.dst.cluster)!
  const words = `${s.transferred} file(s), ${fmtBytes(s.bytes)}, from ${sRow.name} to ${dRow.name}` +
    (seconds !== null ? `, ${seconds < 60 ? 'under a minute' : `about ${fmtDuration(seconds)}`} at the speed limit` : '') +
    `. ${Math.max(0, regular - s.transferred)} file(s) already exist there and will be skipped; HyperProx replaces and deletes nothing there.`
  const result: PreviewResult = { files: s.transferred, bytes: s.bytes, skipped: Math.max(0, regular - s.transferred), totalFiles: regular, seconds, words }
  const id = randomUUID()
  previews.set(id, { id, owner, at: Date.now(), input: r.input, result })
  for (const [k, v] of previews) if (Date.now() - v.at > PREVIEW_MS) previews.delete(k)
  return { ...result, previewId: id }
}

export function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
export function fmtDuration(s: number): string {
  if (s < 60) return 'under a minute'
  const m = Math.round(s / 60); if (m < 90) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

// ---------------------------------------------------------------------------
//  Jobs
// ---------------------------------------------------------------------------

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export interface JobRow {
  id: string; mode: string; srcCluster: string; srcNode: string; srcPath: string; dstCluster: string; dstNode: string; dstPath: string
  speedKBps: number; plexScan: boolean; state: JobState; preview: any; progress: any; error: string | null; attempts: number
  createdBy: string; createdAt: Date; updatedAt: Date; startedAt: Date | null; finishedAt: Date | null
}
export interface JobStore {
  create(r: Omit<JobRow, 'createdAt' | 'updatedAt'>): Promise<JobRow>
  update(id: string, patch: Partial<JobRow>): Promise<JobRow>
  list(): Promise<JobRow[]>
  get(id: string): Promise<JobRow | null>
}
export class MemoryJobStore implements JobStore {
  rows = new Map<string, JobRow>()
  async create(r: Omit<JobRow, 'createdAt' | 'updatedAt'>) { const row = { ...r, createdAt: new Date(), updatedAt: new Date() } as JobRow; this.rows.set(r.id, row); return { ...row } }
  async update(id: string, patch: Partial<JobRow>) { const row = { ...this.rows.get(id)!, ...patch, updatedAt: new Date() }; this.rows.set(id, row); return { ...row } }
  async list() { return [...this.rows.values()].sort((a, b) => +b.createdAt - +a.createdAt).map(r => ({ ...r })) }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : null }
}
export class PrismaJobStore implements JobStore {
  constructor(private db: PrismaClient) {}
  private t() { return (this.db as any).fileCopyJob }
  async create(r: Omit<JobRow, 'createdAt' | 'updatedAt'>) { return this.t().create({ data: r }) }
  async update(id: string, patch: Partial<JobRow>) { return this.t().update({ where: { id }, data: patch }) }
  async list() { return this.t().findMany({ orderBy: { createdAt: 'desc' }, take: 100 }) }
  async get(id: string) { return this.t().findUnique({ where: { id } }) }
}

let jobs: JobStore = new MemoryJobStore()
export function setJobStore(s: JobStore): void { jobs = s }
export function jobStore(): JobStore { return jobs }

export async function startCopy(previewId: string, owner: string): Promise<JobRow> {
  const p = previews.get(previewId)
  if (!p || p.owner !== owner) throw new ClusterRefusal('No such preview. Preview again.', 'not-found')
  if (Date.now() - p.at > PREVIEW_MS) { previews.delete(previewId); throw new ClusterRefusal('That preview is older than 15 minutes. Preview again.') }
  previews.delete(previewId)
  const i = p.input
  const row = await jobs.create({
    id: randomUUID(), mode: 'copy', srcCluster: i.src.cluster, srcNode: i.src.node, srcPath: i.src.path, dstCluster: i.dst.cluster, dstNode: i.dst.node, dstPath: i.dst.path,
    speedKBps: i.speedKBps, plexScan: i.plexScan, state: 'queued', preview: p.result, progress: {}, error: null, attempts: 0, createdBy: owner, startedAt: null, finishedAt: null,
  })
  await auditCredentialUse('cluster.files.copy', `cluster:${i.dst.cluster}`, { by: owner, from: i.src.cluster, files: p.result.files })
  return row
}

// The run script, read from apps/api/scripts (two levels above both src/lib/clusters and dist/lib/clusters).
export function runScript(): string { return fs.readFileSync(path.join(__dirname, '../../../scripts/xfer-run.sh'), 'utf8') }

const RUN_DIR = (id: string) => `/run/hyperprox-xfer/${id}`

/** Start a job's detached runner on the source node. */
export async function launchScript(job: JobRow, key: SendKey | null, dstRel: string, srcRoot = '', dstRoot = ''): Promise<string> {
  const env = [
    `SRC_ROOT=${q(srcRoot)}`, `DST_ROOT=${q(dstRoot)}`,
    `JOB_ID=${q(job.id)}`, `MODE=${q(job.mode)}`, `SRC=${q(job.srcPath)}`, `DST_PATH=${q(job.dstPath)}`, `DST_REL=${q(dstRel)}`, `BWLIMIT=${Math.max(0, job.speedKBps | 0)}`,
    `DST_HOST=${q(key ? key.dstAddress : '')}`, `DST_HOST_URI=${q(key ? hostUri(key.dstAddress) : '')}`,
  ].join('\n')
  const parts = [
    'set -e', 'umask 077', `D=${q(RUN_DIR(job.id))}`, 'mkdir -p /run/hyperprox-xfer', 'chmod 700 /run/hyperprox-xfer',
    '[ -f "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null && { echo "ALREADY-RUNNING"; exit 0; }',
    'rm -rf "$D"; mkdir -m 700 "$D"',
    `cat > "$D/job.env" <<'HPXENV'\n${env}\nHPXENV`,
    `cat > "$D/run.sh" <<'HPXRUN'\n${runScript()}\nHPXRUN`,
  ]
  if (key) parts.push(`cat > "$D/key" <<'HPXKEY'\n${key.private.trim()}\nHPXKEY`, `cat > "$D/known_hosts" <<'HPXKH'\n${key.knownHosts.trim()}\nHPXKH`)
  parts.push('command -v rsync >/dev/null 2>&1 || { echo "NO-RSYNC"; rm -rf "$D"; exit 0; }', 'setsid bash "$D/run.sh" </dev/null >/dev/null 2>&1 &', 'echo $! > "$D/pid"', 'echo "STARTED"')
  return parts.join('\n')
}

export const POLL_SCRIPT = (id: string) => [
  `D=${q(RUN_DIR(id))}`, '[ -d "$D" ] || { echo "GONE"; exit 0; }',
  'echo "HPX-STATUS-BEGIN"; cat "$D/status" 2>/dev/null; echo "HPX-STATUS-END"',
  `echo "HPX-PROGRESS $(tail -c 4000 "$D/log" 2>/dev/null | tr '\\r' '\\n' | grep -E '^ *[0-9,]+ +[0-9]+%' | tail -1)"`,
  'if [ -f "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; then echo "ALIVE"; else echo "DEAD"; fi',
].join('\n')

export const CLEAN_SCRIPT = (id: string) => `D=${q(RUN_DIR(id))}\n[ -f "$D/pid" ] && kill -TERM -- -"$(cat "$D/pid")" 2>/dev/null; sleep 1; rm -rf "$D"; echo CLEANED`

export interface Poll { gone: boolean; alive: boolean; lines: string[]; percent: number | null; done: number | null; rate: string | null; eta: string | null }

export function parsePoll(out: string): Poll {
  if (/^GONE$/m.test(out)) return { gone: true, alive: false, lines: [], percent: null, done: null, rate: null, eta: null }
  const lines = (/HPX-STATUS-BEGIN\n([\s\S]*?)HPX-STATUS-END/.exec(out)?.[1] ?? '').split('\n').filter(Boolean)
  const prog = /^HPX-PROGRESS\s+([\d,]+)\s+(\d+)%\s+(\S+)\s+(\S+)/m.exec(out)
  return {
    gone: false, alive: /^ALIVE$/m.test(out), lines,
    percent: prog ? Number(prog[2]) : null, done: prog ? Number(prog[1].replace(/,/g, '')) : null, rate: prog ? prog[3] : null, eta: prog ? prog[4] : null,
  }
}

/**
 * Both ends of a job, checked as at preview: inside an allowed folder by name, and by real path (links resolved)
 * on each node. Throws a ClusterRefusal in plain words.
 */
export async function recheckJob(j: JobRow, runner: NodeRunner): Promise<{ srcRoot: string; dstRoot: string }> {
  const sRow = clusterRow(j.srcCluster), dRow = clusterRow(j.dstCluster)
  if (!sRow || !dRow) throw new ClusterRefusal('A cluster in this job was removed.')
  const srcRoot = rootFor(j.srcPath, sRow.allowedRoots)
  if (!srcRoot) throw new ClusterRefusal(`${j.srcPath} is no longer inside one of ${sRow.name}'s allowed folders.`)
  const dstRoot = rootFor(j.dstPath, dRow.allowedRoots)
  if (!dstRoot) throw new ClusterRefusal(`${j.dstPath} is no longer inside one of ${dRow.name}'s allowed folders.`)
  parseContainment((await runner.run(j.srcCluster, j.srcNode, containmentScript(j.srcPath, srcRoot, false))).output, sRow.name, j.srcPath)
  parseContainment((await runner.run(j.dstCluster, j.dstNode, containmentScript(j.dstPath, dstRoot, true))).output, dRow.name, j.dstPath)
  return { srcRoot, dstRoot }
}

/** One step of the runner: start the oldest queued job when none runs, and follow running ones. */
export class CopyRunner {
  private busy = false
  private timer: NodeJS.Timeout | null = null
  constructor(private runner: NodeRunner = liveNodeRunner, private plex: (clusterId: string) => Promise<string | null> = plexScan, private log: (m: string) => void = () => {}) {}

  start(everyMs = 10_000): void { if (!this.timer) { this.timer = setInterval(() => { void this.tick() }, everyMs); this.timer.unref?.() } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async tick(): Promise<void> {
    if (this.busy || !isUnlocked()) return
    this.busy = true
    try {
      const all = await jobs.list()
      for (const j of all.filter(x => x.state === 'running')) await this.follow(j)
      if (!all.some(x => x.state === 'running')) {
        const next = all.filter(x => x.state === 'queued').sort((a, b) => +a.createdAt - +b.createdAt)[0]
        if (next) await this.launch(next)
      }
    } catch (e: any) { this.log(`[files] ${e?.message ?? e}`) } finally { this.busy = false }
  }

  async launch(j: JobRow): Promise<void> {
    try {
      // Checked again now, not only at preview: folders and links may have changed since.
      const { srcRoot, dstRoot } = await recheckJob(j, this.runner)
      const sameNode = j.srcCluster === j.dstCluster && j.srcNode === j.dstNode
      const key = sameNode ? null : await sendKey(j.srcCluster, j.dstCluster, j.dstNode, dstRoot)
      if (!sameNode && !key) throw new Error('The sending key is gone; set up sending again.')
      const out = await this.runner.run(j.srcCluster, j.srcNode, await launchScript(j, key, j.dstPath === dstRoot ? '.' : j.dstPath.slice(dstRoot.length + 1), srcRoot, sameNode ? dstRoot : ''))
      if (/NO-RSYNC/.test(out.output)) throw new Error(`rsync is not installed on ${j.srcNode}.`)
      if (!/STARTED|ALREADY-RUNNING/.test(out.output)) throw new Error(`The copy did not start on ${j.srcNode}.`)
      await jobs.update(j.id, { state: 'running', startedAt: j.startedAt ?? new Date(), attempts: j.attempts + 1, error: null, progress: { phase: 'copy' } })
    } catch (e: any) {
      await jobs.update(j.id, { state: 'failed', error: e?.message ?? String(e), finishedAt: new Date() })
    }
  }

  async follow(j: JobRow): Promise<void> {
    let out: string
    try { out = (await this.runner.run(j.srcCluster, j.srcNode, POLL_SCRIPT(j.id), 30_000)).output }
    catch (e: any) { await jobs.update(j.id, { progress: { ...(j.progress ?? {}), note: `Cannot reach ${j.srcNode} right now (${e?.message ?? e}); the copy carries on there and HyperProx will look again.` } }); return }
    const p = parsePoll(out)
    if (p.gone) { await jobs.update(j.id, { state: 'interrupted', error: `The copy's working folder on ${j.srcNode} is gone (was the node restarted?). Resume to carry on: files already copied are skipped.`, finishedAt: new Date() }); return }
    const phase = [...p.lines].reverse().find(l => l.startsWith('phase '))?.slice(6) ?? 'copy'
    const end = p.lines.find(l => l.startsWith('end '))?.slice(4)
    const err = [...p.lines].reverse().find(l => l.startsWith('error '))?.slice(6) ?? null
    const copied = Number(p.lines.find(l => l.startsWith('copied '))?.slice(7) ?? NaN)
    const verified = Number(p.lines.find(l => l.startsWith('verified '))?.slice(9) ?? NaN)
    const retries = p.lines.filter(l => l.startsWith('retry ') || l.startsWith('mismatch ')).slice(-3)
    const progress = { phase, percent: p.percent, bytesDone: p.done, rate: p.rate, eta: p.eta, copied: Number.isFinite(copied) ? copied : null, verified: Number.isFinite(verified) ? verified : null, notes: retries }
    if (end || !p.alive) {
      const state: JobState = end === 'done' ? 'done' : end === 'cancelled' ? 'cancelled' : 'failed'
      let plexNote: string | null = null
      if (state === 'done' && j.plexScan) plexNote = await this.plex(j.dstCluster).catch((e: any) => `Plex was not asked to scan: ${e?.message ?? e}`)
      await jobs.update(j.id, { state, progress: { ...progress, percent: state === 'done' ? 100 : progress.percent, plex: plexNote }, error: state === 'done' ? null : err ?? (end ? null : 'The copy stopped without saying why.'), finishedAt: new Date() })
      await this.runner.run(j.srcCluster, j.srcNode, CLEAN_SCRIPT(j.id)).catch(() => undefined)
      return
    }
    await jobs.update(j.id, { progress })
  }

  async cancel(id: string): Promise<JobRow> {
    const j = await jobs.get(id)
    if (!j) throw new ClusterRefusal('No such job.', 'not-found')
    if (j.state === 'queued') return jobs.update(id, { state: 'cancelled', finishedAt: new Date() })
    if (j.state !== 'running') throw new ClusterRefusal('That job is not running.')
    await this.runner.run(j.srcCluster, j.srcNode, CLEAN_SCRIPT(j.id))
    return jobs.update(id, { state: 'cancelled', finishedAt: new Date(), error: 'Cancelled. Files already copied stay; nothing was deleted.' })
  }

  async resume(id: string): Promise<JobRow> {
    const j = await jobs.get(id)
    if (!j) throw new ClusterRefusal('No such job.', 'not-found')
    if (!['failed', 'interrupted', 'cancelled'].includes(j.state)) throw new ClusterRefusal('Only a stopped job can be resumed.')
    await recheckJob(j, this.runner)
    return jobs.update(id, { state: 'queued', error: null, finishedAt: null })
  }
}

// ---------------------------------------------------------------------------
//  Plex
// ---------------------------------------------------------------------------

export async function deletePlexToken(clusterId: string): Promise<void> {
  await deleteCredential('cluster-plex', clusterId, 'token').catch(() => undefined)
}

/** Private, link-local, loopback or tailnet (the shared CGNAT /10 Tailscale uses) IPv4, or a ULA / link-local / loopback IPv6. */
export function privateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
}

/** Plain http only to a private address; anything else must be https (the token travels in a header). */
export function checkPlexUrl(url: string): void {
  let u: URL
  try { u = new URL(url) } catch { throw new ClusterRefusal('The Plex address looks like http://10.0.0.5:32400.') }
  if (u.protocol === 'http:' && !privateAddress(u.hostname)) throw new ClusterRefusal('Plex over plain http is allowed only to a private address (a LAN, Tailscale or WireGuard IP). Use https for anything else.')
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ClusterRefusal('The Plex address must start with http:// or https://.')
}

export async function savePlex(clusterId: string, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw new ClusterRefusal('That does not look like a Plex token.')
  await setCredential('cluster-plex', clusterId, 'token', token, true)
}

/** Ask the destination's Plex to scan every library. Answers in words; never throws for Plex's own refusals. */
export async function plexScan(clusterId: string): Promise<string | null> {
  const row = clusterRow(clusterId)
  if (!row?.plexUrl) return 'No Plex is set for that server, so none was asked to scan.'
  try { checkPlexUrl(row.plexUrl) } catch (e: any) { return `Plex was not asked: ${e.message}` }
  const token = await getCredential('cluster-plex', clusterId, 'token')
  if (!token) return 'No Plex token is saved for that server, so Plex was not asked.'
  const headers = { Accept: 'application/json', 'X-Plex-Token': token }
  const res = await fetch(`${row.plexUrl}/library/sections`, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return `Plex answered ${res.status}, so it was not asked to scan.`
  const j: any = await res.json().catch(() => null)
  const keys: string[] = (j?.MediaContainer?.Directory ?? []).map((d: any) => String(d.key)).filter((k: string) => /^\d+$/.test(k))
  let ok = 0
  for (const k of keys) { const r = await fetch(`${row.plexUrl}/library/sections/${k}/refresh`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null); if (r?.ok) ok++ }
  return `Plex was asked to scan ${ok} of ${keys.length} libraries.`
}
