import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Presence check only — the API verifies the signature. This exists so an
// unauthenticated browser lands on /login instead of a page full of failed
// fetches.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname === '/login') return NextResponse.next()
  if (req.cookies.get('hyperprox_token')) return NextResponse.next()

  // Behind nginx the Next server only knows its own loopback address, so req.nextUrl would point the
  // browser at localhost:3000. Build the address the browser actually used, from the proxy headers.
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host
  const proto = (req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')).split(',')[0].trim()
  const url = new URL('/login', `${proto}://${host}`)
  url.searchParams.set('next', pathname)
  return NextResponse.redirect(url)
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
