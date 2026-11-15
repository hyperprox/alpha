'use client'

// What a page shows when it fails to render: one plain sentence, a reload button, and Next's reference for the
// failure when there is one. Never the error's own message or stack (those are in the browser console). Used by
// app/error.tsx (inside the app's frame) and app/global-error.tsx (when the frame itself failed).

export const PAGE_ERROR_TEXT = 'Something went wrong on this page. Reload to try again.'

export function PageError({ digest, onRetry }: { digest?: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{
      maxWidth: 520, margin: '15vh auto', padding: '22px 24px', borderRadius: 12,
      border: '1px solid color-mix(in srgb, var(--crit, #e5484d) 35%, transparent)', borderLeftWidth: 3,
      background: 'color-mix(in srgb, var(--crit, #e5484d) 8%, var(--surface, #101b2a))', color: 'var(--text, #d7e1ec)',
      fontFamily: 'var(--font-body, system-ui, sans-serif)',
    }}>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{PAGE_ERROR_TEXT}</p>
      {digest ? (
        <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--text-muted, #8a9bb0)' }}>Reference: {digest}</p>
      ) : null}
      <button type="button" onClick={() => (onRetry ? onRetry() : window.location.reload())} style={{
        marginTop: 14, height: 36, padding: '0 16px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid var(--accent, #2fd6e8)', background: 'transparent', color: 'var(--accent, #2fd6e8)',
        fontFamily: 'var(--font-mono, monospace)', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>Reload</button>
    </div>
  )
}
