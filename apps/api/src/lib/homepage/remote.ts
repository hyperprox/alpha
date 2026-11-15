// =============================================================================
//  HyperProx — Homepage: the scripts that run on the Homepage guest
//
//  Each goes through the remote executor (lib/remote/executor.ts): the node
//  login, then `pct exec <id> -- bash -s` for a container or the guest agent for
//  a VM, the script itself on stdin. Nothing is staged in a file first.
//
//  Nothing the guest sends back and nothing a person typed is put into a script
//  as shell text. A directory or container name is checked against a strict
//  pattern and then single-quoted; file contents travel base64-encoded (an
//  alphabet with no shell meaning) and are decoded on the guest. Every answer is
//  read line by line from fixed HPX_ markers, so stray output cannot be taken
//  for one.
// =============================================================================

import { createHash } from 'node:crypto'

/** A path on the guest we will name in a script: absolute, plain characters, no `..`. */
export const SAFE_PATH = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+\/?$/
export const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
export const CONFIG_FILES = ['services.yaml', 'widgets.yaml', 'settings.yaml'] as const
/** Homepage's own key file beside its compose file: only HOMEPAGE_VAR_ values, never the stack's shared .env. */
export const KEY_FILE = 'homepage.env'
export type ConfigFile = typeof CONFIG_FILES[number] | typeof KEY_FILE | 'docker-compose.yml' | 'compose.yaml' | 'docker-compose.yaml' | 'compose.yml'
const WRITABLE = new Set<string>(['services.yaml', 'widgets.yaml', KEY_FILE, 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml', 'compose.yml'])
export const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class UnsafeValueError extends Error {
  constructor(what: string) { super(`Refused: ${what} is not a plain value HyperProx can name safely on the guest.`); this.name = 'UnsafeValueError' }
}

export function safePath(p: string): string {
  if (typeof p !== 'string' || !SAFE_PATH.test(p) || p.split('/').some(s => s === '..' || s === '.') || p.length > 240) throw new UnsafeValueError(`the path ${JSON.stringify(String(p).slice(0, 60))}`)
  return p.replace(/\/$/, '') || '/'
}
export function safeContainer(c: string): string {
  if (typeof c !== 'string' || !SAFE_CONTAINER.test(c)) throw new UnsafeValueError('the container name')
  return c
}
/** Single-quoted for bash; only ever applied to a value that already passed safePath or safeContainer. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// ── find Homepage ────────────────────────────────────────────────────────────

/** Every Homepage container on the guest: its name, state, the folder mounted at /app/config, its compose folder. */
export function locateScript(): string {
  return `set -u
export LC_ALL=C
if ! command -v docker >/dev/null 2>&1; then echo 'HPX_ERR no_docker'; exit 0; fi
docker ps -a --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
  img=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null) || continue
  case "$img" in *gethomepage/homepage*|*benphelps/homepage*) ;; *) continue ;; esac
  echo "HPX_CONTAINER $c"
  echo "HPX_STATE $c $(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)"
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/config"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null | sed -n '1s/^/HPX_CONFIG '"$c"' /p'
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null | sed -n '1s/^/HPX_COMPOSE '"$c"' /p'
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c" 2>/dev/null | sed -n '1s/^/HPX_COMPOSE_FILES '"$c"' /p'
  docker port "$c" 3000/tcp 2>/dev/null | sed -n '1s/^.*:\\([0-9]*\\)$/HPX_PORT '"$c"' \\1/p'
done
echo HPX_DONE
`
}

export interface Located {
  container: string
  state: string
  configDir: string | null
  composeDir: string | null
  composeFile: string | null
  port: number | null
}

/** The locate script's answer. Only values that pass the same checks a later script applies are kept. */
export function parseLocate(out: string): { ok: boolean; error?: 'no_docker' | 'no_answer'; found: Located[] } {
  if (/^HPX_ERR no_docker$/m.test(out)) return { ok: false, error: 'no_docker', found: [] }
  if (!/^HPX_DONE$/m.test(out)) return { ok: false, error: 'no_answer', found: [] }
  const byName = new Map<string, Located>()
  const get = (c: string) => byName.get(c)
  for (const line of out.split('\n')) {
    const m = /^HPX_(CONTAINER|STATE|CONFIG|COMPOSE|COMPOSE_FILES|PORT) (\S+)(?: (.*))?$/.exec(line.trim())
    if (!m || !SAFE_CONTAINER.test(m[2])) continue
    const [, kind, c, rest = ''] = m
    if (kind === 'CONTAINER') { byName.set(c, { container: c, state: 'unknown', configDir: null, composeDir: null, composeFile: null, port: null }); continue }
    const l = get(c)
    if (!l) continue
    const okPath = (p: string) => { try { return safePath(p.trim()) } catch { return null } }
    if (kind === 'STATE') l.state = /^[a-z]{1,20}$/.test(rest.trim()) ? rest.trim() : 'unknown'
    if (kind === 'CONFIG') l.configDir = okPath(rest)
    if (kind === 'COMPOSE') l.composeDir = okPath(rest)
    if (kind === 'COMPOSE_FILES') l.composeFile = okPath(rest.split(',')[0] ?? '')
    if (kind === 'PORT') { const n = Number(rest.trim()); l.port = Number.isInteger(n) && n > 0 && n < 65536 ? n : null }
  }
  return { ok: true, found: [...byName.values()] }
}

// ── read ─────────────────────────────────────────────────────────────────────

export interface ReadFile { name: string; exists: boolean; text: string; sha: string | null; owner: string | null; mode: string | null }

/** Read these files from one folder (base64 out), and say whether the folder takes a new file. */
export function readScript(dir: string, files: readonly string[]): string {
  const d = safePath(dir)
  for (const f of files) if (!/^[A-Za-z0-9._-]{1,64}$/.test(f)) throw new UnsafeValueError('a file name')
  return `set -u
export LC_ALL=C
d=${sq(d)}
if [ ! -d "$d" ]; then echo 'HPX_NODIR'; echo HPX_DONE; exit 0; fi
for f in ${files.map(sq).join(' ')}; do
  p="$d/$f"
  if [ -f "$p" ] && [ ! -L "$p" ]; then echo "HPX_FILE $f $(stat -c '%u:%g' "$p") $(stat -c '%a' "$p") $(base64 -w0 < "$p")"; else echo "HPX_MISSING $f"; fi
done
if t=$(mktemp "$d/.hyperprox-write-test.XXXXXX" 2>/dev/null); then rm -f -- "$t"; echo 'HPX_WRITABLE yes'; else echo 'HPX_WRITABLE no'; fi
echo HPX_DONE
`
}

export function parseRead(out: string): { ok: boolean; dirMissing: boolean; writable: boolean; files: Record<string, ReadFile> } {
  const files: Record<string, ReadFile> = {}
  if (!/^HPX_DONE$/m.test(out)) return { ok: false, dirMissing: false, writable: false, files }
  if (/^HPX_NODIR$/m.test(out)) return { ok: true, dirMissing: true, writable: false, files }
  for (const line of out.split('\n')) {
    const m = /^HPX_FILE ([A-Za-z0-9._-]+) (\d+:\d+) ([0-7]{3,4}) ?([A-Za-z0-9+/=]*)$/.exec(line.trim())
    if (m) {
      const text = Buffer.from(m[4], 'base64').toString('utf8')
      files[m[1]] = { name: m[1], exists: true, text, sha: sha256(text), owner: m[2], mode: m[3] }
      continue
    }
    const x = /^HPX_MISSING ([A-Za-z0-9._-]+)$/.exec(line.trim())
    if (x) files[x[1]] = { name: x[1], exists: false, text: '', sha: null, owner: null, mode: null }
  }
  return { ok: true, dirMissing: false, writable: /^HPX_WRITABLE yes$/m.test(out), files }
}

// ── write ────────────────────────────────────────────────────────────────────

export interface WriteRequest {
  dir: string
  file: string
  content: string
  /** sha256 of the file as the preview read it (null: it did not exist). The write is refused if it changed since. */
  expectSha: string | null
  /** File mode for a new file; an existing file keeps its own owner and mode. */
  mode: '0644' | '0600'
  /** A timestamp for the backup's name: YYYYMMDD-HHMMSS. */
  stamp: string
}

/**
 * One file, written whole: the current one copied to `<file>.bak-hyperprox-<stamp>` first, the new content into a
 * temporary file beside it with the old file's owner and mode, then moved over it. Refused when the file changed
 * since the preview read it. The newest 20 backups are kept.
 */
export function writeScript(r: WriteRequest): string {
  const d = safePath(r.dir)
  if (!WRITABLE.has(r.file)) throw new UnsafeValueError('that file')
  if (!/^\d{8}-\d{6}$/.test(r.stamp)) throw new UnsafeValueError('the backup stamp')
  if (r.expectSha !== null && !/^[0-9a-f]{64}$/.test(r.expectSha)) throw new UnsafeValueError('the expected hash')
  const want = sha256(r.content)
  const secret = r.mode === '0600'
  // A key file is never readable by anyone else, not even for a moment: the temporary file is made under umask 077,
  // and so is its backup. Nothing follows a symbolic link: not the folder, the file, its backup or the temporary file
  // (mktemp makes a new one, never an existing name).
  return `set -u
export LC_ALL=C
umask ${secret ? '077' : '022'}
d=${sq(d)}
f=${sq(r.file)}
p="$d/$f"
expect=${sq(r.expectSha ?? 'none')}
[ -d "$d" ] || { echo 'HPX_ERR no_dir'; exit 0; }
[ -L "$d" ] && { echo 'HPX_ERR is_link'; exit 0; }
[ -L "$p" ] && { echo 'HPX_ERR is_link'; exit 0; }
if [ -e "$p" ] && [ ! -f "$p" ]; then echo 'HPX_ERR is_link'; exit 0; fi
if [ -f "$p" ]; then now=$(sha256sum < "$p" | cut -d' ' -f1); else now=none; fi
[ "$now" = "$expect" ] || { echo "HPX_ERR changed $now"; exit 0; }
tmp=$(mktemp "$d/.$f.hyperprox.XXXXXX") || { echo 'HPX_ERR move'; exit 0; }
base64 -d > "$tmp" <<'HPX_CONTENT_END' || { rm -f -- "$tmp"; echo 'HPX_ERR decode'; exit 0; }
${b64(r.content).replace(/(.{76})/g, '$1\n')}
HPX_CONTENT_END
got=$(sha256sum < "$tmp" | cut -d' ' -f1)
[ "$got" = ${sq(want)} ] || { rm -f -- "$tmp"; echo 'HPX_ERR corrupt'; exit 0; }
if [ -f "$p" ]; then
  bak="$p.bak-hyperprox-"${sq(r.stamp)}
  n=1
  while [ -e "$bak" ] || [ -L "$bak" ]; do
    [ "$n" -gt 9 ] && { rm -f -- "$tmp"; echo 'HPX_ERR backup'; exit 0; }
    bak="$p.bak-hyperprox-"${sq(r.stamp)}"-$n"; n=$((n+1))
  done
  cp -P -p -n -- "$p" "$bak" || { rm -f -- "$tmp"; echo 'HPX_ERR backup'; exit 0; }
  if [ -L "$bak" ] || [ ! -f "$bak" ] || [ "$(sha256sum < "$bak" | cut -d' ' -f1)" != "$now" ]; then rm -f -- "$tmp"; echo 'HPX_ERR backup'; exit 0; fi
  echo "HPX_BACKUP $bak"
  chown --reference="$p" -- "$tmp" 2>/dev/null; chmod --reference="$p" -- "$tmp" 2>/dev/null
else
  chown --reference="$d" -- "$tmp" 2>/dev/null
fi
chmod ${r.mode} -- "$tmp"${secret ? '' : ' 2>/dev/null; [ -f "$p" ] && chmod --reference="$p" -- "$tmp" 2>/dev/null'}
mv -f -T -- "$tmp" "$p" || { rm -f -- "$tmp"; echo 'HPX_ERR move'; exit 0; }
ls -1t -- "$p".bak-hyperprox-* 2>/dev/null | tail -n +21 | while IFS= read -r old; do rm -f -- "$old"; done
echo "HPX_WROTE $(sha256sum < "$p" | cut -d' ' -f1)"
`
}

/** How many dated backups of a file there are (a key file's hold old keys). */
export function backupsScript(dir: string, file: string): string {
  const d = safePath(dir)
  if (!WRITABLE.has(file)) throw new UnsafeValueError('that file')
  return `set -u
export LC_ALL=C
d=${sq(d)}
n=0
for b in "$d"/${sq(file)}.bak-hyperprox-*; do [ -e "$b" ] || [ -L "$b" ] || continue; n=$((n+1)); done
echo "HPX_BACKUPS $n"
`
}

/** Delete those backups (the links themselves, never what a link points at). */
export function purgeBackupsScript(dir: string, file: string): string {
  const d = safePath(dir)
  if (!WRITABLE.has(file)) throw new UnsafeValueError('that file')
  return `set -u
export LC_ALL=C
d=${sq(d)}
n=0
for b in "$d"/${sq(file)}.bak-hyperprox-*; do [ -e "$b" ] || [ -L "$b" ] || continue; rm -f -- "$b" && n=$((n+1)); done
echo "HPX_PURGED $n"
`
}

export type WriteOutcome =
  | { ok: true; sha: string; backup: string | null }
  | { ok: false; code: 'changed' | 'no_dir' | 'is_link' | 'decode' | 'corrupt' | 'backup' | 'move' | 'no_answer'; message: string }

const WRITE_WORDS: Record<string, string> = {
  changed: 'The file changed on the guest since the preview read it (someone edited it). Preview again to see the change.',
  no_dir: 'The config folder is not there any more.',
  is_link: 'The file is a symbolic link; HyperProx does not write through links.',
  decode: 'The new content could not be decoded on the guest.',
  corrupt: 'The new content arrived damaged; nothing was changed.',
  backup: 'The backup copy could not be made, so nothing was changed.',
  move: 'The new file could not be put in place; the old one is untouched.',
  no_answer: 'The guest did not answer the write.',
}

export function parseWrite(out: string, content: string): WriteOutcome {
  const err = /^HPX_ERR (\w+)/m.exec(out)
  if (err) return { ok: false, code: (err[1] in WRITE_WORDS ? err[1] : 'no_answer') as any, message: WRITE_WORDS[err[1]] ?? WRITE_WORDS.no_answer }
  const w = /^HPX_WROTE ([0-9a-f]{64})$/m.exec(out)
  if (!w) return { ok: false, code: 'no_answer', message: WRITE_WORDS.no_answer }
  if (w[1] !== sha256(content)) return { ok: false, code: 'corrupt', message: WRITE_WORDS.corrupt }
  const b = /^HPX_BACKUP (\S+)$/m.exec(out)
  return { ok: true, sha: w[1], backup: b ? b[1] : null }
}

// ── verify ───────────────────────────────────────────────────────────────────

/** Homepage's own list of services, as its page loads it: from inside the container, else the published port. */
export function verifyScript(container: string, port: number | null): string {
  const c = safeContainer(container)
  const p = port && Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000
  return `set -u
export LC_ALL=C
c=${sq(c)}
out=$(docker exec "$c" wget -qO- -T 10 http://127.0.0.1:3000/api/services 2>/dev/null) || out=''
if [ -z "$out" ] && command -v curl >/dev/null 2>&1; then out=$(curl -fsS -m 10 http://127.0.0.1:${p}/api/services 2>/dev/null) || out=''; fi
if [ -z "$out" ]; then echo 'HPX_VERIFY none'; else echo "HPX_VERIFY $(printf '%s' "$out" | base64 -w0)"; fi
`
}

export interface VerifyResult { ok: boolean; reached: boolean; groups: Array<{ name: string; services: string[] }>; missing: string[]; error?: string }

/** Did Homepage load what was written? Every expected "group / service" must appear in its answer. */
export function parseVerify(out: string, expect: Array<{ group: string; name: string }>): VerifyResult {
  const m = /^HPX_VERIFY (\S+)$/m.exec(out)
  if (!m || m[1] === 'none') return { ok: false, reached: false, groups: [], missing: expect.map(e => `${e.group} / ${e.name}`), error: 'Homepage did not answer on /api/services.' }
  let j: any
  try { j = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) } catch { return { ok: false, reached: true, groups: [], missing: [], error: 'Homepage answered with something that is not its service list.' } }
  if (!Array.isArray(j)) return { ok: false, reached: true, groups: [], missing: [], error: typeof j?.error === 'string' ? `Homepage said: ${j.error.slice(0, 160)}` : 'Homepage answered with something that is not its service list.' }
  const groups: VerifyResult['groups'] = []
  const walk = (g: any) => {
    if (!g || typeof g.name !== 'string') return
    groups.push({ name: g.name, services: (Array.isArray(g.services) ? g.services : []).map((s: any) => String(s?.name ?? '')) })
    for (const sub of Array.isArray(g.groups) ? g.groups : []) walk(sub)
  }
  for (const g of j) walk(g)
  const missing = expect.filter(e => !groups.some(g => g.name === e.group && g.services.includes(e.name))).map(e => `${e.group} / ${e.name}`)
  return { ok: missing.length === 0, reached: true, groups, missing }
}

// ── compose ──────────────────────────────────────────────────────────────────

/**
 * Recreate the Homepage service, and only it, so a changed key file reaches it (compose recreates it only when its
 * config changed). The output goes to a fresh mktemp file, never a name someone could have placed in /tmp.
 */
export function composeUpScript(composeDir: string, composeFile: string | null, service: string): string {
  const d = safePath(composeDir)
  const f = composeFile ? safePath(composeFile) : null
  if (!SAFE_SERVICE.test(service)) throw new UnsafeValueError('the compose service name')
  return `set -u
export LC_ALL=C
cd ${sq(d)} || { echo 'HPX_ERR no_dir'; exit 0; }
log=$(mktemp) || { echo 'HPX_UP failed'; exit 0; }
if docker compose ${f ? `-f ${sq(f)} ` : ''}up -d ${sq(service)} >"$log" 2>&1; then echo 'HPX_UP ok'; else echo 'HPX_UP failed'; tail -n 5 "$log" | sed 's/^/HPX_LOG /'; fi
rm -f -- "$log"
`
}

/** A timestamp for backup names, in UTC. */
export function stampOf(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}
