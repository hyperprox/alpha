// =============================================================================
//  HyperProx — Nextcloud: updating a Docker Compose install, and its Talk HPB
//
//  Nextcloud's web updater is off in Docker images on purpose: the image IS the
//  code, so an update is a new image. The order here is the one Nextcloud's
//  own upgrade notes give, with HyperProx's checks in front:
//
//    0  preflight, again, at the moment it starts: nobody active (other than
//       HyperProx's own app password), no Talk call running, no backup of the
//       guest running, room for the dump and the new image, nothing half-done
//       (maintenance mode, a pending database upgrade);
//    1  config.php copied into the backup directory, BEFORE maintenance mode,
//       so the copy does not carry 'maintenance' => true back on a restore;
//    2  maintenance mode on, so nobody writes while the database is copied;
//    3  the database dumped inside the Compose project (pg_dump -Fc, or
//       mysqldump), read back to prove it is whole. With bind mounts a
//       container cannot be snapshotted, so this dump is the rollback, and the
//       page says so;
//    4  the image in use tagged hyperprox-pre-<version>, so the old code stays
//       on disk for a rollback;
//    5  the new image: `compose build --pull` when the service is built from a
//       Dockerfile (a plain pull would change nothing), else `compose pull`.
//       Its NEXTCLOUD_VERSION is read: newer, at most one major ahead, or the
//       job stops here and turns maintenance mode back off;
//    6  `compose up -d --no-deps <service>`: the container is recreated and the
//       image's entrypoint runs occ upgrade;
//    7  occ status until it reports the new version with no pending upgrade
//       (occ upgrade itself, once, only if the image's entrypoint is not
//       upgrading: no `occ upgrade` process, and its flock on
//       nextcloud-init-sync.lock is free (the file itself always stays);
//       maintenance mode off if it was left on);
//    8  the post-upgrade steps: missing indices, columns and primary keys.
//
//  Steps 1-8 run as ONE script started detached inside the guest (systemd-run,
//  else nohup setsid), so neither a closed connection nor an API restart stops
//  it halfway. It writes its progress to a state file and its output to a log
//  under <backup dir>/jobs/<job id>; HyperProx polls those. Every failure says
//  whether maintenance mode is still on.
//
//  Nothing is deleted at any step: old dumps and the old image stay until a
//  person removes them.
// =============================================================================

import { compareVersions, majorOf } from './parse'
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
  { key: 'config',      label: 'Copy config.php' },
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

const MYSQL_ENV = `MYSQL_PWD="\${MYSQL_PASSWORD:-\$MARIADB_PASSWORD}"; export MYSQL_PWD`
const MYSQL_USER = `"\${MYSQL_USER:-\$MARIADB_USER}"`
const MYSQL_DB = `"\${MYSQL_DATABASE:-\$MARIADB_DATABASE}"`

/** Room for the dump and the new image: free KiB by filesystem and the database's size in bytes. Read-only. */
export function preflightScript(p: UpdatePlan): string {
  const db = sq(p.db.container, NAME_RE, 'database container')
  const wd = sq(p.app.workdir, PATH_RE, 'directory')
  const size = p.db.engine === 'postgres'
    ? `docker exec ${db} psql -U ${sq(p.db.user, DB_IDENT_RE, 'database user')} -d ${sq(p.db.name, DB_IDENT_RE, 'database name')} -Atc 'select pg_database_size(current_database())'`
    : `docker exec ${db} sh -c '${MYSQL_ENV}; M=$(command -v mariadb || command -v mysql); exec "$M" -N -u${MYSQL_USER} -e "select coalesce(sum(data_length+index_length),0) from information_schema.tables where table_schema=database()" ${MYSQL_DB}'`
  return [
    'set +e',
    `R="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"; [ -d "$R" ] || R=/var/lib/docker`,
    `echo "DF|$(df -Pk ${wd} | awk 'NR==2 {print $4}')"`,
    `echo "DFIMG|$(df -Pk "$R" | awk 'NR==2 {print $4}')"`,
    `[ "$(stat -c %d ${wd} 2>/dev/null)" = "$(stat -c %d "$R" 2>/dev/null)" ] && echo "SAMEFS|1" || echo "SAMEFS|0"`,
    `echo "DBSIZE|$(${size} 2>/dev/null | tr -dc 0-9)"`,
    `docker compose version >/dev/null 2>&1 && echo "COMPOSE|1" || echo "COMPOSE|0"`,
    `[ -f ${sq(p.app.configFile, PATH_RE, 'Compose file')} ] && echo "CFG|1" || echo "CFG|0"`,
    `echo "IMG|$(docker inspect --format '{{.Image}}' ${sq(p.app.container, NAME_RE, 'app container')} 2>/dev/null)"`,
  ].join('\n') + '\n'
}

