'use client'

import { alpha } from '@/lib/theme'

interface ComingSoonProps {
  title:       string
  description: string
  features:    string[]
  accent:      string
  icon:        'proxy' | 'dns' | 'storage' | 'ai' | 'settings'
}

export function ComingSoon({ title, description, features, accent }: ComingSoonProps) {
  return (
    <div className="min-h-full p-8 flex flex-col" style={{ background: 'var(--ground)' }}>
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-1 h-6 rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{ color: accent }}>
            {title}
          </h1>
          <span className="text-xs font-mono px-2 py-0.5 rounded" style={{
            background: `${alpha(accent, 8)}`, color: accent, border: `1px solid ${alpha(accent, 19)}`,
          }}>coming soon</span>
        </div>
        <p className="text-sm font-mono text-gray-500 ml-4">{description}</p>
      </div>

      {/* Feature preview */}
      <div className="max-w-2xl">
        <div
          className="rounded-lg border p-6"
          style={{ background: 'linear-gradient(135deg, var(--surface) 0%, var(--ground) 100%)', borderColor: `${alpha(accent, 13)}` }}
        >
          <div className="text-xs font-mono uppercase tracking-widest mb-4" style={{ color: `${alpha(accent, 50)}` }}>
            What's being built
          </div>
          <ul className="space-y-3">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <div className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accent, opacity: 0.6 }} />
                <span className="text-sm font-mono text-gray-400">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
