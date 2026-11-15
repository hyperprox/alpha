'use client'

// A page that threw while rendering: a plain sentence inside the app's frame, not Next's error screen.
import { PageError } from '@/components/layout/PageError'

export default function Error({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError digest={error?.digest} />
}