export interface Room { freeBytes: number | null; imageFreeBytes: number | null; sameFs: boolean; dbBytes: number | null; compose: boolean; configFile: boolean; imageId: string | null }
export function parseRoom(out: string): Room {
  const get = (k: string) => new RegExp(`^${k}\\|(.*)$`, 'm').exec(out)?.[1]?.trim() ?? ''
  const free = get('DF'), ifree = get('DFIMG'), size = get('DBSIZE'), img = get('IMG')
  return {
    freeBytes: /^\d+$/.test(free) ? Number(free) * 1024 : null, imageFreeBytes: /^\d+$/.test(ifree) ? Number(ifree) * 1024 : null, sameFs: get('SAMEFS') === '1',
    dbBytes: /^\d+$/.test(size) ? Number(size) : null, compose: get('COMPOSE') === '1', configFile: get('CFG') === '1', imageId: IMAGE_ID_RE.test(img) ? img : null,
  }
}

/** A pull or a build of the Nextcloud image, with its layers unpacked: a fixed margin, generous on purpose. */
export const IMAGE_MARGIN = 3 * 1024 ** 3
const DUMP_MARGIN = 200 * 1024 ** 2
const mib = (b: number) => Math.round(b / 1048576)

/** Free space for the dump (the database's size plus 200 MiB) and for the new image (3 GiB), on their filesystems. */
export function roomProblem(r: Room): string | null {
  if (r.freeBytes === null) return 'HyperProx could not read the free space in the Compose directory.'
  if (r.dbBytes === null) return 'HyperProx could not read the database size, so it cannot be sure the dump fits.'
  const dump = r.dbBytes + DUMP_MARGIN
  if (r.sameFs || r.imageFreeBytes === null) {
    const need = dump + IMAGE_MARGIN
    if (r.freeBytes < need) return `The Compose directory has ${mib(r.freeBytes)} MiB free; the dump and the new image need about ${mib(need)} MiB.`
    return null
  }
  if (r.freeBytes < dump) return `The Compose directory has ${mib(r.freeBytes)} MiB free; the dump needs about ${mib(dump)} MiB.`
  if (r.imageFreeBytes < IMAGE_MARGIN) return `Docker's storage has ${mib(r.imageFreeBytes)} MiB free; the new image needs about ${mib(IMAGE_MARGIN)} MiB.`
  return null
}

/** Is `next` an acceptable target from `from`? (The job script applies the same rule in the guest.) */
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
  const occ = `docker exec -u www-data ${p.app.container} php occ`
  return [
    `To go back to Nextcloud ${p.from}:`,
    tag ? `1. Point the image back: docker tag ${tag} ${p.app.image}` : `1. Re-create the old image (it was referenced by digest, so HyperProx could not tag it).`,
    `2. Stop the app: ${compose} stop ${p.app.service}`,
    p.db.engine === 'postgres'
      ? `3. Restore the database: docker exec -i ${p.db.container} pg_restore --clean --if-exists -U ${p.db.user} -d ${p.db.name} < ${dump ?? `${p.backupDir}/nextcloud-db-${p.stamp}.dump`}`
      : `3. Restore the database: gunzip -c ${dump ?? `${p.backupDir}/nextcloud-db-${p.stamp}.sql.gz`} | docker exec -i ${p.db.container} sh -c 'MYSQL_PWD="\${MYSQL_PASSWORD:-\$MARIADB_PASSWORD}" exec mysql -u"\${MYSQL_USER:-\$MARIADB_USER}" "\${MYSQL_DATABASE:-\$MARIADB_DATABASE}"'`,
    `4. Put the old config back (it was copied before maintenance mode was turned on): docker cp ${p.backupDir}/config-${p.stamp}.php ${p.app.container}:/var/www/html/config/config.php, then docker exec ${p.app.container} chown www-data:www-data /var/www/html/config/config.php`,
    `5. Start it: ${compose} up -d --no-deps ${p.app.service}`,
    `6. Turn maintenance mode off: ${occ} maintenance:mode --off`,
    'Files in the data directory are not touched by an upgrade, so they need no restore.',
  ].join('\n')
}

