// =============================================================================
//  HyperProx — self-update: is there a newer HyperProx?
//
//    stable  the newest release (GitHub Releases; the tags when there are none)
//            whose version is newer than the installed one, or the same version
//            with newer commits (a release cut after this build of it)
//    alpha   the newest commit on main
//
//  What comes back is everything the page shows before anyone presses
//  anything: version, date, the release notes or the commits since the
//  installed one in plain words, and flags for breaking changes, database
//  migrations and a keyholder change (which locks HyperProx once).
// =============================================================================

import { compareVersions, isVersion } from '../app-updates/versions'
import type { Channel } from './state'
import type { Comparison, Upstream } from './upstream'

export interface Installed {
  version: string
  sha:     string
  describe: string
  branch:  string | null
  /** false: not a git checkout (an unpacked archive), which cannot update itself. */
  git:     boolean
  /** describe is exactly a release tag (lib/self-update/channel.ts). */
  tagged?: boolean
  /** What it calls itself: the tag, or "0.2.0-alpha+main.1a2b3c4" (semver build metadata) when untagged. */
  label?:  string
  /** The same in words: "0.2.0-alpha (main @ 1a2b3c4, untagged)". */
  display?: string
}

export interface UpdateCommit { sha: string; text: string; date: string | null }

export interface AvailableUpdate {
  channel: Channel
  sha:     string
  ref:     string
  label:   string
  version: string | null
  date:    string | null
  /** Release notes (stable), when the release has any. */
  notes:   string | null
  url:     string | null
  commits: UpdateCommit[]
  /** Commits between the installed one and the target; more than `commits` when the list was cut. */
  totalCommits: number
  flags: {
    breaking:   string[]
    migrations: string[]
    keyholder:  boolean
    /** The installed commit is not on upstream (local commits, or upstream rewrote its history). */
    unknownBase: boolean
    /** Files changed was not available: the migration and keyholder flags are not known. */
    filesUnknown: boolean
  }
  signature: { annotated: boolean; signed: boolean | null; verifiedByHost: boolean | null } | null
}

export interface CheckResult {
  checkedAt: string
  source:    string | null
  /** Found on the mirror, not the configured upstream. */
  fromMirror?: boolean
  available: AvailableUpdate | null
  /** Why there is nothing to offer, in a sentence ("You are on the newest release, v0.3.0."). */
  note:      string
  error:     string | null
}

const SEMVER_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
export const tagVersion = (tag: string): string | null => { const m = SEMVER_TAG.exec(tag); return m && isVersion(m[1]) ? m[1] : null }

/** Commit subjects as a person would say them: conventional prefixes and merge noise removed. */
export function plainCommit(subject: string): string | null {
  let s = subject.trim()
  if (/^Merge (branch|pull request|remote-tracking branch|tag) /i.test(s) && !/: /.test(s)) return null
  const merge = /^Merge [^:]{1,80}: (.+)$/.exec(s)
  if (merge) s = merge[1]
  s = s.replace(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s*/i, '')
  if (!s) return null
  return s[0].toUpperCase() + s.slice(1)
}

const BREAKING = /\bBREAKING(?: CHANGES?)?\b|\bbreaking change/i
const MIGRATION_NOTE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:MIGRATION|UPGRADE NOTE|Migration note)s?\b/i

