// The product version as the browser shows it: "v0.2.0-alpha · 1a2b3c4".
// Both parts are injected by next.config.js at build time; the commit is empty
// when the build had no git history to read.
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'unknown'
export const GIT_SHA     = process.env.NEXT_PUBLIC_GIT_SHA || ''

export function versionLabel(): string {
  const v = APP_VERSION === 'unknown' ? 'dev' : `v${APP_VERSION}`
  return GIT_SHA ? `${v} · ${GIT_SHA}` : v
}
