// =============================================================================
//  HyperProx — Open WebUI as a catalogue recipe
//
//  A ChatGPT-style page for the models you run yourself. It talks to an Ollama: one HyperProx already knows (the one
//  installed from the Catalogue, or any the AI page is connected to), one you name, or none yet (the install then offers
//  to install Ollama next). The administrator is made by Open WebUI itself on its first start, from the generated
//  password HyperProx puts in the vault, and open sign-up is off: the administrator invites people.
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'

export const OPENWEBUI_RECIPE_ID = 'open-webui'
/** The release this install runs. */
export const OPENWEBUI_VERSION = 'v0.13.4'
export const OPENWEBUI_PORT = 8080

export const OPENWEBUI_OPTIONS: RecipeOption[] = [
  { key: 'OWUI_ADMIN_EMAIL', label: 'Administrator email', kind: 'email', required: true, placeholder: 'you@example.com',
    hint: 'The first account, and the administrator. Open WebUI signs in with an email address. The password is generated and kept in the vault.' },
  { key: 'OWUI_ADMIN_NAME', label: 'Administrator name', kind: 'text', default: 'Administrator', maxLength: 60 },
  { key: 'OWUI_OLLAMA', label: 'Which Ollama to use', kind: 'text', default: 'auto',
    choices: [
      { value: 'auto', label: 'The Ollama HyperProx already knows (if none, offer to install one)' },
      { value: 'address', label: 'An Ollama at an address I give' },
      { value: 'none', label: 'None for now' },
    ],
    hint: 'Open WebUI is only the page; the models run in Ollama. HyperProx checks that the Ollama answers before it installs anything.' },
  { key: 'OWUI_OLLAMA_ADDRESS', label: 'Ollama address', kind: 'text', showWhen: { key: 'OWUI_OLLAMA', value: 'address' }, maxLength: 200, placeholder: 'http://ollama.example.lan:11434', hint: 'Only when you give an address.' },
  // Preview-only: what the preview resolved. A value in a request is never used.
  { key: 'OWUI_OLLAMA_URL', label: 'Ollama address in use', kind: 'text', maxLength: 200, hidden: true },
  { key: 'OWUI_OLLAMA_ENABLED', label: 'Ollama on', kind: 'boolean', default: '0', hidden: true },
]

/** An address Open WebUI may be pointed at: http(s), a host and a port, no login in it, no path. */
export function cleanOllamaUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(String(raw).trim()) } catch { return null }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  if (!u.hostname) return null
  return `${u.protocol}//${u.host}`
}

export function checkOpenWebuiOptions(v: Record<string, string>): string[] {
  const out: string[] = []
  if (v.OWUI_OLLAMA === 'address') {
    if (!v.OWUI_OLLAMA_ADDRESS) out.push('Give the Ollama\'s address, or pick another choice.')
    else if (!cleanOllamaUrl(v.OWUI_OLLAMA_ADDRESS)) out.push('Ollama address: an http:// or https:// address with a host and port and nothing after it, like http://ollama.example.lan:11434.')
  }
  return out
}

/** Open WebUI's compose file. Every secret is read from the private .env beside it, never written into this file. */
export const OPENWEBUI_COMPOSE = `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:${OPENWEBUI_VERSION}
    container_name: open-webui
    restart: unless-stopped
    ports:
      - "${OPENWEBUI_PORT}:8080"
    environment:
      - OLLAMA_BASE_URL=\${OWUI_OLLAMA_URL}
      - ENABLE_OLLAMA_API=\${OWUI_OLLAMA_ENABLED}
      - WEBUI_SECRET_KEY=\${OWUI_SECRET_KEY}
      - WEBUI_ADMIN_EMAIL=\${OWUI_ADMIN_EMAIL}
      - WEBUI_ADMIN_PASSWORD=\${OWUI_ADMIN_PASSWORD}
      - WEBUI_ADMIN_NAME=\${OWUI_ADMIN_NAME}
      # Open sign-up is off: the administrator invites people. API keys are on so HyperProx can be given one.
      - ENABLE_SIGNUP=false
      - DEFAULT_USER_ROLE=pending
      - ENABLE_API_KEYS=true
    volumes:
      - ./data:/app/backend/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`

export const OPENWEBUI_SETUP_STEPS = [
  { id: 'owui-ready', label: 'Wait for Open WebUI to answer' },
  { id: 'owui-key', label: 'Make HyperProx\'s API key and connect the Open WebUI plug-in' },
  { id: 'owui-signup', label: 'Check that open sign-up is off' },
  { id: 'owui-ollama', label: 'Check the Ollama connection' },
] as const

export const OPENWEBUI_RECIPE: CatalogueRecipe = {
  id: OPENWEBUI_RECIPE_ID,
  detect: DETECT[OPENWEBUI_RECIPE_ID],
  name: 'Open WebUI',
  summary: 'A ChatGPT-style page for the models you run yourself: chat, documents, several people, and everything stays on your own machines.',
  keywords: ['chatgpt', 'chat gpt', 'ai chat', 'llm', 'chatbot', 'assistant', 'ollama ui', 'local ai', 'gpt', 'claude', 'openai'],
  category: 'ai',
  port: OPENWEBUI_PORT,
  healthPath: '/health',
  expectStatus: [200],
  needsDocker: true,
  publishable: true,
  // Answers stream token by token and a long one can take minutes: no buffering, long timeouts.
  proxyAdvanced: 'proxy_buffering off;\nproxy_read_timeout 600s;\nproxy_send_timeout 600s;\nclient_max_body_size 100m;',
  defaults: { cores: 2, memoryMb: 4096, diskGb: 20, swapMb: 1024 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 12 },
  sizes: { small: { cores: 2, memoryMb: 2048, diskGb: 12 }, medium: { cores: 2, memoryMb: 4096, diskGb: 20 }, large: { cores: 4, memoryMb: 8192, diskGb: 40 } },
  firstRun: {
    kind: 'env-admin', passwordEnv: 'OWUI_ADMIN_PASSWORD', userEnv: 'OWUI_ADMIN_EMAIL', user: 'admin', userOption: 'OWUI_ADMIN_EMAIL',
    secrets: [{ env: 'OWUI_SECRET_KEY', vaultKey: 'secret_key' }],
  },
  wizard: false,
  firstLogin: 'Sign in with the administrator email you gave. Its password is generated, kept in the vault and shown once after the install. Open sign-up is off: invite people from Admin → Users.',
  notes: [
    `Pinned: Open WebUI ${OPENWEBUI_VERSION}, in /opt/app/docker-compose.yml. An upgrade is a changed tag there, then \`docker compose pull && docker compose up -d\`.`,
    'It is only the page: the models run in Ollama, which may be on any machine. HyperProx finds the Ollama it already knows; if there is none it offers to install one after this.',
    'Open sign-up is off and new accounts start as pending. The administrator is made by Open WebUI itself on its first start from a generated password, which is in the vault.',
    'A public name gets websockets, no response buffering (answers appear as they are written) and ten-minute timeouts at the proxy.',
  ],
  options: OPENWEBUI_OPTIONS,
  checkOptions: checkOpenWebuiOptions,
  setup: 'openwebui',
  install: { kind: 'compose', dir: '/opt/app', compose: OPENWEBUI_COMPOSE },
}
