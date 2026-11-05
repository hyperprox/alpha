// =============================================================================
//  HyperProx — Remote access: keeping keys out of logs
//
//  Output arrives in SSH data chunks of any size, so a key can straddle two
//  of them. StreamRedactor holds back a tail long enough to contain any key
//  and only releases text it has checked. It removes the keys of the current
//  install, anything shaped like a Tailscale key or a NetBird token, and,
//  while a NetBird setup key is live, anything shaped like one.
// =============================================================================

const KEY_SHAPES = [
  /tskey-[A-Za-z0-9_-]+/g,          // Tailscale auth, API and client keys
  /nbp_[A-Za-z0-9]{20,}/g,          // NetBird personal access tokens
  /\b(?:privkey|nlpriv|mkey|nodekey|discokey):[0-9a-f]+/g,   // Tailscale key material
  /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/g,    // Tailscale sign-in links
  /(?<="AuthURL"\s*:\s*")[^"]+/g,  // any sign-in link in a status dump
  ...LINK_SHAPES_ONLY(),
]

/**
 * Sign-in links of other shapes: NetBird's own login host, OAuth device flows, and any SSO link that carries
 * a code, state or ticket, or points at an authorize, device, activate or login path. Package and API URLs
 * (pkgs.*, api.*) carry none of these and are left alone.
 */
function LINK_SHAPES_ONLY(): RegExp[] {
  return [
    /https?:\/\/login\.netbird\.io\/[^\s"'<>]*/g,
    /https?:\/\/[^\s"'<>]*[?&](?:user_code|device_code|code|code_challenge|state|ticket|session_state|nonce)=[^\s"'<>]*/g,
    /https?:\/\/[^\s"'<>/]+\/(?:[^\s"'<>]*\/)?(?:activate|device|authorize|oauth2?|sso|saml2?|login|signin|auth)(?:[/?#][^\s"'<>]*)?(?=$|[\s"'<>])/gm,
  ]
}

/** True when this text holds anything shaped like a sign-in link. */
export function holdsSignInLink(s: string): boolean {
  return [/https:\/\/login\.tailscale\.com\/a\//, /"AuthURL"\s*:\s*"https/, ...LINK_SHAPES_ONLY()].some(re => new RegExp(re.source, re.flags.replace('g', '')).test(s))
}

/** NetBird setup keys are upper-case UUIDs. Applied only while one is live: ordinary ids look the same. */
export const NETBIRD_SETUP_KEY = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g

export const REDACTED = '[redacted]'

/** Longest key shape the stream redactor will ever need to see whole. */
const MAX_SHAPE_LEN = 256

export interface RedactOptions { netbird?: boolean }

function shapes(o: RedactOptions): RegExp[] {
  return o.netbird ? [...KEY_SHAPES, NETBIRD_SETUP_KEY] : KEY_SHAPES
}

export function redactKnownKeyShapes(s: string, o: RedactOptions = {}): string {
  let out = s
  for (const re of shapes(o)) out = out.replace(new RegExp(re.source, 'g'), REDACTED)
  return out
}

/** A redactor for these secrets plus every known key shape. Short or empty strings are ignored. */
export function makeRedactor(secrets: string[], o: RedactOptions = {}): (s: string) => string {
  const exact = secrets.filter(s => s && s.length >= 6)
  return (s: string) => {
    let out = s
    for (const k of exact) out = out.split(k).join(REDACTED)
    return redactKnownKeyShapes(out, o)
  }
}

/** Redacts a stream: push() chunks in, get checked text out; flush() at the end. */
export class StreamRedactor {
  private carry = ''
  private readonly exact: string[]
  private readonly hold: number
  private readonly redact: (s: string) => string
  private readonly res: RegExp[]

  constructor(secrets: string[], private readonly o: RedactOptions = {}) {
    this.exact = secrets.filter(s => s && s.length >= 6)
    this.hold = Math.max(MAX_SHAPE_LEN, ...this.exact.map(s => s.length))
    this.redact = makeRedactor(this.exact, o)
    this.res = shapes(o).map(r => new RegExp(r.source, 'g'))
  }

  push(chunk: string): string {
    const text = this.carry + chunk
    let cut = Math.max(0, text.length - this.hold)
    // Never cut inside something that is, or may become, a key: move the cut to its start.
    const starts: Array<[number, number]> = []
    for (const k of this.exact) for (let i = text.indexOf(k); i !== -1; i = text.indexOf(k, i + 1)) starts.push([i, i + k.length])
    for (const re of this.res) { re.lastIndex = 0; for (let m = re.exec(text); m; m = re.exec(text)) starts.push([m.index, m.index + m[0].length]) }
    for (const [a, b] of starts) if (a < cut && (b > cut || b === text.length)) cut = a
    // A prefix of a key at the very end is not a match yet; it is inside the held tail as long as hold > key length.
    this.carry = text.slice(cut)
    return this.redact(text.slice(0, cut))
  }

  flush(): string {
    const out = this.redact(this.carry)
    this.carry = ''
    return out
  }
}
