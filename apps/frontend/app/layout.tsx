import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AppShell } from '@/components/layout/AppShell'
import { ServiceWorker } from '@/components/layout/ServiceWorker'

/** Baked in by the demo build (scripts/demo.sh) and nowhere else. */
const DEMO = process.env.NEXT_PUBLIC_HYPERPROX_DEMO === '1'

export const metadata: Metadata = {
  title: 'HyperProx',
  description: 'Your Proxmox infrastructure, hypercharged.',
  manifest: '/manifest.webmanifest',
  applicationName: 'HyperProx',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'HyperProx',
    // The bar is drawn dark by the app itself; a translucent status bar lets
    // that run to the top edge instead of leaving a white strip above it.
    statusBarStyle: 'black-translucent',
  },
}

/**
 * Without this a phone lays the page out at 980px and scales it down, so every
 * media query below matches the desktop branch and the whole thing arrives as a
 * shrunken screenshot. It is the one line that makes the rest work.
 *
 * `viewport-fit=cover` plus the safe-area padding in globals.css keeps the nav
 * clear of the home indicator on a notched phone.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: 'var(--ground)',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before anything paints. Without this the page renders in the
            default theme and then corrects itself, which is a white flash for
            anyone who chose dark — the one group most likely to notice. It has
            to be inline and synchronous for the same reason. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('hyperprox-theme');" +
              "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})()",
          }}
        />
        {/* The demo build serves its own copies of the fonts (scripts/demo-fonts.sh): a public demo asks no
            other site for anything, and its Content-Security-Policy would refuse the font service anyway. */}
        {DEMO
          ? <link href="/demo-fonts/fonts.css" rel="stylesheet" />
          : <>
              <link rel="preconnect" href="https://fonts.googleapis.com" />
              <link
                href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
                rel="stylesheet"
              />
            </>}
      </head>
      <body style={{ background: 'var(--ground)', color: 'var(--text)' }} className="font-sans antialiased flex h-screen overflow-hidden">
        {/* No install prompt or offline cache for the demo: it is a page to try, reset every night. */}
        {!DEMO && <ServiceWorker />}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
