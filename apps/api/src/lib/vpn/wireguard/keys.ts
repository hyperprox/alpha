// =============================================================================
//  HyperProx — WireGuard: keys
//
//  A WireGuard key is 32 bytes, base64. Server and machine keys are made on
//  their own machine and never leave it. A phone or laptop client's keypair is
//  made in the browser (WebCrypto X25519) and its private key goes straight to
//  a vault item; HyperProx only falls back to making one on the server
//  container when the browser cannot.
// =============================================================================

export const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

export function isWgKey(k: unknown): k is string {
  return typeof k === 'string' && WG_KEY.test(k) && Buffer.from(k, 'base64').length === 32
}
