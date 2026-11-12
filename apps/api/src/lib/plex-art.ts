// =============================================================================
//  HyperProx — Plex cover art, through HyperProx
//
//  A poster in the browser must never carry the Plex token, so the page never
//  gets a Plex URL at all. It gets a HyperProx path made of three plain numbers
//  and a word (/api/plugins/plex/art/<id>/<thumb|art>/<version>), and the API
//  fetches that one image from Plex server-side, with the token from the vault.
//
//  There is no URL parameter anywhere in this: the upstream path is rebuilt from
//  the three validated parts into Plex's own /library/metadata/<id>/<kind>/<n>,
//  run through Plex's photo transcoder at a fixed size. Nothing a browser sends
//  can point it at another host or another path.
// =============================================================================

export type ArtKind = 'thumb' | 'art'

export interface ArtKey { id: string; kind: ArtKind; version: string }

const ID = /^\d{1,10}$/
const VERSION = /^\d{1,12}$/
const PLEX_PATH = /^\/library\/metadata\/(\d{1,10})\/(thumb|art)\/(\d{1,12})$/

/** The three route parts, checked; null for anything else. */
export function artKey(id: unknown, kind: unknown, version: unknown): ArtKey | null {
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof version !== 'string') return null
  if (!ID.test(id) || !VERSION.test(version) || (kind !== 'thumb' && kind !== 'art')) return null
  return { id, kind, version }
}

/** A Plex thumb path ("/library/metadata/123/thumb/456") as the HyperProx path a page may use, or null. */
export function artRef(plexPath: unknown): string | null {
  const m = typeof plexPath === 'string' ? PLEX_PATH.exec(plexPath.trim()) : null
  return m ? `/api/plugins/plex/art/${m[1]}/${m[2]}/${m[3]}` : null
}

/** The upstream paths for one key, in the order tried: the transcoder at a fixed size, then the image itself. */
export function artUpstream(k: ArtKey): string[] {
  const own = `/library/metadata/${k.id}/${k.kind}/${k.version}`
  const [w, h] = k.kind === 'thumb' ? [300, 450] : [640, 360]
  return [`/photo/:/transcode?width=${w}&height=${h}&minSize=1&upscale=1&url=${encodeURIComponent(own)}`, own]
}

interface Cached { at: number; contentType: string; body: Buffer }

/**
 * A small in-memory cache: posters are re-requested on every page load and poll. Bounded by total bytes as well
 * as entries, so its worst case stays near `maxBytes` (150 MB by default) whatever the images weigh.
 */
export class ArtCache {
  private m = new Map<string, Cached>()
  private bytes = 0
  constructor(private max = 500, private ttlMs = 15 * 60_000, private now: () => number = Date.now, private maxBytes = 150 * 1024 * 1024) {}
  get(key: string): Cached | null {
    const c = this.m.get(key)
    if (!c) return null
    if (this.now() - c.at > this.ttlMs) { this.drop(key); return null }
    // Most recently used goes to the end.
    this.m.delete(key); this.m.set(key, c)
    return c
  }
  set(key: string, contentType: string, body: Buffer): void {
    if (body.length > this.maxBytes) return
    this.drop(key)
    this.m.set(key, { at: this.now(), contentType, body })
    this.bytes += body.length
    while (this.m.size > this.max || this.bytes > this.maxBytes) this.drop(this.m.keys().next().value as string)
  }
  get size(): { entries: number; bytes: number } { return { entries: this.m.size, bytes: this.bytes } }
  private drop(key: string) {
    const c = this.m.get(key)
    if (c) { this.bytes -= c.body.length; this.m.delete(key) }
  }
}

/** Cache misses per person: each one is a fetch from Plex. */
export class MissLimiter {
  private m = new Map<string, { start: number; n: number }>()
  constructor(private perMinute = 120, private now: () => number = Date.now) {}
  allow(who: string): boolean {
    const t = this.now()
    const e = this.m.get(who)
    if (!e || t - e.start >= 60_000) { this.m.set(who, { start: t, n: 1 }); if (this.m.size > 5000) this.m.clear(); return true }
    e.n++
    return e.n <= this.perMinute
  }
}
