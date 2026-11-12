// =============================================================================
//  HyperProx — the assistant's knowledge of each Proxmox Backup Server
//
//  Read-only: datastores (use, deduplication, GC), stale backup groups, and the
//  state of the prune, GC, verify and sync jobs. Answers its common questions
//  by code ("is my backup server ok", "which backups are stale", "did GC run",
//  "how full is the datastore"); anything else goes to the model with these
//  lines. Never an address, a token id or a secret: the readers below never put
//  one in, and every line also goes through stripAddresses.
// =============================================================================

import type { AskSource, SourceSummary } from '../ai/ask'
import { stripAddresses } from '../redact-addresses'
import type { PbsReading } from './parse'

export interface PbsEntry { name: string; reading: PbsReading | null; error: string | null }

const clean = (s: string) => stripAddresses(String(s ?? '')).replace(/\s+/g, ' ').trim()
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const tib = (b: number | null) => (b === null ? 'unknown' : b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TiB` : `${(b / 1024 ** 3).toFixed(0)} GiB`)
const ago = (h: number | null) => (h === null ? 'never' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`)
const day = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'not scheduled')

function storeLines(n: string, r: PbsReading): string[] {
  return r.datastores.map(d => `${n} datastore ${d.store}: ${d.usedFrac === null ? 'size unknown' : `${Math.round(d.usedFrac * 100)}% used (${tib(d.used)} of ${tib(d.total)})`}` +
    `${d.dedup !== null ? `, deduplication ${d.dedup.toFixed(2)}x` : ''}, last GC ${d.gc.lastState ? `${d.gc.lastState} ${day(d.gc.lastEnd)}` : 'never'}${d.error ? `, ${d.error}` : ''}.`)
}

function staleLine(n: string, r: PbsReading): string {
  const stale = r.groups.filter(g => g.stale)
  if (!stale.length) return `${n}: no stale backup groups (all ${r.groups.length} have a snapshot in the last ${r.staleHours} h).`
  return `${n}: ${plural(stale.length, 'stale group')} (no snapshot in ${r.staleHours} h): ` +
    stale.slice(0, 12).map(g => `${g.type}/${g.id}${g.ns ? ` in ${g.ns}` : ''} last ${ago(g.ageHours)}`).join('; ') + (stale.length > 12 ? `; and ${stale.length - 12} more` : '') + '.'
}

function jobLines(n: string, r: PbsReading): string[] {
  if (!r.jobs.length) return [`${n}: no prune, GC, verify or sync jobs.`]
  return [`${n} jobs: ` + r.jobs.map(j => `${j.kind} ${j.id} on ${j.store} ${j.result === 'failed' ? `FAILED (${j.detail ?? 'error'})` : j.result}, last ${day(j.lastEnd)}, next ${day(j.next)}`).join('; ') + '.']
}

export function pbsSummary(list: PbsEntry[]): SourceSummary {
  if (!list.length) return { headline: 'Backup server: none is added.', lines: ['No Proxmox Backup Server is added to HyperProx. An admin adds one on the Proxmox Backup Server plug-in page.'], data: { list } }
  const lines: string[] = []
  const unread: string[] = []
  for (const e of list) {
    if (!e.reading) { lines.push(`${e.name}: could not be read (${e.error ?? 'no answer'}).`); unread.push(e.name); continue }
    const r = e.reading
    lines.push(`${e.name}: ${r.health.state === 'active' ? 'active, nothing needs attention' : `needs attention: ${r.health.reasons.join('; ')}`}.`)
    lines.push(...storeLines(e.name, r), staleLine(e.name, r), ...jobLines(e.name, r))
    if (r.failedTasks.length) lines.push(`${e.name} failed tasks in 24 h: ` + r.failedTasks.slice(0, 8).map(t => `${t.type}${t.target ? ` ${t.target}` : ''}: ${t.status}`).join('; ') + '.')
  }
  const bad = list.filter(e => e.reading && e.reading.health.state !== 'active').length
  return {
    headline: `Backup server: ${plural(list.length, 'server')}, ${bad ? `${bad} need${bad === 1 ? 's' : ''} attention` : unread.length === list.length ? 'none could be read' : 'all active'}.`,
    lines: lines.map(clean), unread: unread.length ? unread : undefined, data: { list },
  }
}

export function pbsAnswer(prompt: string, s: SourceSummary): string | null {
  const list = ((s.data as { list?: PbsEntry[] })?.list ?? [])
  if (!list.length) return s.lines[0] ?? null
  const p = prompt.toLowerCase()
  const read = list.filter(e => e.reading)
  if (!read.length) return s.lines.join(' ') || null
  let out: string[] | null = null
  if (/\b(stale|old|missed|missing|not backed up|out of date|last backup|newest)\b/.test(p)) out = read.map(e => staleLine(e.name, e.reading!))
  else if (/\b(full|space|used|usage|capacity|dedup\w*|datastores?|size)\b/.test(p)) out = read.flatMap(e => storeLines(e.name, e.reading!))
  else if (/\b(jobs?|gc|garbage|prune|verif\w*|sync|schedule)\b/.test(p)) out = read.flatMap(e => jobLines(e.name, e.reading!))
  else if (/\b(ok|okay|fine|health\w*|status|working|problems?|issues?|wrong|attention|failed|failures?)\b/.test(p)) {
    out = read.map(e => e.reading!.health.state === 'active' ? `${e.name} is active: every datastore is under 85%, no group is stale and nothing failed in 24 h.` : `${e.name} needs attention: ${e.reading!.health.reasons.join('; ')}.`)
  }
  return out ? out.map(clean).join(' ') : null
}

export function pbsSource(d: { list(): Promise<PbsEntry[]>; unlocked(): boolean }): AskSource {
  return {
    id: 'pbs', title: 'Proxmox Backup Server', blurb: 'each backup server: datastores, stale backup groups, prune/GC/verify/sync jobs',
    aliases: /\b(pbs|backup servers?|datastores?|garbage collection|gc|verif\w*|prune|stale backups?|dedup\w*)\b/,
    load: async () => (d.unlocked() ? pbsSummary(await d.list()) : { headline: 'Backup server: locked.', lines: [], locked: true }),
    answer: pbsAnswer,
  }
}
