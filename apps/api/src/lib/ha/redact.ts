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
  const e = process.env
  const out = ['PROXMOX_TOKEN_SECRET', 'PROXMOX_PASSWORD', 'PROXMOX_TOKEN_ID'].map(k => e[k] ?? '')
  // The token as Proxmox spells it: user@realm!tokenid.
  if (e.PROXMOX_USER && e.PROXMOX_TOKEN_ID) out.push(`${e.PROXMOX_USER}!${e.PROXMOX_TOKEN_ID}`)
  return out.filter(Boolean)
}

/** `extra`: secrets that are not in the environment, such as the node login a command used. */
export function redactText(text: string, secrets: string[] = liveSecrets(), extra: string[] = []): string {
  let t = String(text ?? '')
  // Longest first, so "user!tokenid" goes before "tokenid".
  for (const s of [...secrets, ...extra].sort((a, b) => b.length - a.length)) if (s && s.length >= 6) t = t.split(s).join('[redacted]')
  return t
}

/** Every string inside `details`, redacted (walked, so a multi-line key matches as it is, not JSON-escaped). */
export function redactSecrets<T>(details: T, secrets: string[] = liveSecrets(), extra: string[] = []): T {
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? redactText(v, secrets, extra)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, walk(x)]))
    : v
  return walk(details ?? null) as T
}
