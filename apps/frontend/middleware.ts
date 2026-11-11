import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Presence check only — the API verifies the signature. This exists so an
// unauthenticated browser lands on /login instead of a page full of failed
// fetches.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname === '/login') return NextResponse.next()
  if (req.cookies.get('hyperprox_token')) return NextResponse.next()

  // Next's middleware turns a Location header into a URL without a base, so a relative redirect fails every
  // signed-out page with "Invalid URL". The address is built from the request as Next sees it: the Next server
  // listens on loopback only, and nginx sets the forwarded host itself (it never passes a client's value).
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = `?${new URLSearchParams({ next: pathname }).toString()}`
  return NextResponse.redirect(url, 307)
}

export const config = {
  // Everything except /api/* (the API returns its own 401), Next internals and
  // static assets.
  // sw.js, the manifest and the offline page must be reachable without a
  // session or the app is not installable at all: a browser fetches the
  // manifest before anyone has signed in, registers the worker from a
  // same-origin script it has to be able to read, and shows the offline page
  // precisely when it cannot reach the server to authenticate. None of the
  // three contains anything but the app's own name, colours and caching rules.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|offline\\.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
