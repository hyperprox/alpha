// =============================================================================
//  HyperProx — theme helpers
//
//  Colours live in CSS custom properties so a theme swap is a variable change
//  rather than an edit to every file. The one thing a variable cannot do is
//  carry alpha by string concatenation: the old code wrote `${ACCENT}25`, and
//  `var(--accent)25` is not a colour. color-mix() composes it properly, and
//  works on whatever the variable resolves to in the active theme.
// =============================================================================

/** `alpha(ACCENT, 15)` → a 15% tint of whatever --accent currently is. */
export function alpha(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

export type ThemeChoice = 'dark' | 'light' | 'system'

export const THEME_KEY = 'hyperprox-theme'

/** Applies a choice to the document. 'system' removes the stamp entirely, which
 *  is what lets the prefers-color-scheme rules take over again. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try { localStorage.setItem(THEME_KEY, choice) } catch { /* private mode */ }
}

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch { /* private mode */ }
  return 'system'
}
