// =============================================================================
//  HyperProx — Credential Store
//  Runtime source of truth is Postgres (encrypted).
//  .env is seeded on first run only.
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { encrypt, decrypt, mask } from './crypto'

const prisma = new PrismaClient()

export interface CredentialDef {
  category: string
  provider: string
  key:      string
  label:    string
  masked:   boolean
  envKey?:  string   // corresponding .env key to seed from
}

// ---------------------------------------------------------------------------
//  Credential definitions — the full schema of what HyperProx manages
// ---------------------------------------------------------------------------

export const CREDENTIAL_DEFS: CredentialDef[] = [
  // Proxmox
  { category: 'proxmox', provider: 'proxmox', key: 'host',         label: 'Host IP',       masked: false, envKey: 'PROXMOX_HOST' },
  { category: 'proxmox', provider: 'proxmox', key: 'port',         label: 'Port',           masked: false, envKey: 'PROXMOX_PORT' },
  { category: 'proxmox', provider: 'proxmox', key: 'user',         label: 'User',           masked: false, envKey: 'PROXMOX_USER' },
  { category: 'proxmox', provider: 'proxmox', key: 'token_id',     label: 'Token ID',       masked: false, envKey: 'PROXMOX_TOKEN_ID' },
  { category: 'proxmox', provider: 'proxmox', key: 'token_secret', label: 'Token Secret',   masked: true,  envKey: 'PROXMOX_TOKEN_SECRET' },

  // NPM
  { category: 'proxy', provider: 'npm', key: 'url',      label: 'NPM URL',      masked: false, envKey: 'NPM_URL' },
  { category: 'proxy', provider: 'npm', key: 'email',    label: 'Email',        masked: false, envKey: 'NPM_EMAIL' },
  { category: 'proxy', provider: 'npm', key: 'password', label: 'Password',     masked: true,  envKey: 'NPM_PASSWORD' },

  // GoDaddy
  { category: 'dns', provider: 'godaddy', key: 'api_key',    label: 'API Key',    masked: false, envKey: 'GODADDY_API_KEY' },
  { category: 'dns', provider: 'godaddy', key: 'api_secret', label: 'API Secret', masked: true,  envKey: 'GODADDY_API_SECRET' },

  // Cloudflare
  { category: 'dns', provider: 'cloudflare', key: 'api_token', label: 'API Token', masked: true, envKey: 'CLOUDFLARE_API_TOKEN' },
  { category: 'dns', provider: 'cloudflare', key: 'email',     label: 'Email',     masked: false, envKey: 'CLOUDFLARE_EMAIL' },

  // Namecheap
  { category: 'dns', provider: 'namecheap', key: 'api_key',  label: 'API Key',  masked: true,  envKey: 'NAMECHEAP_API_KEY' },
  { category: 'dns', provider: 'namecheap', key: 'username', label: 'Username', masked: false, envKey: 'NAMECHEAP_USERNAME' },

  // Ollama / AI
  { category: 'ai', provider: 'ollama', key: 'url',   label: 'Ollama URL',     masked: false, envKey: 'OLLAMA_URL' },
  { category: 'ai', provider: 'ollama', key: 'model', label: 'Active Model',    masked: false, envKey: 'OLLAMA_MODEL' },

  // HyperProx system
  { category: 'system', provider: 'hyperprox', key: 'app_url',   label: 'App URL',   masked: false, envKey: 'NEXT_PUBLIC_API_URL' },
  { category: 'system', provider: 'hyperprox', key: 'jwt_secret', label: 'JWT Secret', masked: true, envKey: 'JWT_SECRET' },
]

// ---------------------------------------------------------------------------
//  Get a single credential (decrypted)
// ---------------------------------------------------------------------------

export async function getCredential(category: string, provider: string, key: string): Promise<string | null> {
  const row = await prisma.credential.findUnique({
    where: { category_provider_key: { category, provider, key } },
  })
  if (!row) return null
  try { return decrypt(row.value) } catch { return null }
}

// ---------------------------------------------------------------------------
//  Get all credentials for a provider (decrypted map)
// ---------------------------------------------------------------------------

export async function getProviderCredentials(category: string, provider: string): Promise<Record<string, string>> {
  const rows = await prisma.credential.findMany({ where: { category, provider } })
  const result: Record<string, string> = {}
  for (const row of rows) {
    try { result[row.key] = decrypt(row.value) } catch { /* skip corrupt */ }
  }
  return result
}

// ---------------------------------------------------------------------------
//  Set a credential (encrypts before storing)
// ---------------------------------------------------------------------------

export async function setCredential(category: string, provider: string, key: string, value: string, masked = true): Promise<void> {
  await prisma.credential.upsert({
    where:  { category_provider_key: { category, provider, key } },
    update: { value: encrypt(value), updatedAt: new Date() },
    create: { category, provider, key, value: encrypt(value), masked },
  })
}

// ---------------------------------------------------------------------------
//  Get all for a category — returns masked values for UI
// ---------------------------------------------------------------------------

export async function getCategoryForUI(category: string): Promise<Array<{
  provider: string; key: string; label: string; value: string; masked: boolean; isSet: boolean
}>> {
  const defs = CREDENTIAL_DEFS.filter(d => d.category === category)
  const result = []

  for (const def of defs) {
    const row = await prisma.credential.findUnique({
      where: { category_provider_key: { category: def.category, provider: def.provider, key: def.key } },
    })

    let displayValue = ''
    let isSet = false

    if (row) {
      try {
        const plain = decrypt(row.value)
        displayValue = def.masked ? mask(plain) : plain
        isSet = true
      } catch { /* corrupt */ }
    }

    result.push({
      provider: def.provider,
      key:      def.key,
      label:    def.label,
      value:    displayValue,
      masked:   def.masked,
      isSet,
    })
  }

  return result
}

// ---------------------------------------------------------------------------
//  Seed from .env (run once on startup)
// ---------------------------------------------------------------------------

export async function seedFromEnv(): Promise<void> {
  let seeded = 0

  for (const def of CREDENTIAL_DEFS) {
    if (!def.envKey) continue

    const envValue = process.env[def.envKey]
    if (!envValue) continue

    // Only seed if not already in DB
    const existing = await prisma.credential.findUnique({
      where: { category_provider_key: { category: def.category, provider: def.provider, key: def.key } },
    })
    if (existing) continue

    await setCredential(def.category, def.provider, def.key, envValue, def.masked)
    seeded++
  }

  if (seeded > 0) console.log(`[credentials] Seeded ${seeded} credentials from .env`)
}
