// What needs attention on the dashboard, built once: the headline counts exactly what the "What's happening"
// list shows. No imports of components (the tests load this file directly).
import { isDeliberatelyStopped, cephHealthWord } from './summaries'

export type AttnTone = 'ok' | 'warn' | 'bad' | 'off'
export interface AttnItem { key: string; title: string; detail?: string; meta?: string; tone: AttnTone }

export interface AttnInput {
  nodes: Array<{ node: string; status: string }>
  quorate: boolean | null
  ceph: { status?: string; checks?: Record<string, unknown> } | null
  /** Used share of Proxmox-managed storage, 0-100; null when none is reported. */
  storagePct: number | null
  ha: unknown
  /** Services that answered "unreachable" (not "not configured"). */
  unreachable: Array<{ key: string; name: string; message?: string }>
  alerts: Array<{ name: string; severity: string; state: string; node?: string; summary?: string; description?: string; firedAt?: string }> | null
}

const INTENTIONAL = new Set(['POOL_NO_REDUNDANCY'])

export function buildAttention(i: AttnInput): AttnItem[] {
  const out: AttnItem[] = []
  for (const n of i.nodes) if (n.status !== 'online') out.push({ key: `node-${n.node}`, title: `${n.node} is offline`, tone: 'bad', meta: 'node' })
  if (i.quorate === false) out.push({ key: 'quorum', title: 'The cluster has no quorum', tone: 'bad', meta: 'cluster' })
  if (i.storagePct !== null && i.storagePct >= 85) out.push({ key: 'storage', title: `Storage is ${i.storagePct}% full`, tone: 'warn', meta: 'storage' })
  // With Ceph's own checks listed below, its whole-cluster alert would count the same warning again (Monitoring
  // drops it the same way: lib/monitoring-title.ts withCephAlerts), so both pages give the same number.
  const cephChecks = Object.keys(i.ceph?.checks ?? {}).length > 0
  for (const a of i.alerts ?? []) {
    if (a.state !== 'firing') continue
    if (cephChecks && /^CephHealth(Warning|Error)$/.test(a.name)) continue
    out.push({
      key: `alert-${a.name}-${a.node ?? ''}-${a.firedAt ?? ''}`, title: a.summary || a.name, detail: a.description || undefined,
      tone: a.severity === 'critical' ? 'bad' : 'warn',
      meta: [a.node, a.severity, a.firedAt && `since ${new Date(a.firedAt).toLocaleString()}`].filter(Boolean).join(' · '),
    })
  }
  if (i.ceph) {
    for (const key of Object.keys(i.ceph.checks ?? {})) {
      out.push({ key: `ceph-${key}`, title: `Ceph: ${key}`, detail: INTENTIONAL.has(key) ? '(intentional)' : undefined,
        tone: INTENTIONAL.has(key) ? 'off' : i.ceph.status === 'HEALTH_ERR' ? 'bad' : 'warn', meta: 'storage' })
    }
  }
  for (const h of Array.isArray(i.ha) ? i.ha : []) {
    if (h?.type === 'service' && h.crm_state && h.crm_state !== 'started' && !isDeliberatelyStopped(h)) {
      out.push({ key: `ha-${h.id}`, title: `${h.sid ?? h.id} is ${h.crm_state}`, tone: 'warn', meta: 'high availability' })
    }
  }
  for (const s of i.unreachable) out.push({ key: `svc-${s.key}`, title: `${s.name} is unreachable`, detail: s.message, tone: 'bad', meta: 'service' })
  return out
}

/** Items that count towards "N things need attention": a problem or a warning, not an inactive note. */
export const attentionItems = (items: AttnItem[]) => items.filter(x => x.tone === 'bad' || x.tone === 'warn')

export function attentionTitle(items: AttnItem[], cephStatus?: string): string {
  const n = attentionItems(items).length
  if (n) return `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention`
  return cephStatus === 'HEALTH_WARN' ? `Running · Ceph reports a ${cephHealthWord(cephStatus)}` : 'All systems normal'
}
