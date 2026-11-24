// Production wiring for the operator: Prisma store, the vault for keys, callStructured for transport.
import { getCredential, setCredential, deleteCredential } from '../../credentials'
import { callStructured, type CallUsage } from '../providers'
import { isUnlocked } from '../../vault/state'
import { auditOrThrow } from '../../audit'
import { PrismaOperatorStore } from './store'
import { OperatorService } from './service'
import { setOperatorDeps, type TierCall } from './router'
import { PrismaPlaybookStore, type PlaybookStore } from './playbook-store'
import { buildContext, playbookMatcher } from './context'
import { readLive, type LiveReading } from './live'
import type { AskSource } from '../ask'

const LOCAL_KEY = ['ai', 'operator-local', 'api_key'] as const

/** Sends one structured request to a tier. Local: the stored address and key, nothing global. Cloud: the Anthropic key. */
export function makeCall(baseUrl: () => Promise<string>): TierCall {
  return async a => {
    let usage: CallUsage | null = null
    const onUsage = (u: CallUsage) => { usage = { inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens } }
    const req = { name: a.name, system: a.system, user: a.user, schema: a.schema, parse: (x: unknown) => x }
    if (a.tier === 'local') {
      const apiKey = (await getCredential(...LOCAL_KEY)) ?? ''
      const value = await callStructured(req, undefined, undefined, {
        model: a.model, timeoutMs: a.timeoutMs ?? 330_000, onUsage,
        endpoint: { baseUrl: await baseUrl(), apiKey: apiKey || undefined, model: a.model },
      })
      return { value, usage }
    }
    const value = await callStructured(req, 'anthropic', undefined, { model: a.model, timeoutMs: a.timeoutMs, onUsage })
    return { value, usage }
  }
}

let shared: OperatorService | null = null
let handbook: PlaybookStore | null = null

export interface OperatorWiring {
  /** The read-only areas a question may be about (the Ask box's sources, plus Live TV). Read per question, in the asker's role. */
  sources?: () => AskSource[]
  /** Host and guest names to hide before anything goes to the cloud, beyond the addresses found in the text. */
  knownHosts?: () => Promise<string[]>
}

export function operatorService(prisma?: unknown, wiring: OperatorWiring = {}): OperatorService {
  if (shared) return shared
  if (!prisma) throw new Error('The AI operator needs the database.')
  const store = new PrismaOperatorStore(prisma as any)
  const book = handbookStore(prisma)
  const live = wiring.sources
    ? async (q: string, role?: string): Promise<LiveReading[]> => readLive(q, wiring.sources!(), { cacheKey: `operator:${role ?? ''}` })
    : undefined
  shared = new OperatorService({
    store,
    call: makeCall(async () => (await store.getSettings()).localBaseUrl),
    vaultUnlocked: () => isUnlocked(),
    localKeyStored: async () => !!(await getCredential(...LOCAL_KEY)),
    anthropicKeyStored: async () => !!(await getCredential('ai', 'anthropic', 'api_key')),
    saveLocalKey: v => setCredential(...LOCAL_KEY, v, true),
    clearLocalKey: () => deleteCredential(...LOCAL_KEY),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    knownHosts: wiring.knownHosts,
    playbooks: book,
    matcher: playbookMatcher(book),
    context: (q, who) => buildContext(q, { store: book, live: live ? x => live(x, who.role) : undefined }),
  })
  // The chat-connector seam: askOperator() with no deps argument uses these.
  setOperatorDeps(shared.routerDeps())
  return shared
}

/** The handbook's store, for the playbook routes and the importer. */
export function handbookStore(prisma: unknown): PlaybookStore {
  return (handbook ??= new PrismaPlaybookStore(prisma as any))
}

export function currentOperatorService(): OperatorService | null { return shared }
/** Tests, and a build with no database. */
export function setOperatorService(s: OperatorService | null): void { shared = s }
