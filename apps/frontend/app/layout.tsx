import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Sidebar } from '@/components/layout/Sidebar'

export const metadata: Metadata = {
  title: 'HyperProx',
  description: 'Your Proxmox infrastructure, hypercharged.',
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
  themeColor: '#080c14',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-base text-white font-sans antialiased flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <main className="hp-mobile-offset flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
