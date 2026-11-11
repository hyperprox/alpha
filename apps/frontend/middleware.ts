import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Presence check only — the API verifies the signature. This exists so an
// unauthenticated browser lands on /login instead of a page full of failed
// fetches.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname === '/login') return NextResponse.next()
  if (req.cookies.get('hyperprox_token')) return NextResponse.next()

  // Next's middleware needs an absolute Location ("Invalid URL" otherwise), and req.nextUrl names the Next
  // server's own loopback address. The browser's host comes from X-Forwarded-Host, which nginx always sets to
  // the Host the browser itself sent ($http_host); the Next server listens on loopback only. A malformed value
  // falls back to the request's own host. Whatever a client puts there only redirects that same client.
  const fwd = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
  const host = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(fwd) ? fwd : req.nextUrl.host
  const proto = req.headers.get('x-forwarded-proto') === 'http' ? 'http' : 'https'
  const target = new URL(`${proto}://${host}/login`)
  target.searchParams.set('next', pathname)
  return NextResponse.redirect(target, 307)
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
