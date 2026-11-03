// =============================================================================
//  HyperProx — Remote access: keeping keys out of logs
//
//  Every line of output from an install passes through a redactor made for
//  that install before it is stored or shown. It removes the key that install
//  minted, wherever it appears, and anything shaped like a Tailscale key or a
//  NetBird token whether or not HyperProx knows it.
// =============================================================================

const KEY_SHAPES = [
  /tskey-[A-Za-z0-9_-]+/g,          // Tailscale auth, API and client keys
  /nbp_[A-Za-z0-9]{20,}/g,          // NetBird personal access tokens
]

export const REDACTED = '[redacted]'

export function redactKnownKeyShapes(s: string): string {
  let out = s
  for (const re of KEY_SHAPES) out = out.replace(re, REDACTED)
  return out
}

/** A redactor for these secrets plus every known key shape. Empty strings are ignored. */
export function makeRedactor(secrets: string[]): (s: string) => string {
  const exact = secrets.filter(s => s && s.length >= 6)
  return (s: string) => {
    let out = s
    for (const k of exact) out = out.split(k).join(REDACTED)
    return redactKnownKeyShapes(out)
  }
}
