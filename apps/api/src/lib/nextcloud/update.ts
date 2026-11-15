// =============================================================================
//  HyperProx — Nextcloud: updating a Docker Compose install, and its Talk HPB
//
//  Nextcloud's web updater is off in Docker images on purpose: the image IS the
//  code, so an update is a new image. The order here is the one Nextcloud's
//  own upgrade notes give, with HyperProx's checks in front:
//
//    0  preflight, again, at the moment it starts: nobody active (other than
//       HyperProx's own app password), no Talk call running, no backup of the
//       guest running, room for the dump, nothing half-done (maintenance mode,
//       a pending database upgrade);
//    1  maintenance mode on, so nobody writes while the database is copied;
//    2  the database dumped inside the Compose project (pg_dump -Fc, or
//       mysqldump), read back to prove it is whole, and config.php copied
//       beside it. With bind mounts a container cannot be snapshotted, so this
//       dump is the rollback, and the page says so;
//    3  the image in use tagged hyperprox-pre-<version>, so the old code stays
//       on disk for a rollback;
//    4  the new image: `compose build --pull` when the service is built from a
//       Dockerfile (a plain pull would change nothing), else `compose pull`.
//       Its NEXTCLOUD_VERSION is read: newer, at most one major ahead, or the
//       job stops here and turns maintenance mode back off;
//    5  `compose up -d --no-deps <service>`: the container is recreated and the
//       image's entrypoint runs occ upgrade;
//    6  occ status until it reports the new version with no pending upgrade
//       (occ upgrade itself if the entrypoint did not; maintenance mode off if
//       it was left on);
//    7  the post-upgrade steps: missing indices, columns and primary keys.
//
//  Nothing is deleted at any step: old dumps and the old image stay until a
//  person removes them.
// =============================================================================

import { occLine, occArgs, type OccTarget, type OccId } from './occ'
import { compareVersions, majorOf, parseStatus } from './parse'
import type { Deployment } from './detect'
import type { JobStep } from './types'

const PATH_RE = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const DB_IDENT_RE = /^[A-Za-z0-9_-]{1,63}$/

export class UpdateRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'UpdateRefusal' }
}

function sq(v: string | null | undefined, re: RegExp, what: string): string {
  if (typeof v !== 'string' || !re.test(v) || v.split('/').includes('..')) throw new UpdateRefusal(`HyperProx will not use that ${what}.`)
  return `'${v}'`
}

/** `docker compose` for exactly this project, its directory and its file. */
export function composeCmd(a: { workdir: string | null; configFile: string | null; project: string | null }): string {
  return `docker compose --project-directory ${sq(a.workdir, PATH_RE, 'directory')} -f ${sq(a.configFile, PATH_RE, 'Compose file')} -p ${sq(a.project, /^[a-z0-9][a-z0-9_-]{0,62}$/, 'project name')}`
}

/** "repo:tag" -> "repo"; null for a digest reference, which cannot be re-tagged. */
export function imageRepo(image: string): string | null {
  if (!IMAGE_RE.test(image) || image.includes('@')) return null
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  return colon > slash ? image.slice(0, colon) : image
}

export const safeTag = (v: string) => v.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100)

/** Where the dumps go: inside the Compose project, beside the Compose file. */
export const backupDirOf = (d: Deployment) => `${d.app!.workdir!.replace(/\/+$/, '')}/hyperprox-backups`

export interface UpdatePlan {
  from: string
  /** What update:check offered; the image decides what is actually installed. */
  offered: string
  source: 'build' | 'pull'
  backupDir: string
  stamp: string
  db: { engine: 'postgres' | 'mysql'; container: string; name: string | null; user: string | null }
  app: { container: string; service: string; image: string; imageId: string; workdir: string; configFile: string; project: string }
}

export const UPDATE_STEPS: Array<{ key: string; label: string }> = [
  { key: 'preflight',   label: 'Check nobody is using it' },
  { key: 'maintenance', label: 'Maintenance mode on' },
  { key: 'backup',      label: 'Dump the database' },
  { key: 'keep',        label: 'Keep the current image' },
  { key: 'image',       label: 'Get the new image' },
  { key: 'recreate',    label: 'Recreate the container' },
  { key: 'upgrade',     label: 'Wait for the upgrade' },
  { key: 'post',        label: 'Post-upgrade steps' },
]

