/**
 * Where to go after signing in — a path on this origin, or `/`.
 *
 * `next` arrives in the query string, so it is whatever the caller put there. With a hard
 * navigation an absolute URL would be an open redirect: `/login?next=https://elsewhere.example`
 * would take a freshly-authenticated operator off-site on a page they trust. Anything that is not
 * a single-slash-rooted path is discarded rather than sanitised — `//host` is protocol-relative
 * and reads as a path only until a browser resolves it.
 */
export function safeNext(raw: string | null, origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // A browser resolves "/\\host" and tab- or newline-split variants to another host: only what stays on this
  // origin, resolved the way the browser will, is followed.
  let u: URL
  try { u = new URL(raw, origin) } catch { return '/' }
  if (u.origin !== origin || u.pathname.startsWith('/login')) return '/'
  return u.pathname + u.search + u.hash
}
