// =============================================================================
//  HyperProx — the running version
//
//  One source of truth: the `version` in the repo's root package.json, plus the
//  short commit it was built from. The API used to hard-code its own string, so
//  it said 0.1.0 long after the code had moved on.
//
//  The root file is four directories up from both src/lib (tsx) and dist/lib
//  (compiled), so one path serves both. A tree without the root file (an image
//  that copied only apps/api) falls back to the API's own package.json, which
//  is bumped in step.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

function readVersion(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version
    return typeof v === 'string' && v ? v : null
  } catch { return null }
}

/** Short commit hash: GIT_SHA wins (set by a build that has no .git), then git itself, else ''. */
export function readGitSha(cwd: string = __dirname, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.GIT_SHA ?? '').trim()
  if (/^[0-9a-f]{4,40}$/i.test(fromEnv)) return fromEnv.slice(0, 7)
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim()
    return /^[0-9a-f]{4,40}$/i.test(out) ? out : ''
  } catch { return '' }
}

export function resolveVersion(base: string = __dirname): { version: string; sha: string } {
  const root = readVersion(path.resolve(base, '../../../../package.json'))
  const own  = readVersion(path.resolve(base, '../../package.json'))
  return { version: root ?? own ?? 'unknown', sha: readGitSha(base) }
}

export const APP_VERSION = resolveVersion()