// ── the job, detached in the guest ───────────────────────────────────────────

export const JOB_ID_RE = /^j[0-9a-f]{12}$/
export const jobDirOf = (backupDir: string, jobId: string) => `${backupDir.replace(/\/+$/, '')}/jobs/${jobId}`

/**
 * The update as one bash script, every name in it checked and quoted. It appends to `state`:
 *   PID|<pid>   STEP|<key>|<state>|<detail>   MAINT|on|off|unknown   DUMP|<file>   RESULT|done|failed|<message>
 * and writes all its output to `log`.
 */
export function updateJobScript(p: UpdatePlan, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new UpdateRefusal('Bad job id.')
  if (!/^\d{8}T\d{6}Z$/.test(p.stamp)) throw new UpdateRefusal('Bad timestamp.')
  if (!/^\d{1,3}(\.\d{1,3}){1,3}$/.test(p.from)) throw new UpdateRefusal('Bad version.')
  const J = sq(jobDirOf(p.backupDir, jobId), PATH_RE, 'job directory')
  const BK = sq(p.backupDir, PATH_RE, 'backup directory')
  const APP = sq(p.app.container, NAME_RE, 'app container')
  const DB = sq(p.db.container, NAME_RE, 'database container')
  const IMG = sq(p.app.image, IMAGE_RE, 'image')
  const SVC = sq(p.app.service, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'service')
  const repo = imageRepo(p.app.image)
  const TAG = repo && IMAGE_ID_RE.test(p.app.imageId) ? sq(`${repo}:hyperprox-pre-${safeTag(p.from)}`, IMAGE_RE, 'tag') : "''"
  const IMGID = IMAGE_ID_RE.test(p.app.imageId) ? `'${p.app.imageId}'` : "''"
  const dumpFile = p.db.engine === 'postgres' ? `${p.backupDir}/nextcloud-db-${p.stamp}.dump` : `${p.backupDir}/nextcloud-db-${p.stamp}.sql.gz`
  const dump = p.db.engine === 'postgres'
    ? [
        `docker exec ${DB} pg_dump -U ${sq(p.db.user, DB_IDENT_RE, 'database user')} -d ${sq(p.db.name, DB_IDENT_RE, 'database name')} -Fc > "$F.part" \\`,
        `  && mv "$F.part" "$F" && chmod 600 "$F" \\`,
        // Read back: pg_restore must be able to list every object in it.
        `  && docker exec -i ${DB} pg_restore --list < "$F" > /dev/null \\`,
        '  || fail backup "The database dump, or reading it back, failed, so nothing else was changed."',
      ]
    : [
        // The password comes from the database container's own environment, in MYSQL_PWD, never on a command line.
        `docker exec ${DB} sh -c '${MYSQL_ENV}; D=$(command -v mariadb-dump || command -v mysqldump); exec "$D" --single-transaction --routines -u${MYSQL_USER} ${MYSQL_DB}' | gzip > "$F.part" \\`,
        `  && [ "\${PIPESTATUS[0]}" = 0 ] && mv "$F.part" "$F" && chmod 600 "$F" && gzip -t "$F" \\`,
        '  || fail backup "The database dump, or reading it back, failed, so nothing else was changed."',
      ]
  return [
    '#!/bin/bash',
    '# Written by HyperProx: a Nextcloud update, run detached. Progress in ./state, output in ./log.',
    'set -u',
    `J=${J}; S="$J/state"; L="$J/log"`,
    'exec >>"$L" 2>&1 </dev/null',
    `BK=${BK}; APP=${APP}; IMG=${IMG}; SVC=${SVC}; TAG=${TAG}; IMGID=${IMGID}`,
    `FROM='${p.from}'; STAMP='${p.stamp}'; F='${dumpFile}'; C="$BK/config-$STAMP.php"`,
    `compose() { ${composeCmd({ workdir: p.app.workdir, configFile: p.app.configFile, project: p.app.project })} "$@"; }`,
    'occ() { docker exec -u www-data "$APP" php occ "$@"; }',
    'MAINT=off; RECREATED=0; CUR=start; NEXT=""',
    `step() { printf 'STEP|%s|%s|%s\\n' "$1" "$2" "$(printf %s "\${3:-}" | tr '|\\n' '  ' | cut -c1-300)" >> "$S"; }`,
    'setmaint() { MAINT="$1"; echo "MAINT|$1" >> "$S"; }',
    `finish() { printf 'RESULT|%s|%s\\n' "$1" "$(printf %s "$2" | tr '|\\n' '  ')" >> "$S"; exit 0; }`,
    '# Every failure says whether maintenance mode is on. Before the container was recreated nothing else changed,',
    '# so maintenance mode is turned off again; after, Nextcloud itself is asked.',
    'fail() {',
    '  step "$1" failed "$2"',
    '  if [ "$RECREATED" = 0 ] && [ "$MAINT" = on ]; then occ maintenance:mode --no-interaction --off && setmaint off; fi',
    '  if [ "$RECREATED" = 1 ]; then',
    '    st="$(occ status --no-interaction --output=json 2>/dev/null)"',
    '    case "$st" in *\'"maintenance":true\'*) setmaint on;; *\'"maintenance":false\'*) setmaint off;; *) setmaint unknown;; esac',
    '  fi',
    '  case "$MAINT" in',
    '    on) finish failed "$2 Maintenance mode is still ON: Nextcloud shows its maintenance page until it is turned off (occ maintenance:mode --off), after a fix or a rollback.";;',
    '    off) finish failed "$2 Maintenance mode is off.";;',
    '    *) finish failed "$2 Whether maintenance mode is on could not be read (occ status did not answer).";;',
    '  esac',
    '}',
    'trap \'fail "$CUR" "The update was stopped."\' TERM INT HUP',
    'echo "PID|$$" >> "$S"',
    '',
    'CUR=config; step config running',
    'docker exec "$APP" cat /var/www/html/config/config.php > "$C.part" && mv "$C.part" "$C" && chmod 600 "$C" \\',
    '  || fail config "config.php could not be copied, so nothing was changed."',
    'step config done "$C"',
    '',
    'CUR=maintenance; step maintenance running',
    'occ maintenance:mode --no-interaction --on || fail maintenance "Maintenance mode could not be turned on, so nothing was changed."',
    'setmaint on; step maintenance done',
    '',
    'CUR=backup; step backup running "$BK"',
    ...dump,
    'if [ ! -s "$F" ]; then fail backup "The database dump did not complete, so nothing else was changed."; fi',
    'echo "DUMP|$F" >> "$S"; step backup done "$F ($(du -h "$F" | cut -f1))"',
    '',
    'CUR=keep; step keep running',
    'if [ -n "$TAG" ] && [ -n "$IMGID" ] && docker image tag "$IMGID" "$TAG"; then step keep done "$TAG"; else step keep skipped "the current image could not be tagged"; fi',
    '',
    `CUR=image; step image running '${p.source === 'build' ? 'compose build --pull' : 'compose pull'}'`,
    p.source === 'build'
      ? 'compose build --pull "$SVC" || fail image "The new image could not be built; the running container was not touched."'
      : 'compose pull "$SVC" || fail image "The new image could not be pulled; the running container was not touched."',
    `NEXT="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMG" | sed -n 's/^NEXTCLOUD_VERSION=//p' | head -1)"`,
    'printf %s "$NEXT" | grep -Eq \'^[0-9]{1,3}(\\.[0-9]{1,3}){1,3}$\' || fail image "The new image does not say which Nextcloud it holds (no NEXTCLOUD_VERSION); the running container was not touched."',
    '[ "$NEXT" = "$FROM" ] && fail image "The new image is still Nextcloud $FROM: there is nothing newer under this tag yet; the running container was not touched."',
    '[ "$(printf \'%s\\n%s\\n\' "$FROM" "$NEXT" | sort -V | tail -1)" = "$FROM" ] && fail image "The new image holds Nextcloud $NEXT, older than $FROM; the running container was not touched."',
    '[ "${NEXT%%.*}" -gt $(( ${FROM%%.*} + 1 )) ] && fail image "The new image holds Nextcloud $NEXT, more than one major version ahead of $FROM; the running container was not touched."',
    'echo "NEXT|$NEXT" >> "$S"; step image done "Nextcloud $NEXT"',
    '',
    'CUR=recreate; step recreate running; RECREATED=1',
    'compose up -d --no-deps "$SVC" || fail recreate "The container could not be recreated. See the rollback steps."',
    'step recreate done',
    '',
    '# The image upgrades Nextcloud when it starts. occ upgrade is run once, by HyperProx, only after 10 minutes and',
    '# only when the entrypoint is not upgrading (no occ upgrade process, its nextcloud-init-sync.lock not held).',
    'CUR=upgrade; step upgrade running "waiting for $NEXT"',
    'start=$(date +%s); ran=0; moff=0',
    'while :; do',
    '  # The deadline first: nothing below (a continue included) can skip it.',
    '  now=$(date +%s)',
    '  [ $((now - start)) -gt 2400 ] && fail upgrade "Nextcloud did not report $NEXT within 40 minutes. Check docker logs $APP."',
    '  sleep 10',
    '  st="$(occ status --no-interaction --output=json 2>/dev/null)"',
    '  v="$(printf %s "$st" | sed -n \'s/.*"versionstring":"\\([0-9.]*\\)".*/\\1/p\')"',
    '  case "$st" in *\'"needsDbUpgrade":true\'*) nu=1;; *) nu=0;; esac',
    '  case "$st" in *\'"maintenance":true\'*) m=1;; *) m=0;; esac',
    '  if [ -n "$st" ] && [ "$v" = "$NEXT" ] && [ "$nu" = 0 ]; then',
    '    if [ "$m" = 1 ]; then',
    '      moff=$((moff + 1))',
    '      [ "$moff" -gt 5 ] && fail upgrade "Nextcloud reports $NEXT, but maintenance mode could not be turned off (5 tries)."',
    '      occ maintenance:mode --no-interaction --off; continue',
    '    fi',
    '    setmaint off; break',
    '  fi',
    '  if [ -n "$st" ] && [ "$nu" = 1 ] && [ "$ran" = 0 ] && [ $((now - start)) -gt 600 ]; then',
    // The entrypoint holds a flock on nextcloud-init-sync.lock while it installs or upgrades (the file itself stays):
    // a lock that cannot be taken now means it is still at work.
    '    if docker top "$APP" -eo pid,args 2>/dev/null | grep -q "occ upgrade" \\',
    '      || ! docker exec "$APP" sh -c \'L=/var/www/html/nextcloud-init-sync.lock; command -v flock >/dev/null || exit 0; [ -e "$L" ] || exit 0; flock -n "$L" true\'; then',
    '      echo "The image is still upgrading; waiting."',
    '    else',
    '      ran=1; echo "Running occ upgrade"',
    '      occ upgrade --no-interaction || fail upgrade "occ upgrade failed. See the rollback steps."',
    '    fi',
    '  fi',
    'done',
    'step upgrade done "Nextcloud $NEXT, maintenance mode off"',
    '',
    'CUR=post; step post running; w=0',
    'for c in db:add-missing-indices db:add-missing-columns db:add-missing-primary-keys; do occ "$c" --no-interaction || w=$((w + 1)); done',
    'if [ "$w" = 0 ]; then step post done; else step post done "$w of the post-upgrade commands failed; run them by hand"; fi',
    'finish done "Nextcloud is on $NEXT. The database dump is at $F."',
    '',
  ].join('\n')
}

