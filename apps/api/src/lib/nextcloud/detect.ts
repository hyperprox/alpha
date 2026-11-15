// =============================================================================
//  HyperProx — Nextcloud: how it is installed in its guest
//
//  One read-only script, run in the guest as root, answers:
//    - is there Docker, and which containers have Nextcloud's occ in them;
//    - for that container: its Compose project, service, directory and file,
//      its image, and whether the image was built here (no registry digest:
//      it was built from a Dockerfile, so an update must rebuild with --pull,
//      a plain pull would change nothing);
//    - the database, Talk signalling (HPB) and Client Push containers of the
//      same project;
//    - or, with no container, where a plain install keeps occ and which user
//      owns its config.
//  Nothing here starts, stops or changes anything, and no environment variable
//  (where Compose keeps the database password) is ever read, except the image's
//  own NEXTCLOUD_VERSION.
// =============================================================================

import { CONTAINER_RE, OCC_PATH_RE, UNIX_USER_RE, type OccTarget } from './occ'

export const DETECT_SCRIPT = String.raw`set +e
if command -v docker >/dev/null 2>&1; then
  echo "DOCKER|$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  echo "COMPOSE|$(docker compose version --short 2>/dev/null)"
  docker ps -a --no-trunc --format '{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.State}}' 2>/dev/null | head -60 |
  while IFS='|' read -r name image proj svc wd cfg state; do
    occ=0; ver=""; sig=""; df=0
    if [ "$state" = running ]; then
      docker exec "$name" test -f /var/www/html/occ </dev/null 2>/dev/null && occ=1
      [ "$occ" = 1 ] && ver=$(docker exec "$name" sh -c 'printf %s "$NEXTCLOUD_VERSION"' </dev/null 2>/dev/null)
      case "$image" in *spreed-signaling*) sig=$(docker exec "$name" nextcloud-spreed-signaling -version </dev/null 2>/dev/null | head -1 | tr -d '|');; esac
    fi
    iid=$(docker inspect --format '{{.Image}}' "$name" 2>/dev/null)
    digests=$(docker image inspect --format '{{len .RepoDigests}}' "$iid" 2>/dev/null)
    np=0; docker inspect --format '{{.Path}} {{join .Args " "}}' "$name" 2>/dev/null | grep -q notify_push && np=1
    [ -n "$wd" ] && [ -f "$wd/Dockerfile" ] && df=1
    # Does the Compose file give this service a build: key? Only that one bit is printed, never the file
    # (it usually holds the database password).
    bk=0; f1=$(printf %s "$cfg" | cut -d, -f1)
    if [ -n "$svc" ] && [ -f "$f1" ]; then
      bk=$(awk -v svc="$svc" '
        function ind(s) { match(s, /^ */); return RLENGTH }
        /^[[:space:]]*(#|$)/ { next }
        { i = ind($0); l = $0; sub(/^ +/, "", l) }
        i == 0 { top = l; si = -1; ci = -1; ins = 0; next }
        top !~ /^services:/ { next }
        si < 0 || i <= si { si = i; n = l; sub(/:.*/, "", n); gsub(/"/, "", n); ins = (n == svc); ci = -1; next }
        ins && ci < 0 { ci = i }
        ins && i == ci && l ~ /^build:/ { found = 1 }
        END { print found ? 1 : 0 }' "$f1" 2>/dev/null)
    fi
    echo "CTR|$name|$image|$iid|$proj|$svc|$wd|$cfg|$state|$occ|$digests|$np|$ver|$sig|$df|$bk"
  done
fi
for p in /var/www/nextcloud/occ /var/www/html/occ /var/www/html/nextcloud/occ /srv/nextcloud/occ /usr/share/nextcloud/occ /var/www/nextcloud/html/occ; do
  [ -f "$p" ] && echo "BARE|$p|$(stat -c %U "$(dirname "$p")/config/config.php" 2>/dev/null)"
done
echo "END|ok"
`

export interface ContainerFact {
  name: string; image: string; imageId: string; project: string; service: string; workdir: string; configFile: string
  state: string; hasOcc: boolean; repoDigests: number; notifyPush: boolean; imageVersion: string | null; signalingVersion: string | null; dockerfile: boolean
  /** The Compose file gives this service a build: key. */
  buildKey: boolean
}

export interface AppFacts {
  container: string; image: string; imageId: string; project: string | null; service: string | null; workdir: string | null; configFile: string | null
  /** Built here (no registry digest): an update rebuilds with --pull. */
  built: boolean
  /** A Dockerfile sits in the Compose directory. */
  dockerfile: boolean
  /** The image's own NEXTCLOUD_VERSION, when it sets one (the official image does). */
  imageVersion: string | null
}