export function flagsFrom(notes: string | null, cmp: Comparison | null): AvailableUpdate['flags'] {
  const breaking: string[] = []
  for (const l of (notes ?? '').split('\n')) if (BREAKING.test(l) || MIGRATION_NOTE.test(l)) breaking.push(l.replace(/^[\s#*-]+/, '').trim())
  for (const c of cmp?.commits ?? []) {
    if (/^\w+(\([^)]*\))?!:/.test(c.subject) || /BREAKING CHANGE/.test(c.body)) breaking.push(plainCommit(c.subject) ?? c.subject)
  }
  const files = cmp?.files ?? null
  const migrations = (files ?? []).filter(f => /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f)).map(f => f.split('/')[4])
  return {
    breaking: [...new Set(breaking)].slice(0, 20), migrations, keyholder: (files ?? []).includes('bin/hyperprox-keyholder'),
    unknownBase: cmp?.status === 'unknown' || cmp?.status === 'diverged', filesUnknown: files === null,
  }
}

function commitsFrom(cmp: Comparison | null): { list: UpdateCommit[]; total: number } {
  const list: UpdateCommit[] = []
  for (const c of cmp?.commits ?? []) {
    const text = plainCommit(c.subject)
    if (text) list.push({ sha: c.sha, text, date: c.date })
  }
  // Newest first, as the page reads.
  const newest = list.reverse()
  return { list: newest.slice(0, 50), total: cmp?.total ?? newest.length }
}

/** Ask one upstream. Throws when it cannot answer (the caller tries the next). */
export interface FindOptions { branch?: string; /** Stable: also offer GitHub pre-releases (default true while every version is -alpha). */ includePrereleases?: boolean }

export async function findUpdate(installed: Installed, channel: Channel, up: Upstream, opts: FindOptions = {}): Promise<{ available: AvailableUpdate | null; note: string }> {
  const branch = opts.branch ?? 'main'
  const pre = opts.includePrereleases ?? true
  if (channel === 'alpha') {
    const head = await up.head(branch)
    if (head.sha === installed.sha) return { available: null, note: `You are on the newest commit on ${branch} (${head.sha.slice(0, 7)}).` }
    const cmp = await up.compare(installed.sha, head.sha)
    if (cmp.status === 'identical') return { available: null, note: `You are on the newest commit on ${branch}.` }
    if (cmp.status === 'behind') return { available: null, note: `This install is ahead of ${branch} upstream (${installed.sha.slice(0, 7)} has commits ${branch} does not).` }
    const { list, total } = commitsFrom(cmp)
    return {
      available: {
        channel, sha: head.sha, ref: branch, label: `${branch} @ ${head.sha.slice(0, 7)}`, version: null, date: head.date,
        notes: null, url: null, commits: list.length ? list : [{ sha: head.sha, text: plainCommit(head.subject) ?? head.subject, date: head.date }],
        totalCommits: total || 1, flags: flagsFrom(null, cmp), signature: null,
      },
      note: `${total || 1} new commit${total === 1 ? '' : 's'} on ${branch}.`,
    }
  }

  // stable
  const releases = await up.releases()
  // A pre-release is one GitHub marks as such, or (for bare tags) a version with a pre-release part.
  let candidates = releases.map(r => ({ tag: r.tag, version: tagVersion(r.tag), release: r as typeof r | null, prerelease: r.prerelease || /-/.test(tagVersion(r.tag) ?? '') }))
    .filter(c => c.version)
  if (!candidates.length) candidates = (await up.tags()).map(t => ({ tag: t, version: tagVersion(t), release: null, prerelease: /-/.test(tagVersion(t) ?? '') })).filter(c => c.version)
  const all = candidates.length
  if (!pre) candidates = candidates.filter(c => !c.prerelease)
  if (!candidates.length) {
    return { available: null, note: all ? 'Only pre-releases have been published. Turn on "include pre-releases" to be offered them.' : 'No releases have been published yet. The alpha channel follows main.' }
  }
  candidates.sort((a, b) => compareVersions(b.version!, a.version!))
  const best = candidates[0]
  const installedVersion = isVersion(installed.version) ? installed.version : null
  const cmpV = installedVersion ? compareVersions(best.version!, installedVersion) : 1
  // Never a downgrade: a release older than the install is not offered, and the note says where newer code is.
  if (cmpV < 0) return { available: null, note: `This install (${installed.version}) is newer than the newest release, ${best.tag}, so stable has nothing newer to offer. The alpha channel follows main.` }
  const tag = await up.tag(best.tag)
  if (tag.commit === installed.sha) return { available: null, note: `You are on the newest release, ${best.tag}.` }
  const cmp = await up.compare(installed.sha, tag.commit)
  // A release is offered only when it contains the installed commit: never an older one, whatever its tag says.
  if (cmp.status !== 'ahead') {
    const why = cmp.status === 'behind' ? `this install already contains ${best.tag} and more`
      : cmp.status === 'identical' ? `you are on ${best.tag}`
      : `${best.tag} does not contain this install's commit ${installed.sha.slice(0, 7)} (other history, or upstream does not know it); reinstall, or use the alpha channel`
    return { available: null, note: `Nothing to offer on stable: ${why}.` }
  }
  const { list, total } = commitsFrom(cmp)
  const notes = best.release?.notes?.trim() || null
  return {
    available: {
      channel, sha: tag.commit, ref: best.tag, label: best.tag, version: best.version, date: best.release?.date ?? null,
      notes, url: best.release?.url ?? null, commits: list, totalCommits: total, flags: flagsFrom(notes, cmp),
      signature: { annotated: tag.annotated, signed: tag.signed, verifiedByHost: tag.verified },
    },
    note: cmpV === 0 ? `${best.tag} was released with commits newer than this build of ${installed.version}.` : `${best.tag} is available.`,
  }
}
