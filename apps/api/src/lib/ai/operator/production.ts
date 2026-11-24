// Production wiring for the operator: Prisma store, the vault for keys, callStructured for transport.
import { getCredential, setCredential, deleteCredential } from '../../credentials'
import { callStructured, type CallUsage } from '../providers'
import { isUnlocked } from '../../vault/state'
import { auditOrThrow } from '../../audit'
import { PrismaOperatorStore } from './store'
import { OperatorService } from './service'
import { setOperatorDeps, type TierCall } from './router'

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
        model: a.model, timeoutMs: a.timeoutMs, onUsage,
        endpoint: { baseUrl: await baseUrl(), apiKey: apiKey || undefined, model: a.model },
      })
      return { value, usage }
    }
    const value = await callStructured(req, 'anthropic', undefined, { model: a.model, timeoutMs: a.timeoutMs, onUsage })
    return { value, usage }
  }
}

let shared: OperatorService | null = null

export function operatorService(prisma?: unknown): OperatorService {
  if (shared) return shared
  if (!prisma) throw new Error('The AI operator needs the database.')
  const store = new PrismaOperatorStore(prisma as any)
  shared = new OperatorService({
    store,
    call: makeCall(async () => (await store.getSettings()).localBaseUrl),
    vaultUnlocked: () => isUnlocked(),
    localKeyStored: async () => !!(await getCredential(...LOCAL_KEY)),
    anthropicKeyStored: async () => !!(await getCredential('ai', 'anthropic', 'api_key')),
    saveLocalKey: v => setCredential(...LOCAL_KEY, v, true),
    clearLocalKey: () => deleteCredential(...LOCAL_KEY),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
  })
  // The chat-connector seam: askOperator() with no deps argument uses these.
  setOperatorDeps(shared.routerDeps())
  return shared
}

export function currentOperatorService(): OperatorService | null { return shared }
/** Tests, and a build with no database. */
export function setOperatorService(s: OperatorService | null): void { shared = s }
