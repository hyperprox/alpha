// =============================================================================
//  HyperProx — HA: keep vault values out of words that leave the process
//
//  HA never puts a credential into an audit record, a message or a log by
//  construction: it records who, what, and Proxmox's own refusal text. But a
//  refusal is text from elsewhere, so every such string is passed through
//  here, and any vault value the process holds right now is cut out.
// =============================================================================

/** The vault values the process holds while unlocked (filled from the vault by the credentials registry). */
export function liveSecrets(): string[] {
  return ['PROXMOX_TOKEN_SECRET', 'PROXMOX_PASSWORD'].map(k => process.env[k] ?? '').filter(Boolean)
}

export function redactText(text: string, secrets: string[] = liveSecrets()): string {
  let t = String(text ?? '')
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('[redacted]')
  return t
}

export function redactSecrets<T>(details: T, secrets: string[] = liveSecrets()): T {
  return JSON.parse(redactText(JSON.stringify(details ?? null), secrets))
}
