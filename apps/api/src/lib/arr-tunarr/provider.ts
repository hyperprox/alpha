// =============================================================================
//  HyperProx — Updates: Tunarr, found in a guest's Docker
//
//  Registers Tunarr with the app-update providers (lib/plugin-host.ts AppUpdateProvider) so the Updates page shows
//  that it is behind. Tunarr runs as a Docker container, and Docker images already have an update path (the guest's
//  `docker` policy: pull the image and recreate the stack, then check every container runs). This provider does NOT
//  invent a second deployer: it reads the installed version and the newest GitHub release, and when there is
//  something newer it raises a blocking issue that says the image is updated by that Docker path. apply() and verify()
//  therefore never run an update themselves; they refuse in words.
//
//  Read-only inside the guest: `docker ps`, `docker port` and one request to Tunarr's own /api/version.
// =============================================================================

import { createHash } from 'node:crypto'
import type { AppContext, AppInstall, AppIssue, AppRelease, AppStepResult, AppUpdateProvider } from '../plugin-host'
import { compareVersions, isVersion } from '../app-updates/versions'
import { splitVersion } from './logic'

const RELEASES = 'https://api.github.com/repos/chrisbenincasa/tunarr/releases?per_page=15'
const IMAGE = /(^|\/)chrisbenincasa\/tunarr(:|@|$)/

/** The facts the detect script prints, one per line, base64 free: names are checked before they are used. */
export const DETECT_SCRIPT = String.raw`set -u
command -v docker >/dev/null 2>&1 || exit 0
docker ps --format '{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null | while IFS='|' read -r name image project; do
  case "$image" in *chrisbenincasa/tunarr*) ;; *) continue ;; esac
  port=$(docker port "$name" 8000/tcp 2>/dev/null | head -n1 | sed 's/.*://')
  [ -n "$port" ] || port=8000
  ver=$(curl -s -m 8 "http://127.0.0.1:$port/api/version" 2>/dev/null | sed -n 's/.*"tunarr":"\([^"]*\)".*/\1/p' | head -n1)
  echo "@@tunarr $name|$image|$project|$ver"
done
true
`

export interface TunarrFacts { name: string; image: string; project: string; version: string }

/** Parses DETECT_SCRIPT's output. Every field comes from a guest, so each is checked. */
export function parseDetect(output: string): TunarrFacts[] {
  const out: TunarrFacts[] = []
  for (const line of output.split('\n')) {
    const m = /^@@tunarr ([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)$/.exec(line.trim())
    if (!m) continue
    const [, name, image, project, version] = m
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !IMAGE.test(image) || !/^[A-Za-z0-9_.:@\/-]{1,200}$/.test(image)) continue
    out.push({ name, image, project: /^[A-Za-z0-9_.-]{0,63}$/.test(project) ? project : '', version: version.trim().slice(0, 64) })
  }
  return out
}

/** The tag after the image name: "latest" when none is given. */
export const imageTag = (image: string): string => (image.includes('@') ? 'digest' : /:([^:/]+)$/.exec(image)?.[1] ?? 'latest')

const facts = (i: AppInstall) => i.facts as unknown as TunarrFacts

export const tunarrProvider: AppUpdateProvider = {
  id: 'tunarr',
  name: 'Tunarr',

  async detect(ctx: AppContext): Promise<AppInstall[]> {
    const r = await ctx.run(DETECT_SCRIPT, { timeoutMs: 40_000 })
    return parseDetect(r.output).map(f => ({
      key: createHash('sha1').update(f.name).digest('hex').slice(0, 12),
      name: 'Tunarr',
      installed: splitVersion(f.version).base ?? '',
      location: f.project ? `Docker stack ${f.project}, container ${f.name}` : `Docker container ${f.name}`,
      runAs: 'root',
      // A container, not a systemd unit: HyperProx stops and starts it through the Docker update path only.
      service: null,
      running: true,
      how: `Docker image ${f.image}`,
      facts: { ...f } as unknown as Record<string, unknown>,
    }))
  },

  async latest(install: AppInstall, ctx: AppContext): Promise<AppRelease> {
    const rows = await ctx.fetchJson(RELEASES)
    const list: any[] = Array.isArray(rows) ? rows : []
    const stable = list
      .filter(r => r && !r.draft && !r.prerelease)
      .map(r => ({ version: splitVersion(r.tag_name).base, url: typeof r.html_url === 'string' ? r.html_url : undefined, text: String(r.body ?? '').slice(0, 1500) }))
      .filter((r): r is { version: string; url: string | undefined; text: string } => !!r.version)
      .sort((a, b) => compareVersions(b.version, a.version))
    const installed = install.installed
    const newer = isVersion(installed) ? stable.filter(r => compareVersions(r.version, installed) > 0) : stable.slice(0, 1)
    return {
      latest: stable[0]?.version ?? null,
      notes: newer.slice(0, 10).map(r => ({ version: r.version, ...(r.url ? { url: r.url } : {}), text: r.text })),
      isSecurity: false,
    }
  },

  async preflight(install: AppInstall, target: string | null): Promise<AppIssue[]> {
    const f = facts(install)
    const issues: AppIssue[] = []
    if (!install.installed) issues.push({ message: 'Tunarr did not report its version (its web address could not be reached from inside the guest), so it cannot be compared with the newest release.', blocking: false })
    if (!target) return issues
    const tag = imageTag(f.image)
    issues.push({
      message: tag === 'latest'
        ? `Tunarr ${target} is out. HyperProx does not update Tunarr itself: its Docker image is updated by the guest's Docker update (the policy's docker setting pulls the image and recreates the stack, then checks every container runs).`
        : `Tunarr ${target} is out. The stack pins the image tag "${tag}", so pulling alone changes nothing: edit the tag in the stack's compose file, then the guest's Docker update recreates it. HyperProx does not update Tunarr itself.`,
      blocking: true,
    })
    return issues
  },

  async apply(): Promise<AppStepResult> {
    return { ok: false, message: 'HyperProx does not update Tunarr itself; its Docker image is updated by the guest\'s Docker update.' }
  },

  async verify(): Promise<AppStepResult> {
    return { ok: false, message: 'Nothing was updated by this provider, so there is nothing to verify.' }
  },

  rollback(install: AppInstall): string {
    return `Nothing here changes Tunarr. If a Docker update of its image goes wrong, set the image tag back to ${install.installed || 'the previous version'} in the compose file and recreate the stack.`
  },
}
