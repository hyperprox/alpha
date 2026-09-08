'use client'

// =============================================================================
//  Registers the service worker, and nothing else.
//
//  Kept apart from the layout so the layout stays a server component. The
//  worker itself is where the caching policy lives; this only turns it on, and
//  only where the browser supports it.
// =============================================================================

import { useEffect } from 'react'

export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    // After the page has settled: registering during load competes with the
    // requests that actually put something on screen.
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // A failed registration costs the install prompt and offline page and
        // nothing else, so it is not worth interrupting anyone over.
      })
    }

    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
