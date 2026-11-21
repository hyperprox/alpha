// =============================================================================
//  HyperProx — MikroTik change engine: the shapes every router write is made of
//
//  A change is a PLAN: an ordered list of steps. Each step is one operation on the router (what to do, in plain
//  words) and the operations that put it back. Operations name rows by what is in them ("the NAT rule whose comment
//  is ..."), never by the router's internal id, because a row that has not been made yet has no id, and because the
//  same description can be written as a RouterOS script for the router's own dead-man undo (script.ts).
// =============================================================================

export type Where = Record<string, string>

export type Op =
  /** Add a row. `top` puts it first among the rules of its table (firewall rules only). */
  | { kind: 'add'; path: string; props: Record<string, string>; top?: boolean }
  /** Change the rows that match `where`. At least one must match. */
  | { kind: 'set'; path: string; where: Where; props: Record<string, string> }
  /** Remove the rows that match `where`. Matching nothing is fine (the row is already gone). */
  | { kind: 'remove'; path: string; where: Where }
  /** Run a command on the rows that match (`/ip/dhcp-server/lease/make-static`). */
  | { kind: 'command'; path: string; where: Where }

export interface PlanStep {
  /** One plain-English sentence: what this step does. */
  words: string
  forward: Op
  /** The operations that undo this step, in the order to run them. */
  inverse: Op[]
}

export interface ChangePlan {
  /** What the plan is, for the history ("Block internet for laptop"). */
  title: string
  kind: string
  steps: PlanStep[]
  /** Plain sentences to show next to the plan (a risky port, no hairpin rule...). Not refusals. */
  warnings: string[]
  /** Set when the person must tick an extra box before this can run (a risky port). The sentence to show. */
  needsTick: string | null
  /** Test the internet path (ping) before and after. */
  checkWan: boolean
}

export class ChangeRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'ChangeRefusal' }
}

/** The router as the engine uses it. `patch` is how a row is changed. */
export interface ChangeRouter {
  get(path: string, timeoutMs?: number): Promise<any>
  put(path: string, body: unknown, timeoutMs?: number): Promise<any>
  patch?(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any>
  delete(path: string, timeoutMs?: number): Promise<any>
  post?(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any>
}

/** How HyperProx itself reaches the router: what must never be cut. */
export interface Management {
  /** The router address HyperProx connects to. */
  host: string
  /** 'www' (http) or 'www-ssl' (https), or 'api' / 'api-ssl' when set so. */
  service: string
  port: number | null
  /** The router user HyperProx signs in as. */
  username?: string
  /** The internet-facing links, as the page reads them. */
  wan: string[]
  /** HyperProx's own address, when known: a block must never name it. */
  selfAddress?: string
}

export type Row = Record<string, any>

export interface HistoryEntry {
  id: string
  at: string
  by: string
  kind: string
  title: string
  /** The plain words of each step. */
  steps: string[]
  status: 'applied' | 'undone' | 'rolled-back' | 'failed'
  /** Set on an entry that undid another. */
  undoOf?: string
  undoneAt?: string
  undoneBy?: string
  /** What was done and what puts it back, step by step: kept to undo exactly this. Never sent to the page. */
  ops: Array<{ forward: Op; inverse: Op[] }>
  backup?: { id: string; bytes: number; truncated: boolean }
  note?: string
}

/** What the page may see of a history entry. */
export type HistoryView = Omit<HistoryEntry, 'ops'> & { canUndo: boolean }

export const opPath = (p: string) => `/rest${p}`