export interface Deployment {
  /** compose: HyperProx can update it. docker: a container without Compose. bare: a plain install. */
  kind: 'compose' | 'docker' | 'bare'
  occ: OccTarget
  app: AppFacts | null
  db: { container: string; image: string; engine: 'postgres' | 'mysql'; service: string | null } | null
  signaling: { container: string; image: string; imageId: string; service: string | null; project: string | null; workdir: string | null; configFile: string | null; version: string | null; running: boolean } | null
  notifyPush: { container: string; running: boolean } | null
  docker: string | null
  compose: string | null
  /** Plain install: the directory occ is in. */
  bareDir?: string
}

const PATH_RE = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/

const okPath = (p: string) => PATH_RE.test(p) && !p.split('/').includes('..') ? p : ''

export function parseContainers(out: string): ContainerFact[] {
  const list: ContainerFact[] = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('CTR|')) continue
    const f = line.split('|')
    if (f.length < 16) continue
    const [, name, image, imageId, project, service, workdir, configFile, state, occ, digests, np, ver, sig, df, bk] = f
    if (!CONTAINER_RE.test(name)) continue
    list.push({
      name, image: IMAGE_RE.test(image) ? image : '', imageId: IMAGE_ID_RE.test(imageId) ? imageId : '',
      project: PROJECT_RE.test(project) ? project : '', service: SERVICE_RE.test(service) ? service : '',
      workdir: okPath(workdir), configFile: configFile.split(',').map(okPath).filter(Boolean)[0] ?? '',
      state: /^[a-z]{1,20}$/.test(state) ? state : 'unknown', hasOcc: occ === '1', repoDigests: Number(digests) || 0, notifyPush: np === '1',
      imageVersion: VERSION_RE.test(ver) ? ver : null,
      signalingVersion: /version\s+([^\s/]{1,60})/.exec(sig)?.[1] ?? null,
      dockerfile: df === '1', buildKey: bk === '1',
    })
  }
  return list
}

/** What the detection script found, as a deployment; null when there is no Nextcloud in the guest. */
export function parseDetect(out: string): Deployment | null {
  if (!/^END\|ok$/m.test(out)) throw new Error('The detection did not finish in the guest.')
  const docker = /^DOCKER\|(\S{1,40})$/m.exec(out)?.[1] ?? null
  const compose = /^COMPOSE\|v?(\S{1,40})$/m.exec(out)?.[1] ?? null
  const cs = parseContainers(out)
  const app = cs.find(c => c.hasOcc && c.state === 'running') ?? null
  if (app) {
    const same = (c: ContainerFact) => !!app.project && c.project === app.project
    const db = cs.find(c => same(c) && /(^|\/)(postgres|postgis)/i.test(c.image)) ?? cs.find(c => same(c) && /(^|\/)(mariadb|mysql)/i.test(c.image))
    const sig = cs.find(c => same(c) && /spreed-signaling/i.test(c.image)) ?? cs.find(c => /spreed-signaling/i.test(c.image))
    const np = cs.find(c => c.notifyPush)
    const isCompose = !!(app.project && app.service && app.workdir && app.configFile)
    return {
      kind: isCompose ? 'compose' : 'docker',
      occ: { mode: 'docker', container: app.name },
      app: {
        container: app.name, image: app.image, imageId: app.imageId, project: app.project || null, service: app.service || null,
        workdir: app.workdir || null, configFile: app.configFile || null, built: app.buildKey || app.repoDigests === 0, dockerfile: app.dockerfile, imageVersion: app.imageVersion,
      },
      db: db ? { container: db.name, image: db.image, engine: /postgres|postgis/i.test(db.image) ? 'postgres' : 'mysql', service: db.service || null } : null,
      signaling: sig ? { container: sig.name, image: sig.image, imageId: sig.imageId, service: sig.service || null, project: sig.project || null, workdir: sig.workdir || null, configFile: sig.configFile || null, version: sig.signalingVersion, running: sig.state === 'running' } : null,
      notifyPush: np ? { container: np.name, running: np.state === 'running' } : null,
      docker, compose,
    }
  }
  const bare = /^BARE\|(\S+)\|([a-z_][a-z0-9_-]{0,31})?$/m.exec(out)
  if (bare && OCC_PATH_RE.test(bare[1]) && !bare[1].includes('..')) {
    const user = bare[2] && UNIX_USER_RE.test(bare[2]) && bare[2] !== 'root' ? bare[2] : 'www-data'
    return { kind: 'bare', occ: { mode: 'bare', occPath: bare[1], user }, app: null, db: null, signaling: null, notifyPush: null, docker, compose, bareDir: bare[1].replace(/\/occ$/, '') }
  }
  return null
}

/** In plain words, for the page. */
export function deploymentWords(d: Deployment): string {
  if (d.kind === 'bare') return `A plain install at ${d.bareDir}, occ run as ${d.occ.mode === 'bare' ? d.occ.user : 'www-data'}.`
  const a = d.app!
  if (d.kind === 'docker') return `Docker container ${a.container} (${a.image}), not managed by Compose.`
  return `Docker Compose project ${a.project} in ${a.workdir}, service ${a.service}, image ${a.image}${a.built ? ' built from a Dockerfile here' : ''}.`
}