export const HPB_STEPS: Array<{ key: string; label: string }> = [
  { key: 'preflight', label: 'Check no call is running' },
  { key: 'keep',      label: 'Keep the current image' },
  { key: 'pull',      label: 'Pull the newest image' },
  { key: 'recreate',  label: 'Recreate the signalling container' },
  { key: 'verify',    label: 'Check its version' },
]

/** The dump: written to a .part file, renamed when complete, read back, and config.php copied beside it. */
export function backupScript(p: UpdatePlan): string {
  const dir = sq(p.backupDir, PATH_RE, 'backup directory')
  const db = sq(p.db.container, NAME_RE, 'database container')
  const app = sq(p.app.container, NAME_RE, 'app container')
  if (!/^\d{8}T\d{6}Z$/.test(p.stamp)) throw new UpdateRefusal('Bad timestamp.')
  const lines = ['set -e', 'set -o pipefail', `install -d -m 700 ${dir}`]
  if (p.db.engine === 'postgres') {
    const user = sq(p.db.user, DB_IDENT_RE, 'database user'), name = sq(p.db.name, DB_IDENT_RE, 'database name')
    const f = `${p.backupDir}/nextcloud-db-${p.stamp}.dump`
    lines.push(
      `docker exec ${db} pg_dump -U ${user} -d ${name} -Fc > '${f}.part'`,
      `mv '${f}.part' '${f}'`, `chmod 600 '${f}'`,
      // Read back: pg_restore must be able to list every object in it.
      `docker exec -i ${db} pg_restore --list < '${f}' > /dev/null`,
      `echo "DUMP|${f}|$(stat -c %s '${f}')"`,
    )
  } else {
    const f = `${p.backupDir}/nextcloud-db-${p.stamp}.sql.gz`
    // The password comes from the database container's own environment and goes in MYSQL_PWD, never on a command line.
    lines.push(
      `docker exec ${db} sh -c 'MYSQL_PWD="\${MYSQL_PASSWORD:-\$MARIADB_PASSWORD}"; export MYSQL_PWD; D=$(command -v mariadb-dump || command -v mysqldump); exec "$D" --single-transaction --routines -u"\${MYSQL_USER:-\$MARIADB_USER}" "\${MYSQL_DATABASE:-\$MARIADB_DATABASE}"' | gzip > '${f}.part'`,
      `mv '${f}.part' '${f}'`, `chmod 600 '${f}'`, `gzip -t '${f}'`,
      `echo "DUMP|${f}|$(stat -c %s '${f}')"`,
    )
  }
  lines.push(
    `docker exec ${app} cat /var/www/html/config/config.php > '${p.backupDir}/config-${p.stamp}.php'`,
    `chmod 600 '${p.backupDir}/config-${p.stamp}.php'`,
    `echo "CONFIG|${p.backupDir}/config-${p.stamp}.php"`,
  )
  return lines.join('\n') + '\n'
}

/** Room for the dump: free KiB in the Compose directory and the database's size in bytes. Read-only. */
export function preflightScript(p: UpdatePlan): string {
  const db = sq(p.db.container, NAME_RE, 'database container')
  const wd = sq(p.app.workdir, PATH_RE, 'directory')
  const size = p.db.engine === 'postgres'
    ? `docker exec ${db} psql -U ${sq(p.db.user, DB_IDENT_RE, 'database user')} -d ${sq(p.db.name, DB_IDENT_RE, 'database name')} -Atc 'select pg_database_size(current_database())'`
    : `docker exec ${db} sh -c 'MYSQL_PWD="\${MYSQL_PASSWORD:-\$MARIADB_PASSWORD}"; export MYSQL_PWD; M=$(command -v mariadb || command -v mysql); exec "$M" -N -u"\${MYSQL_USER:-\$MARIADB_USER}" -e "select coalesce(sum(data_length+index_length),0) from information_schema.tables where table_schema=database()" "\${MYSQL_DATABASE:-\$MARIADB_DATABASE}"'`
  return [
    'set +e',
    `echo "DF|$(df -Pk ${wd} | awk 'NR==2 {print $4}')"`,
    `echo "DBSIZE|$(${size} 2>/dev/null | tr -dc 0-9)"`,
    `docker compose version >/dev/null 2>&1 && echo "COMPOSE|1" || echo "COMPOSE|0"`,
    `[ -f ${sq(p.app.configFile, PATH_RE, 'Compose file')} ] && echo "CFG|1" || echo "CFG|0"`,
    `echo "IMG|$(docker inspect --format '{{.Image}}' ${sq(p.app.container, NAME_RE, 'app container')} 2>/dev/null)"`,
  ].join('\n') + '\n'
}

