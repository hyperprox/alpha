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
//
//  `describe` is `git describe --tags --always` ("v0.2.0-alpha-12-g1a2b3c4"),
//  read once at start. An install without .git (an unpacked release archive)
//  reads VERSION instead, which `git archive` fills in (.gitattributes,
//  export-subst) with the same describe and the full commit.
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

/** VERSION as `git archive` writes it: "<describe> <full sha>". Unfilled (a checkout), it still says $Format. */
export function readVersionFile(file: string): { describe: string; sha: string } | null {
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (!t || t.includes('$Format')) return null
    // No tag to describe from: git archive leaves only the commit.
    const parts = t.split(/\s+/)
    if (parts.length === 1 && /^[0-9a-f]{40}$/.test(parts[0])) return { describe: parts[0].slice(0, 7), sha: parts[0] }
    const [describe, sha] = parts
    return { describe, sha: /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : '' }
  } catch { return null }
}

/** `git describe --tags --always`: GIT_DESCRIBE wins (a build without .git), then git, else ''. */
export function readDescribe(cwd: string = __dirname, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.GIT_DESCRIBE ?? '').trim()
  if (/^[0-9A-Za-z._+-]{1,80}$/.test(fromEnv)) return fromEnv
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim()
    return /^[0-9A-Za-z._+-]{1,80}$/.test(out) ? out : ''
  } catch { return '' }
}

export function resolveVersion(base: string = __dirname): { version: string; sha: string; describe: string } {
  const root = readVersion(path.resolve(base, '../../../../package.json'))
  const own  = readVersion(path.resolve(base, '../../package.json'))
  const version = root ?? own ?? 'unknown'
  let sha = readGitSha(base)
  let describe = readDescribe(base)
  if (!sha) {
    const file = readVersionFile(path.resolve(base, '../../../../VERSION'))
    if (file) { sha = file.sha.slice(0, 7); describe = describe || file.describe }
  }
  return { version, sha, describe: describe || (sha ? `v${version}-g${sha}` : `v${version}`) }
}

export const APP_VERSION = resolveVersion()
