'use client'

interface ComingSoonProps {
  title:       string
  description: string
  features:    string[]
  accent:      string
  icon:        'proxy' | 'dns' | 'storage' | 'ai' | 'settings'
}

export function ComingSoon({ title, description, features, accent }: ComingSoonProps) {
  return (
    <div className="min-h-full p-6 sm:p-10 flex flex-col" style={{ background: 'var(--ground)' }}>
      {/* Page header */}
      <div className="mb-8" style={{ maxWidth: 680 }}>
        <div className="font-mono uppercase mb-2" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--accent)' }}>
          coming soon
        </div>
        <h1 className="font-display" style={{ fontSize: 36, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1.15 }}>
          {title}
        </h1>
        <p className="mt-2" style={{ fontSize: 15, color: 'var(--text-soft)' }}>{description}</p>
      </div>

      {/* Feature preview */}
      <div className="max-w-2xl">
        <div
          className="rounded-lg border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)', padding: 24, borderLeft: `3px solid ${accent}` }}
        >
          <div className="font-display mb-4" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-bright)' }}>
            What's being built
          </div>
          <ul className="space-y-3">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <div className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accent, opacity: 0.6 }} />
                <span style={{ fontSize: 15, color: 'var(--text-soft)' }}>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
