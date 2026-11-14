// The AI assistant page's header and input state, with or without a model. Without one the assistant still
// answers what HyperProx reads directly (questions answered by code, and actions, which code reads), so the
// input and the example chips stay usable; a "Connect a model for more" panel says what a model adds.
// Kept free of CSS so it can be tested in Node.

export interface AssistantMode {
  /** The input, the send button and the example chips: usable whenever nothing is in flight. */
  inputEnabled: boolean
  title: string
  eyebrow: string
  status: { value: string; tone: 'good' | 'warn' }
  /** Show the "Connect a model for more" panel. */
  showConnectModel: boolean
  panelSub: string
}

export function assistantMode(o: { providerReady: boolean; planning: boolean; providerName?: string | null; model?: string | null }): AssistantMode {
  if (o.providerReady) {
    return {
      inputEnabled: !o.planning, title: 'Ready to plan', eyebrow: `${o.providerName ?? 'provider'} · ${o.model ?? ''}`,
      status: { value: 'READY', tone: 'good' }, showConnectModel: false, panelSub: 'ask or deploy',
    }
  }
  return {
    inputEnabled: !o.planning, title: 'Answers without a model',
    eyebrow: `${o.providerName ?? 'No AI provider'} not connected · built-in answers only`,
    status: { value: 'NO MODEL', tone: 'warn' }, showConnectModel: true, panelSub: 'built-in answers',
  }
}

/** Example chips: each is asked as it is, straight away (a chip that only fills a box is a chip that does nothing). */
export function exampleChips(hasRemote: boolean): string[] {
  return [
    hasRemote ? 'How is each cluster doing?' : 'Deploy Nextcloud at cloud.mydomain.com',
    'Is my NAS healthy?',
    'What alerts are firing?',
    'Which lights are on in the living room?',
    'Is my website up?',
    'Create a WordPress website at blog.mydomain.com',
  ]
}

/** What works without a model, and what connecting one adds: the panel's words. */
export const CONNECT_MODEL_WORDS = {
  title: 'Connect a model for more',
  works: 'Without a model, the assistant answers from what HyperProx reads directly: cluster health, alerts, the NAS, websites, backups, and actions such as restarting or backing up a guest.',
  adds: 'A model adds planning deployments from plain words and answering open questions. Use a local Ollama or an Anthropic or OpenAI key.',
}
