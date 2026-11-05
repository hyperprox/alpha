// Client-side shapes of /api/ha (apps/api/src/lib/ha). Kept here rather than in packages/types so the
// HA components stay one folder another branch can mount without touching shared registries.

export type HomeMode = 'none' | 'prefer' | 'only'
export interface HomeChoice { mode: HomeMode; tiers: string[][] }
export interface NodePriority { node: string; priority: number }

export interface HaRule {
  id: string
  type: 'node-affinity' | 'resource-affinity'
  affinity: 'positive' | 'negative'
  strict?: boolean
  nodes?: NodePriority[]
  resources: string[]
  disabled: boolean
  comment?: string
  order?: number
}

export interface RuleProblem { code: string; rules: string[]; message: string; fix?: { kind: 'flatten'; rule: string; words: string } }

export interface HaResource { sid: string; state: string; maxRestart: number; maxRelocate: number; failback: boolean; autoRebalance: boolean; comment?: string; group?: string }

export interface GuestHa {
  sid: string; vmid: number; type: 'lxc' | 'qemu'; name: string; node: string; status: string
  protected: boolean; resource: HaResource | null; haState: string | null
  home: { rule: HaRule | null; choice: HomeChoice; avoid: string[]; disabled: boolean; sharedWith: string[]; words: string }
  together: Array<{ rule: string; with: string[]; disabled: boolean }>
  apart: Array<{ rule: string; with: string[]; disabled: boolean }>
  prediction: { to: string | null; candidates: string[]; words: string } | null
  statusLine: string
  hardware: string[]
  warnings: string[]
  nodes: Array<{ node: string; online: boolean; maintenance: boolean }>
  others: Array<{ sid: string; name: string; node: string }>
  quorate: boolean
  fencing: string
}

export interface HaPlan {
  id: string; action: string; title: string; changes: string[]; effects: string[]; warnings: string[]
  strict: boolean; existing: RuleProblem[]; calls: string[]; expiresAt: string
}

export interface HaApplyResult { ok: boolean; message: string; mismatch: string[]; done: string[] }

export interface Headroom { rule: string; guests: string[]; eligible: string[]; online: string[]; slack: number; level: 'ok' | 'tight' | 'none' | 'broken'; words: string }

export interface Overview {
  cluster: { quorate: boolean; fencing: string; headline: string; detail: string[] }
  nodes: Array<{ node: string; online: boolean; maintenance: boolean; haGuests: number }>
  protected: Array<{ sid: string; vmid: number; type: string; name: string; node: string; state: string; home: string; homeless: boolean; failover: string; to: string | null }>
  unprotected: Array<{ sid: string; vmid: number; type: 'lxc' | 'qemu'; name: string; node: string; status: string; words: string }>
  homeless: Array<{ sid: string; name: string; node: string; words: string }>
  hardware: Array<{ sid: string; name: string; node: string; needs: string[]; words: string }>
  headroom: Headroom[]
  rules: Array<{ rule: HaRule; words: string; problems: RuleProblem[] }>
  problems: RuleProblem[]
  counts: { protected: number; unprotected: number; homeless: number; hardware: number; tightHeadroom: number }
}

export interface Preflight {
  sid: string; node: string; running: boolean; summary: string
  rows: Array<{ node: string; current: boolean; allowed: boolean; reasons: string[]; notes: string[] }>
}

/** What a list badge needs, per guest (GET /api/ha/badges → Record<sid, HaBadgeInfo>). */
export interface HaBadgeInfo { sid: string; protected: boolean; state: string | null; home: 'none' | 'prefer' | 'only' | 'avoid'; homeNodes: string[]; warn: string | null }

export const sidOf = (type: 'lxc' | 'qemu', vmid: number) => `${type === 'lxc' ? 'ct' : 'vm'}:${vmid}`
export const guestPath = (sid: string) => { const [t, id] = sid.split(':'); return `/api/ha/guests/${t === 'ct' ? 'lxc' : 'qemu'}/${id}` }
