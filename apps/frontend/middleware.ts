import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Presence check only — the API verifies the signature. This exists so an
// unauthenticated browser lands on /login instead of a page full of failed
// fetches.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname === '/login') return NextResponse.next()
  if (req.cookies.get('hyperprox_token')) return NextResponse.next()

  // A relative redirect: the browser resolves it against the address it used. Behind nginx the Next server
  // only knows its own loopback address, and a host taken from a request header (X-Forwarded-Host, Host) is
  // whatever a client reaching port 3000 directly chose to send, so no host is put in the answer at all.
  const target = `/login?${new URLSearchParams({ next: pathname }).toString()}`
  return new NextResponse(null, { status: 307, headers: { Location: target } })
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
