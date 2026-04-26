// =============================================================================
//  HyperProx — AES-256-GCM Encryption Service
// =============================================================================

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // 96 bits for GCM
const TAG_LENGTH = 16  // 128-bit auth tag

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY not set in environment')
  // Accept either a 32-byte hex string or raw key
  if (raw.length === 64) return Buffer.from(raw, 'hex')
  // Derive 32-byte key from whatever is provided
  return scryptSync(raw, 'hyperprox-salt', 32)
}

/**
 * Encrypt a plaintext string.
 * Returns: base64(iv + tag + ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv  = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  // Pack: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key  = getKey()
  const data = Buffer.from(ciphertext, 'base64')

  const iv         = data.subarray(0, IV_LENGTH)
  const tag        = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const encrypted  = data.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8')
}

/** Mask a value for display — show last 4 chars only */
export function mask(value: string): string {
  if (value.length <= 4) return '••••'
  return '•'.repeat(Math.min(value.length - 4, 20)) + value.slice(-4)
}