export interface Room { freeBytes: number | null; dbBytes: number | null; compose: boolean; configFile: boolean; imageId: string | null }
export function parseRoom(out: string): Room {
  const get = (k: string) => new RegExp(`^${k}\\|(.*)$`, 'm').exec(out)?.[1]?.trim() ?? ''
  const free = get('DF'), size = get('DBSIZE'), img = get('IMG')
  return { freeBytes: /^\d+$/.test(free) ? Number(free) * 1024 : null, dbBytes: /^\d+$/.test(size) ? Number(size) : null, compose: get('COMPOSE') === '1', configFile: get('CFG') === '1', imageId: IMAGE_ID_RE.test(img) ? img : null }
}

/** Free space needed for the dump: the database's size (dumps are smaller, but not always) plus 200 MiB. */
export function roomProblem(r: Room): string | null {
  if (r.freeBytes === null) return 'HyperProx could not read the free space in the Compose directory.'
  if (r.dbBytes === null) return 'HyperProx could not read the database size, so it cannot be sure the dump fits.'
  const need = r.dbBytes + 200 * 1024 * 1024
  if (r.freeBytes < need) return `The Compose directory has ${Math.round(r.freeBytes / 1048576)} MiB free; the dump needs about ${Math.round(need / 1048576)} MiB.`
  return null
}

/** Is `next` an acceptable target from `from`? */
export function targetProblem(from: string, next: string | null): string | null {
  if (!next) return 'The new image does not say which Nextcloud it holds (no NEXTCLOUD_VERSION), so HyperProx will not recreate the container with it.'
  const c = compareVersions(next, from)
  if (c === 0) return `The new image is still Nextcloud ${from}: there is nothing newer under this image's tag yet.`
  if (c < 0) return `The new image holds Nextcloud ${next}, older than ${from}. Nextcloud cannot be downgraded this way.`
  if (majorOf(next) > majorOf(from) + 1) return `The new image holds Nextcloud ${next}, more than one major version ahead of ${from}. Nextcloud upgrades one major at a time: pin the image to ${majorOf(from) + 1} first.`
  return null
}

export function rollbackWords(p: UpdatePlan, dump: string | null): string {
  const repo = imageRepo(p.app.image)
  const tag = repo ? `${repo}:hyperprox-pre-${safeTag(p.from)}` : null
  const compose = `cd ${p.app.workdir} && docker compose -p ${p.app.project}`
  return [
    `To go back to Nextcloud ${p.from}:`,
    tag ? `1. Point the image back: docker tag ${tag} ${p.app.image}` : `1. Re-create the old image (it was referenced by digest, so HyperProx could not tag it).`,
    `2. Stop the app: ${compose} stop ${p.app.service}`,
    p.db.engine === 'postgres'
      ? `3. Restore the database: docker exec -i ${p.db.container} pg_restore --clean --if-exists -U ${p.db.user} -d ${p.db.name} < ${dump ?? `${p.backupDir}/nextcloud-db-${p.stamp}.dump`}`
      : `3. Restore the database: gunzip -c ${dump ?? `${p.backupDir}/nextcloud-db-${p.stamp}.sql.gz`} | docker exec -i ${p.db.container} sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'`,
    `4. Put the old config back: docker cp ${p.backupDir}/config-${p.stamp}.php ${p.app.container}:/var/www/html/config/config.php (then chown www-data inside the container)`,
    `5. Start it: ${compose} up -d --no-deps ${p.app.service}`,
    'Files in the data directory are not touched by an upgrade, so they need no restore.',
  ].join('\n')
}

// ── the run ──────────────────────────────────────────────────────────────────

