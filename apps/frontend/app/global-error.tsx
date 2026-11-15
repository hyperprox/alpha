'use client'

// The app's frame itself failed: this replaces the root layout, so it brings its own <html> and the global styles.
import './globals.css'
import { PageError } from '@/components/layout/PageError'

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: 'var(--ground, #0a111c)' }}>
        <PageError digest={error?.digest} />
      </body>
    </html>
  )
}
