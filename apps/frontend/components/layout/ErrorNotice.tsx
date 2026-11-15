'use client'

// The one way a page shows that something failed: the plain sentence the API sent (or one made from what went
// wrong, lib/api.ts errorText / failureText), and, when the API gave one, its reference number in small type, so a
// person can quote it and the log lines for that request can be found. Built on the vault notice, so it looks like
// every other notice in HyperProx.

import { Notice } from '@/components/vault/ui'

export function ErrorNotice({ message, reference, tone = 'error', children }: {
  message: string
  /** The API's requestId for the failed request. */
  reference?: string | null
  tone?: 'error' | 'warn'
  /** Anything to offer after the sentence: a retry button, a link to Settings. */
  children?: React.ReactNode
}) {
  return (
    <Notice kind={tone}>
      <span>{message}</span>
      {reference ? (
        <span style={{ display: 'block', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
          Reference: {reference}
        </span>
      ) : null}
      {children ? <span style={{ display: 'block', marginTop: 6 }}>{children}</span> : null}
    </Notice>
  )
}