/** Writes the job script into its directory and starts it detached: systemd-run when the guest has systemd, else setsid. */
export function launchScript(p: UpdatePlan, jobId: string): string {
  const body = updateJobScript(p, jobId)
  const d = `HPX_RUN_EOF_${jobId}`
  if (body.includes(d)) throw new UpdateRefusal('Bad job script.')
  const J = sq(jobDirOf(p.backupDir, jobId), PATH_RE, 'job directory')
  return [
    'set -e',
    `install -d -m 700 ${sq(p.backupDir, PATH_RE, 'backup directory')} ${sq(`${p.backupDir}/jobs`, PATH_RE, 'job directory')} ${J}`,
    `cat > ${J}/run.sh <<'${d}'`, body, d,
    `chmod 700 ${J}/run.sh; : > ${J}/state; : > ${J}/log; chmod 600 ${J}/state ${J}/log`,
    'if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1 \\',
    `  && systemd-run --quiet --collect --unit='hyperprox-nc-${jobId}' /bin/bash ${J}/run.sh; then echo "LAUNCH|systemd" >> ${J}/state; echo "LAUNCHED|systemd"; exit 0; fi`,
    `echo "LAUNCH|setsid" >> ${J}/state`,
    `nohup setsid /bin/bash ${J}/run.sh >/dev/null 2>&1 </dev/null &`,
    'echo "LAUNCHED|setsid"',
    '',
  ].join('\n')
}