export interface RunIO {
  /** A script in the guest, as root. */
  run(script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  step(key: string, state: JobStep['state'], detail?: string): void
  log(line: string): void
  sleep(ms: number): Promise<void>
  now(): number
}

const occ = (t: OccTarget, id: OccId, params?: unknown) => `set -o pipefail\n${occLine(t, occArgs(id, params))}\n`
const tail = (s: string, n = 600) => s.trim().slice(-n)

/** Steps 1-7. Step 0 (preflight) is the service's; it calls this only once that passed. Throws with the reason. */
export async function runComposeUpdate(p: UpdatePlan, io: RunIO): Promise<{ version: string; dump: string; warnings: string[] }> {
  const t: OccTarget = { mode: 'docker', container: p.app.container }
  const compose = composeCmd({ workdir: p.app.workdir, configFile: p.app.configFile, project: p.app.project })
  const svc = sq(p.app.service, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'service')
  const warnings: string[] = []
  let maintenance = false
  const maintenanceOff = async () => {
    if (!maintenance) return
    const r = await io.run(occ(t, 'maintenance-off'), 120_000)
    io.log(tail(r.output, 300))
    if (r.code === 0) maintenance = false
  }

  io.step('maintenance', 'running')
  const on = await io.run(occ(t, 'maintenance-on'), 120_000)
  if (on.code !== 0) { io.step('maintenance', 'failed', tail(on.output, 200)); throw new Error('Maintenance mode could not be turned on, so nothing was changed.') }
  maintenance = true
  io.step('maintenance', 'done')

  io.step('backup', 'running', p.backupDir)
  const b = await io.run(backupScript(p), 60 * 60_000)
  io.log(tail(b.output))
  const dump = /^DUMP\|(\S+)\|(\d+)$/m.exec(b.output)
  if (b.code !== 0 || !dump || Number(dump[2]) <= 0) {
    io.step('backup', 'failed', tail(b.output, 200))
    await maintenanceOff()
    throw new Error(`The database dump did not complete, so nothing else was changed${maintenance ? ' (maintenance mode is still on: turn it off with occ maintenance:mode --off)' : ''}.`)
  }
  io.step('backup', 'done', `${dump[1]} (${Math.round(Number(dump[2]) / 1048576)} MiB), config.php beside it`)

  io.step('keep', 'running')
  const repo = imageRepo(p.app.image)
  if (repo && IMAGE_ID_RE.test(p.app.imageId)) {
    const tag = `${repo}:hyperprox-pre-${safeTag(p.from)}`
    const k = await io.run(`docker image tag ${sq(p.app.imageId, IMAGE_ID_RE, 'image id')} ${sq(tag, IMAGE_RE, 'tag')}\n`, 60_000)
    if (k.code !== 0) { warnings.push('The current image could not be tagged for a rollback.'); io.step('keep', 'skipped', tail(k.output, 200)) }
    else io.step('keep', 'done', tag)
  } else { warnings.push('The current image is referenced by digest and was not tagged.'); io.step('keep', 'skipped', 'referenced by digest') }

  io.step('image', 'running', p.source === 'build' ? 'compose build --pull' : 'compose pull')
  const img = await io.run(`set -o pipefail\n${compose} ${p.source === 'build' ? 'build --pull' : 'pull'} ${svc} 2>&1 | tail -n 40\n`, 60 * 60_000)
  io.log(tail(img.output, 2000))
  if (img.code !== 0) { io.step('image', 'failed', tail(img.output, 200)); await maintenanceOff(); throw new Error(`The new image could not be ${p.source === 'build' ? 'built' : 'pulled'}; the running container was not touched${maintenance ? '' : ' and maintenance mode is off again'}.`) }
  const v = await io.run(`docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${sq(p.app.image, IMAGE_RE, 'image')} | sed -n 's/^NEXTCLOUD_VERSION=//p'\n`, 60_000)
  const next = /^(\d{1,3}(?:\.\d{1,3}){1,3})$/m.exec(v.output.trim())?.[1] ?? null
  const bad = targetProblem(p.from, next)
  if (bad) { io.step('image', 'failed', bad); await maintenanceOff(); throw new Error(`${bad} The running container was not touched${maintenance ? '' : ' and maintenance mode is off again'}.`) }
  io.step('image', 'done', `Nextcloud ${next}`)

  io.step('recreate', 'running')
  const up = await io.run(`set -o pipefail\n${compose} up -d --no-deps ${svc} 2>&1 | tail -n 20\n`, 15 * 60_000)
  io.log(tail(up.output, 1000))
  if (up.code !== 0) { io.step('recreate', 'failed', tail(up.output, 200)); throw new Error('The container could not be recreated. See the rollback steps.') }
  io.step('recreate', 'done')

  io.step('upgrade', 'running', `waiting for ${next}`)
  const deadline = io.now() + 40 * 60_000
  let ran = false
  for (;;) {
    await io.sleep(10_000)
    const s = await io.run(occ(t, 'status'), 60_000)
    const st = s.code === 0 ? parseStatus(s.output) : null
    if (st && st.versionString === next && !st.needsDbUpgrade) {
      // The image's upgrade turns maintenance mode off at its end; if it was left on, HyperProx turns it off.
      maintenance = st.maintenance
      if (maintenance) await maintenanceOff()
      if (!maintenance) break
    } else if (st && st.needsDbUpgrade && !ran && io.now() > deadline - 30 * 60_000) {
      // The entrypoint did not run the upgrade itself (a custom entrypoint, say): run it once.
      ran = true
      io.log('Running occ upgrade')
      const u = await io.run(occ(t, 'upgrade'), 60 * 60_000)
      io.log(tail(u.output, 2000))
      if (u.code !== 0) { io.step('upgrade', 'failed', tail(u.output, 200)); throw new Error('occ upgrade failed. See the rollback steps.') }
    }
    if (io.now() > deadline) { io.step('upgrade', 'failed', 'timed out'); throw new Error(`Nextcloud did not report ${next} within 40 minutes. Check the container's log (docker logs ${p.app.container}).`) }
  }
  io.step('upgrade', 'done', `Nextcloud ${next}, maintenance mode off`)

  io.step('post', 'running')
  for (const id of ['add-indices', 'add-columns', 'add-primary-keys'] as const) {
    const r = await io.run(occ(t, id), 60 * 60_000)
    io.log(tail(r.output, 1000))
    if (r.code !== 0) warnings.push(`occ ${occArgs(id).join(' ')} failed; run it by hand.`)
  }
  io.step('post', 'done', warnings.length ? `${warnings.length} warning(s)` : undefined)
  return { version: next!, dump: dump[1], warnings }
}

export interface HpbPlan {
  container: string; service: string; image: string; imageId: string
  workdir: string; configFile: string; project: string
  from: string | null
}

export async function runHpbUpdate(p: HpbPlan, io: RunIO): Promise<{ changed: boolean; version: string | null }> {
  const compose = composeCmd({ workdir: p.workdir, configFile: p.configFile, project: p.project })
  const svc = sq(p.service, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'service')
  const image = sq(p.image, IMAGE_RE, 'image')
  io.step('keep', 'running')
  const repo = imageRepo(p.image)
  if (repo && IMAGE_ID_RE.test(p.imageId) && p.from) {
    const tag = `${repo}:hyperprox-pre-${safeTag(p.from)}`
    const k = await io.run(`docker image tag ${sq(p.imageId, IMAGE_ID_RE, 'image id')} ${sq(tag, IMAGE_RE, 'tag')}\n`, 60_000)
    io.step('keep', k.code === 0 ? 'done' : 'skipped', k.code === 0 ? tag : tail(k.output, 200))
  } else io.step('keep', 'skipped')

  io.step('pull', 'running')
  const pull = await io.run(`set -o pipefail\n${compose} pull ${svc} 2>&1 | tail -n 20\n`, 30 * 60_000)
  io.log(tail(pull.output, 1000))
  if (pull.code !== 0) { io.step('pull', 'failed', tail(pull.output, 200)); throw new Error('The new signalling image could not be pulled; nothing was changed.') }
  const id = (await io.run(`docker image inspect --format '{{.Id}}' ${image}\n`, 60_000)).output.trim()
  if (id === p.imageId) {
    io.step('pull', 'done', 'already the newest image')
    io.step('recreate', 'skipped', 'nothing newer'); io.step('verify', 'skipped')
    return { changed: false, version: p.from }
  }
  io.step('pull', 'done')

  io.step('recreate', 'running')
  const up = await io.run(`set -o pipefail\n${compose} up -d --no-deps ${svc} 2>&1 | tail -n 20\n`, 10 * 60_000)
  io.log(tail(up.output, 1000))
  if (up.code !== 0) { io.step('recreate', 'failed', tail(up.output, 200)); throw new Error('The signalling container could not be recreated.') }
  io.step('recreate', 'done')

  io.step('verify', 'running')
  const c = sq(p.container, NAME_RE, 'container')
  let version: string | null = null
  for (let i = 0; i < 12 && !version; i++) {
    await io.sleep(5_000)
    const r = await io.run(`docker exec ${c} nextcloud-spreed-signaling -version 2>/dev/null | head -1\n`, 30_000)
    version = /version\s+([^\s/]{1,60})/.exec(r.output)?.[1] ?? null
  }
  io.step('verify', version ? 'done' : 'failed', version ?? 'it did not answer')
  if (!version) throw new Error(`The signalling container did not start properly. Check docker logs ${p.container}; the previous image is tagged for a rollback.`)
  return { changed: true, version }
}
