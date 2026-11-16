// A small disclosure under an assistant answer: which areas of HyperProx it was read from.
import { SOURCES_LABEL } from '@/lib/ai-sources'

export function SourcesUsed({ sources }: { sources: string[] }) {
  return (
    <details style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>{SOURCES_LABEL} ({sources.length})</summary>
      <div style={{ marginTop: 4 }}>{sources.join(', ')}</div>
    </details>
  )
}