/**
 * Read-only: the job's state file, the end of its log, and whether the job still runs. The markers carry this poll's
 * own nonce, and ALIVE/EXISTS come after the end of the log, so nothing the job printed can pose as either. A job
 * started by systemd is alive while its unit is active; one started with setsid while a process with that PID runs
 * this job's own run.sh (a reused PID running something else does not count).
 */
export function pollScript(backupDir: string, jobId: string, nonce: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new UpdateRefusal('Bad job id.')
  if (!/^[a-z0-9]{12,32}$/.test(nonce)) throw new UpdateRefusal('Bad marker.')
  const dir = jobDirOf(backupDir, jobId)
  const J = sq(dir, PATH_RE, 'job directory')
  return [
    'set +e',
    `cat ${J}/state 2>/dev/null`,
    `echo "@@HPX-${nonce}-LOG@@"`,
    `tail -n 40 ${J}/log 2>/dev/null | cut -c1-400`,
    `echo "@@HPX-${nonce}-LOG-END@@"`,
    `via="$(sed -n 's/^LAUNCH|//p' ${J}/state 2>/dev/null | tail -1)"`,
    'alive=0',
    'if [ "$via" = systemd ]; then',
    `  systemctl is-active --quiet 'hyperprox-nc-${jobId}' 2>/dev/null && alive=1`,
    'else',
    `  pid="$(sed -n 's/^PID|\\([0-9][0-9]*\\)$/\\1/p' ${J}/state 2>/dev/null | tail -1)"`,
    `  if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- '${dir}/run.sh'; then alive=1; fi`,
    'fi',
    `echo "ALIVE-${nonce}|$alive"`,
    `[ -e ${J}/state ] && echo "EXISTS-${nonce}|1" || echo "EXISTS-${nonce}|0"`,
    '',
  ].join('\n')
}

