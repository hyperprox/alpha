// =============================================================================
//  HyperProx — self-update: which channel an install follows, and what it calls itself
//
//  A tagged install (git describe is exactly a release tag, "v0.2.0-alpha") is a release, and follows the
//  stable channel. An untagged one (commits past a tag, "v0.1.0-alpha-40-g1a2b3c4", or no tag at all) was
//  installed from main, and stable would offer it nothing until a newer release exists, so it follows the
//  alpha channel (main) unless someone chose a channel. A chosen channel is always kept.
//
//  Versions compare by semver precedence (lib/app-updates/versions.ts): 0.2.0-alpha is newer than
//  0.1.0-alpha, and 0.2.0 is newer than 0.2.0-alpha. Neither channel offers an older version: stable compares
//  versions and then requires the release to contain the installed commit; alpha requires main to be ahead.
// =============================================================================

import { compareVersions, isVersion } from '../app-updates/versions'
import type { Channel } from './state'

const EXACT_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PAST_TAG = /^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-(\d+)-g([0-9a-f]{4,40})$/

/** `git describe --tags --always` names a release tag exactly (not commits past one, not a bare commit). */
export function isTaggedDescribe(describe: string): boolean {
  return EXACT_TAG.test(describe.trim()) && !PAST_TAG.test(describe.trim())
}

export interface InstallShape { version: string; sha: string; describe: string; branch: string | null; git: boolean }

/**
 * What an install calls itself. Tagged: the tag. Untagged: the package version with where it came from, as
 * semver build metadata ("0.2.0-alpha+main.1a2b3c4"), which never changes how it compares.
 */
export function installedLabel(i: InstallShape): { tagged: boolean; label: string; display: string } {
  const short = i.sha.slice(0, 7)
  if (i.git && isTaggedDescribe(i.describe)) return { tagged: true, label: i.describe, display: i.describe }
  if (!i.git && i.describe && isTaggedDescribe(i.describe)) return { tagged: true, label: i.describe, display: i.describe }
  const where = i.branch ?? (i.git ? 'detached' : 'archive')
  const label = short ? `${i.version}+${where.replace(/[^0-9A-Za-z-]/g, '-')}.${short}` : i.version
  const display = short ? `${i.version} (${where} @ ${short}, untagged)` : `${i.version} (untagged)`
  return { tagged: false, label, display }
}

export type ChannelSource = 'chosen' | 'default'

/**
 * The channel in effect. A chosen one is kept. Otherwise: alpha (main) for an untagged git install, which is
 * where it came from, and stable for a release. Automatic install stays on stable (it only installs releases).
 */
export function effectiveChannel(o: { chosen: Channel | null; installed: InstallShape | null; autoInstall: boolean }): { channel: Channel; source: ChannelSource; why: string } {
  if (o.chosen) return { channel: o.chosen, source: 'chosen', why: `You chose the ${o.chosen} channel.` }
  if (o.autoInstall) return { channel: 'stable', source: 'default', why: 'Automatic install only installs stable releases.' }
  const i = o.installed
  if (i && i.git && !isTaggedDescribe(i.describe)) {
    return { channel: 'alpha', source: 'default', why: `This install is not a release (${installedLabel(i).display}), so it follows main, where it came from. Choose stable to wait for the next release instead.` }
  }
  return { channel: 'stable', source: 'default', why: 'This install is a release, so it follows released versions.' }
}

/** How a release compares with the installed version: never an offer when it is older. */
export function releaseVsInstalled(release: string, installed: string): 'newer' | 'same' | 'older' | 'unknown' {
  if (!isVersion(release) || !isVersion(installed)) return 'unknown'
  const c = compareVersions(release, installed)
  return c > 0 ? 'newer' : c < 0 ? 'older' : 'same'
}
