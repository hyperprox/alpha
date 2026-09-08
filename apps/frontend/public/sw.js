// =============================================================================
//  HyperProx — service worker
//
//  The rule that shapes all of this: NEVER serve a cached API response.
//
//  This is a console for live infrastructure. A cached /api/proxmox/summary is
//  a picture of the cluster as it was, rendered as though it were now — a node
//  shown up that is down, a backup shown green that failed at 02:00. Being
//  offline is a state a person can see and reason about; being shown yesterday
//  as today is not. Static assets are a different matter: a hashed JS bundle is
//  immutable by construction, so caching one can never be wrong.
// =============================================================================

const VERSION     = 'hyperprox-v1'
const ASSET_CACHE = `${VERSION}-assets`
const SHELL_CACHE = `${VERSION}-shell`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll([OFFLINE_URL, '/icon-192.png']))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  )
})

/** Immutable by construction: Next puts a content hash in the filename. */
function isHashedAsset(url) {
  return url.pathname.startsWith('/_next/static/')
      || /\.(png|svg|woff2?|ico)$/.test(url.pathname)
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Live data and sockets go to the network or they fail. No fallback, no
  // cache, no "last known good" — see the note at the top.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(ASSET_CACHE).then(c => c.put(request, copy))
        }
        return res
      })),
    )
    return
  }

  // Navigations: always try the network, so a deploy is picked up immediately.
  // Only when there is no network at all does the offline page appear, and it
  // says plainly that it is not showing cluster state.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then(r => r || Response.error())),
    )
  }
})