export interface PolledJob {
  exists: boolean
  started: boolean
  alive: boolean
  steps: Record<string, { state: JobStep['state']; detail: string }>
  maint: 'on' | 'off' | 'unknown' | null
  dump: string | null
  /** The Nextcloud version the new image holds, once the job read it. */
  next: string | null
  result: { state: 'done' | 'failed'; message: string } | null
  lines: string[]
}

const STEP_STATES = ['pending', 'running', 'done', 'failed', 'skipped']

export function parsePoll(out: string, nonce: string): PolledJob {
  const r: PolledJob = { exists: false, started: false, alive: false, steps: {}, maint: null, dump: null, next: null, result: null, lines: [] }
  const begin = out.indexOf(`@@HPX-${nonce}-LOG@@`)
  const end = out.lastIndexOf(`@@HPX-${nonce}-LOG-END@@`)
  if (begin < 0 || end < begin) return r
  const state = out.slice(0, begin)
  const after = out.slice(end + `@@HPX-${nonce}-LOG-END@@`.length)
  r.alive = new RegExp(`^ALIVE-${nonce}\\|1$`, 'm').test(after)
  r.exists = new RegExp(`^EXISTS-${nonce}\\|1$`, 'm').test(after)
  for (const line of state.split('\n')) {
    const f = line.split('|')
    if (f[0] === 'PID' && /^\d+$/.test(f[1] ?? '')) r.started = true
    else if (f[0] === 'STEP' && /^[a-z]{1,20}$/.test(f[1] ?? '') && STEP_STATES.includes(f[2])) r.steps[f[1]] = { state: f[2] as JobStep['state'], detail: (f.slice(3).join(' ')).slice(0, 300) }
    else if (f[0] === 'MAINT' && ['on', 'off', 'unknown'].includes(f[1])) r.maint = f[1] as PolledJob['maint']
    else if (f[0] === 'DUMP' && PATH_RE.test(f[1] ?? '')) r.dump = f[1]
    else if (f[0] === 'NEXT' && /^\d{1,3}(\.\d{1,3}){1,3}$/.test(f[1] ?? '')) r.next = f[1]
    else if (f[0] === 'RESULT' && (f[1] === 'done' || f[1] === 'failed')) r.result = { state: f[1], message: f.slice(2).join(' ').slice(0, 800) }
  }
  r.lines = out.slice(begin + `@@HPX-${nonce}-LOG@@`.length, end).split('\n').filter(l => l.trim()).slice(-40)
  return r
}

// ── the Talk signalling update (short: it runs from HyperProx) ───────────────

export interface RunIO {
  /** A script in the guest, as root. */
  run(script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  step(key: string, state: JobStep['state'], detail?: string): void
  log(line: string): void
  sleep(ms: number): Promise<void>
  now(): number
}

const tail = (s: string, n = 600) => s.trim().slice(-n)

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
