// =============================================================================
//  Where the WebSocket lives
//
//  Two access paths exist and they need different answers:
//    :3000   — the Next.js server directly. Its only rewrite is /api (see
//              next.config.js), so /ws is not proxied and the socket must go
//              straight to the API's own port. Cookies are not port-scoped, so
//              the session cookie set on this host is still sent.
//    :80/443 — a reverse proxy in front, which forwards /ws on the same origin.
//
//  Deriving the scheme from the page is what keeps this working behind TLS: a
//  hardcoded ws:// on an https page is blocked as mixed content, and the failure
//  is silent — the dashboard just stops updating while still showing a
//  live-looking "last sync" time.
// =============================================================================

export function wsBase(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

  return window.location.port === '3000'
    ? `${proto}//${window.location.hostname}:3002/ws`
    : `${proto}//${window.location.host}/ws`
}
