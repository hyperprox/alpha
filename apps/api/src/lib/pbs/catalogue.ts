// =============================================================================
//  HyperProx — Proxmox Backup Server from the catalogue
//
//  The recipe's own parts: the wizard's choices (where the backups live), the
//  install script that runs inside the new container, the preview's checks of
//  that location, and the setup that runs after the install and does the
//  chores, one reported and read-back step at a time:
//
//    pbs-cert       read the certificate the server reports from inside the
//                   container (over the node's own pinned SSH login), compare it
//                   with what :8007 presents, and pin it
//    pbs-health     sign in as root@pam with the generated password (kept in the
//                   vault before the install ran): :8007 answers, and the
//                   datastore's status is readable
//    pbs-backup-token  a user and API token for Proxmox VE, DatastoreBackup on
//                   that datastore only, into the vault
//    pbs-readonly-token  a user and API token for HyperProx, Audit on /, into
//                   the vault
//    pbs-connect    the PBS plug-in gets the server, with the pin, and reads it
//                   through the read-only token
//    pbs-storage    only when the person ticked it (off by default): the server
//                   as PBS storage on the chosen cluster, with its fingerprint
//
//  A backup server on the same cluster it backs up is not an off-site copy: lose
//  the cluster and the backups go with it. The wizard says so, and recommends a
//  NAS (lib/pbs/nfs.ts) as the place the backups live.
// =============================================================================

import type { RecipeOption } from '../catalogue'
import { normaliseFingerprint } from '../clusters/tls-pin'
import { DATASTORE_BASE, DATASTORE_RE, NfsInputError, SMB_REFUSAL, UID_NOTE, cleanNfsSource, judgeProbe, parseProbe, probeScript } from './nfs'
import type { PbsApi } from './client'
import type { PbsPin } from './transport'
import type { PbsReading } from './parse'

export const RECIPE_ID = 'proxmox-backup-server'

/** The Proxmox archive key for Debian 13 (trixie), as Proxmox publishes it; the install refuses any other file. */
export const PROXMOX_KEY_URL = 'https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg'
export const PROXMOX_KEY_SHA256 = '136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45'

export const NOT_OFFSITE =
  'A backup server on the same cluster it backs up is not an off-site copy: if the cluster is lost, its backups go with it. ' +
  'Keep the datastore on a NAS or another machine (recommended), and add a sync to a second place for anything you cannot lose.'

export const PBS_OPTIONS: RecipeOption[] = [
  { key: 'PBS_LOCATION', label: 'Where the backups live', kind: 'text', required: true, default: 'nas', maxLength: 4,
    hint: '"nas" (recommended: survives losing the cluster) or "disk" (a disk on this cluster).' },
  { key: 'PBS_NFS_HOST', label: 'NAS address', kind: 'text', maxLength: 253, placeholder: '10.0.0.20', hint: 'Its IP address or name. NFS only, never SMB.' },
  { key: 'PBS_NFS_EXPORT', label: 'NFS export', kind: 'text', maxLength: 255, placeholder: '/Backups' },
  { key: 'PBS_DATASTORE', label: 'Datastore name', kind: 'text', required: true, default: 'backups', maxLength: 32 },
  { key: 'PBS_SIZE_GB', label: 'Space for backups (GB)', kind: 'number', required: true, default: '200', min: 8, max: 65536,
    hint: 'On a disk: the size of the disk made for it. On a NAS: the free space the export must have.' },
  { key: 'PBS_REATTACH', label: 'Re-attach the existing datastore', kind: 'boolean', default: '0',
    hint: 'Only when the export already holds a PBS datastore: use it as it is. It is never wiped.' },
  { key: 'PBS_ADD_STORAGE', label: 'Add it as backup storage on this cluster', kind: 'boolean', default: '0',
    hint: 'Off by default. On: Proxmox VE gets a "pbs" storage pointing at this server (with its certificate fingerprint), so backup jobs can choose it. It stores the backup token on the cluster.' },
]

/** The recipe-specific checks on top of each option's kind. */
export function checkPbsOptions(v: Record<string, string>): string[] {
  const errors: string[] = []
  if (v.PBS_LOCATION !== 'nas' && v.PBS_LOCATION !== 'disk') errors.push('Choose where the backups live: on a NAS or on a disk on this cluster.')
  if (v.PBS_DATASTORE && !DATASTORE_RE.test(v.PBS_DATASTORE)) errors.push('The datastore name is 2 to 32 letters, digits, dashes or underscores, starting with a letter or digit.')
  if (v.PBS_LOCATION === 'nas') {
    try { cleanNfsSource(v.PBS_NFS_HOST, v.PBS_NFS_EXPORT) } catch (e) { errors.push(e instanceof NfsInputError ? e.message : 'The NAS export is not valid.') }
  } else if (v.PBS_LOCATION === 'disk' && v.PBS_REATTACH === '1') {
    errors.push('A new disk is always empty: re-attaching only applies to a NAS export that already holds a datastore.')
  }
  return errors
}

export { SMB_REFUSAL, UID_NOTE }

/**
 * The install script, run inside the new Debian 13 container (values arrive as exported, checked environment
 * variables). The Proxmox key is fetched over https and checked against its published SHA-256 before apt trusts
 * it; nothing is piped into a shell. The datastore is created on the mountpoint the container was given, after a
 * test write as the `backup` user; an existing datastore is only re-attached (reuse-datastore), never re-created.
 */
export const PBS_SCRIPT = String.raw`. /etc/os-release
[ "$VERSION_CODENAME" = trixie ] || { echo "This recipe needs Debian 13 (trixie); the container is $VERSION_CODENAME."; exit 1; }
# The package adds Proxmox's enterprise repository, which answers 401 without a subscription and would break every
# later apt update in this container (an update, a re-run of this recipe). It is switched off, not deleted: before
# the first update (a re-run) and again right after the install.
pbs_no_enterprise() { F=/etc/apt/sources.list.d/pbs-enterprise.sources; if [ -f "$F" ] && ! grep -q '^Enabled:' "$F"; then printf 'Enabled: no\n' >> "$F"; fi; }
pbs_no_enterprise
apt-get update -qq
apt-get install -y -qq ca-certificates curl
curl -fsSL --proto '=https' -o /tmp/proxmox-archive-keyring.gpg "$PBS_KEY_URL"
echo "$PBS_KEY_SHA256  /tmp/proxmox-archive-keyring.gpg" | sha256sum -c --quiet - || { echo "The Proxmox archive key does not match its published checksum; refusing to trust it."; exit 1; }
install -m 0644 /tmp/proxmox-archive-keyring.gpg /usr/share/keyrings/proxmox-archive-keyring.gpg
rm -f /tmp/proxmox-archive-keyring.gpg
cat > /etc/apt/sources.list.d/proxmox-backup.sources <<'SOURCES'
Types: deb
URIs: http://download.proxmox.com/debian/pbs
Suites: trixie
Components: pbs-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
SOURCES
apt-get update -qq
apt-get install -y -qq proxmox-backup-server
pbs_no_enterprise
apt-get update -qq
# The generated root password (in the vault already): the web interface's root@pam login.
printf 'root:%s\n' "$PBS_ROOT_PASSWORD" | chpasswd
DS="$PBS_DATASTORE_BASE/$PBS_DATASTORE"
mountpoint -q "$DS" || { echo "The datastore location $DS is not mounted in the container."; exit 1; }
# PBS writes as "backup" (uid 34; on the host and the NAS that is uid 100034). A new disk's folder belongs to root,
# so it is handed to backup first (the folder only, never what is in it; a NAS may refuse, and the test decides).
chown backup:backup "$DS" 2>/dev/null || true
chmod 0755 "$DS" 2>/dev/null || true
# Prove it can write, before anything is made.
if ! su -s /bin/sh backup -c "touch '$DS/.hyperprox-write-test' && rm -f '$DS/.hyperprox-write-test'"; then
  echo "The backup user cannot write to $DS. $PBS_UID_NOTE"
  exit 1
fi
if [ -d "$DS/.chunks" ]; then
  [ "$PBS_REATTACH" = 1 ] || { echo "$DS already holds a PBS datastore and re-attaching was not chosen; nothing was changed."; exit 1; }
  proxmox-backup-manager datastore create "$PBS_DATASTORE" "$DS" --reuse-datastore true
  echo "Re-attached the existing datastore $PBS_DATASTORE; nothing in it was changed."
else
  if [ -n "$(ls -A "$DS" | grep -v '^lost+found$' | head -1)" ]; then echo "$DS has other files in it; a new datastore needs it empty."; exit 1; fi
  proxmox-backup-manager datastore create "$PBS_DATASTORE" "$DS"
fi
# Defaults, all editable later in the PBS web interface: GC weekly, verify weekly, prune daily.
proxmox-backup-manager datastore update "$PBS_DATASTORE" --gc-schedule 'sat 06:00'
proxmox-backup-manager prune-job list --output-format json | grep -q '"hyperprox-prune"' || \
  proxmox-backup-manager prune-job create hyperprox-prune --store "$PBS_DATASTORE" --schedule daily --keep-last 3 --keep-daily 7 --keep-weekly 4 --keep-monthly 6
proxmox-backup-manager verify-job list --output-format json | grep -q '"hyperprox-verify"' || \
  proxmox-backup-manager verify-job create hyperprox-verify --store "$PBS_DATASTORE" --schedule 'sun 08:00' --ignore-verified true --outdated-after 30
systemctl is-active --quiet proxmox-backup-proxy || systemctl restart proxmox-backup-proxy
# A public fact, read inside the container: setup compares it with what :8007 presents, then pins it.
FP=$(proxmox-backup-manager cert info | sed -n 's/^Fingerprint (sha256): *//p' | head -1)
echo "@@pbs fingerprint $FP"
echo "Proxmox Backup Server is installed, with datastore $PBS_DATASTORE at $DS."`

/** The fixed values the script reads, next to the person's options. */
export function scriptEnv(): Record<string, string> {
  return { PBS_KEY_URL: PROXMOX_KEY_URL, PBS_KEY_SHA256: PROXMOX_KEY_SHA256, PBS_DATASTORE_BASE: DATASTORE_BASE, PBS_UID_NOTE: UID_NOTE }
}

/** The fingerprint the install printed, from the end of its output. */
export function fingerprintFromLog(log: string): string | null {
  const all = [...String(log ?? '').matchAll(/@@pbs fingerprint ([0-9A-Fa-f:]{64,95})/g)]
  return all.length ? normaliseFingerprint(all[all.length - 1][1]) : null
}

// ── the preview ──────────────────────────────────────────────────────────────

export interface PreviewDeps {
  /** Run a script on the chosen node (read-only probe). */
  runOnNode(node: string, script: string, timeoutMs: number): Promise<{ code: number; output: string }>
}

/** The checks a preview adds: the export is reachable, has room, and is or is not a datastore already. */
export async function pbsPreviewChecks(node: string, v: Record<string, string>, d: PreviewDeps): Promise<{ errors: string[]; warnings: string[]; checks: string[] }> {
  const warnings: string[] = []
  if (v.PBS_LOCATION === 'disk') {
    return { errors: [], checks: [`A ${v.PBS_SIZE_GB} GB disk on the container's storage, mounted at ${DATASTORE_BASE}/${v.PBS_DATASTORE}.`], warnings: [NOT_OFFSITE] }
  }
  const src = cleanNfsSource(v.PBS_NFS_HOST, v.PBS_NFS_EXPORT)
  let out: { code: number; output: string }
  try { out = await d.runOnNode(node, probeScript(src), 60_000) }
  catch (e: any) { return { errors: [`HyperProx could not look at ${src.source} from ${node}: ${String(e?.message ?? 'no answer').slice(0, 160)}`], warnings, checks: [] } }
  const verdict = judgeProbe(parseProbe(out.output), src, { minFreeGb: Number(v.PBS_SIZE_GB) || 0, reattach: v.PBS_REATTACH === '1' })
  return {
    errors: verdict.errors,
    warnings: verdict.warnings,
    checks: [...verdict.checks,
      'The backups live on the NAS, so they outlast the cluster: a new backup server can re-attach the same export.',
      `Mounted on ${node} only, at /mnt/hyperprox-pbs/<id>, with fstab options rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail (nofail: a NAS that is off does not hang the node's boot), and passed to the container at ${DATASTORE_BASE}/${v.PBS_DATASTORE}. Removing the container's mountpoint and that fstab line undoes it.`,
      UID_NOTE],
  }
}

// ── the setup after the install ──────────────────────────────────────────────

export const PBS_SETUP_STEPS: Array<{ id: string; label: string }> = [
  { id: 'pbs-cert', label: 'Pin the server\'s certificate' },
  { id: 'pbs-health', label: 'Check :8007 answers and the datastore is readable' },
  { id: 'pbs-backup-token', label: 'Make the backup token for Proxmox VE' },
  { id: 'pbs-readonly-token', label: 'Make HyperProx\'s read-only token' },
  { id: 'pbs-connect', label: 'Connect the PBS plug-in' },
  { id: 'pbs-storage', label: 'Add it as storage on the cluster' },
]

export const BACKUP_USER = 'pve-backup@pbs'
export const BACKUP_TOKEN = 'pve'
export const READONLY_USER = 'hyperprox@pbs'
export const READONLY_TOKEN = 'readonly'

export interface SetupStep { id: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }

export interface SetupDeps {
  /** What :8007 presents now. */
  probe(url: string): Promise<{ fingerprint: string; caVerified: boolean }>
  /** A signed-in session as `user`. */
  login(url: string, pin: PbsPin, user: string, password: string): Promise<PbsApi>
  /** A token's API. */
  tokenApi(url: string, pin: PbsPin, tokenId: string, secret: string): PbsApi
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
  /** Store the server as a PBS plug-in instance (already proved here) and return its id. */
  connect(v: { name: string; url: string; tokenId: string; secret: string; staleHours: number; pin: PbsPin }): Promise<string>
  /** Read it through the plug-in, as its page will. */
  reading(instanceId: string): Promise<PbsReading>
  /** The chosen cluster's storage API. */
  pveStorage: { list(): Promise<any[]>; add(body: Record<string, string>): Promise<void> }
  now(): Date
}

export interface SetupContext {
  ip: string
  vmid: number
  hostname: string
  datastore: string
  rootPassword: string
  /** The install's output, which ends with the fingerprint the server reported from inside. */
  installLog: string
  addStorage: boolean
  /** The vault item the generated root password is in: the tokens go there too. */
  vault: { category: string; provider: string }
}

/**
 * Run the setup steps in order. Each one is marked running, then done with what was read back, or failed with
 * the reason (and the rest are not run). Secrets go into the vault only: never into a detail, a log or an error.
 */
export async function runPbsSetup(ctx: SetupContext, step: (id: string) => SetupStep, d: SetupDeps): Promise<{ url: string; instanceId: string; fingerprint: string }> {
  const url = `https://${ctx.ip}:8007`
  const ds = ctx.datastore
  const enc = encodeURIComponent

  // 1. The certificate: the one the server reports inside the container must be the one :8007 presents.
  const s1 = step('pbs-cert')
  const inside = fingerprintFromLog(ctx.installLog)
  if (!inside) throw new Error('The install did not report the server\'s certificate fingerprint, so there is nothing safe to pin.')
  const presented = await d.probe(url)
  if (presented.fingerprint !== inside) throw new Error(`:8007 presented ${presented.fingerprint}, not the ${inside} the server reported from inside the container. Nothing was sent to it.`)
  const pin: PbsPin = { fingerprint: inside, source: 'first-use', at: d.now().toISOString() }
  s1.status = 'done'; s1.detail = `Pinned ${inside}`

  // 2. Health: it answers on :8007 (a sign-in works), and the datastore's status is readable.
  const s2 = step('pbs-health')
  const root = await d.login(url, pin, 'root@pam', ctx.rootPassword)
  const st = await root.call('GET', `/admin/datastore/${enc(ds)}/status`)
  if (typeof st?.total !== 'number') throw new Error(`The datastore ${ds} does not answer with its status.`)
  s2.status = 'done'; s2.detail = `:8007 answers; ${ds} has ${Math.floor((st.avail ?? 0) / 1024 ** 3)} GB free of ${Math.floor(st.total / 1024 ** 3)} GB`

  const acl = async () => (await root.call('GET', '/access/acl')) as any[]
  const hasAcl = (rows: any[], path: string, role: string, who: string) => (rows ?? []).some(r => r?.path === path && r?.roleid === role && r?.ugid === who)
  const makeToken = async (user: string, token: string, comment: string): Promise<{ tokenId: string; secret: string }> => {
    const users = (await root.call('GET', '/access/users')) as any[]
    if (!(users ?? []).some(u => u?.userid === user)) await root.call('POST', '/access/users', { userid: user, comment })
    const made = await root.call('POST', `/access/users/${enc(user)}/token/${enc(token)}`, { comment })
    if (typeof made?.value !== 'string' || typeof made?.tokenid !== 'string') throw new Error(`The server did not return a secret for ${user}!${token}.`)
    return { tokenId: made.tokenid, secret: made.value }
  }

  // 3. Proxmox VE's backup token: DatastoreBackup on this datastore only (for the user and its token both:
  //    a token's privileges are the intersection of its own and its user's).
  const s3 = step('pbs-backup-token')
  const bk = await makeToken(BACKUP_USER, BACKUP_TOKEN, 'Proxmox VE backups (made by HyperProx)')
  for (const who of [BACKUP_USER, bk.tokenId]) await root.call('PUT', '/access/acl', { path: `/datastore/${ds}`, role: 'DatastoreBackup', 'auth-id': who })
  await d.saveSecrets(ctx.vault.category, ctx.vault.provider, { pve_token_id: bk.tokenId, pve_token_secret: bk.secret })
  const a3 = await acl()
  if (!hasAcl(a3, `/datastore/${ds}`, 'DatastoreBackup', bk.tokenId) || !hasAcl(a3, `/datastore/${ds}`, 'DatastoreBackup', BACKUP_USER)) throw new Error('The backup token\'s permission did not read back.')
  s3.status = 'done'; s3.detail = `${bk.tokenId}: DatastoreBackup on /datastore/${ds}; secret in the vault`

  // 4. HyperProx's read-only token: Audit on / (Datastore.Audit, Sys.Audit). It can change nothing.
  const s4 = step('pbs-readonly-token')
  const ro = await makeToken(READONLY_USER, READONLY_TOKEN, 'HyperProx read-only (made by HyperProx)')
  for (const who of [READONLY_USER, ro.tokenId]) await root.call('PUT', '/access/acl', { path: '/', role: 'Audit', 'auth-id': who })
  await d.saveSecrets(ctx.vault.category, ctx.vault.provider, { readonly_token_id: ro.tokenId, readonly_token_secret: ro.secret })
  const a4 = await acl()
  if (!hasAcl(a4, '/', 'Audit', ro.tokenId)) throw new Error('The read-only token\'s permission did not read back.')
  const check = await d.tokenApi(url, pin, ro.tokenId, ro.secret).call('GET', `/admin/datastore/${enc(ds)}/status`)
  if (typeof check?.total !== 'number') throw new Error('The read-only token cannot read the datastore.')
  s4.status = 'done'; s4.detail = `${ro.tokenId}: Audit on /; reads ${ds}; secret in the vault`

  // 5. The plug-in: the server, the read-only token and the pin, then a real reading through it.
  const s5 = step('pbs-connect')
  const id = await d.connect({ name: ctx.hostname.slice(0, 40), url, tokenId: ro.tokenId, secret: ro.secret, staleHours: 26, pin })
  const r = await d.reading(id)
  if (!r.datastores.some(x => x.store === ds)) throw new Error(`The plug-in connected but does not see ${ds}.`)
  s5.status = 'done'; s5.detail = `Connected as ${ctx.hostname}; it reads ${r.datastores.length} datastore${r.datastores.length === 1 ? '' : 's'}`

  // 6. Optional: Proxmox VE storage.
  const s6 = step('pbs-storage')
  if (!ctx.addStorage) {
    s6.status = 'skipped'; s6.detail = 'Not chosen. Add it later in Proxmox (Datacenter → Storage → Add → Proxmox Backup Server) with the backup token in the vault.'
  } else {
    const have = new Set((await d.pveStorage.list()).map((x: any) => String(x?.storage)))
    const sid = [`pbs-${ds}`, `pbs-${ctx.vmid}`].map(x => x.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)).find(x => !have.has(x))
    if (!sid) throw new Error('A storage called pbs-<datastore> and pbs-<id> both exist already; add it by hand.')
    await d.pveStorage.add({ storage: sid, type: 'pbs', server: ctx.ip, port: '8007', datastore: ds, username: bk.tokenId, password: bk.secret, fingerprint: inside, content: 'backup' })
    const back = (await d.pveStorage.list()).find((x: any) => x?.storage === sid)
    if (!back || back.type !== 'pbs' || back.datastore !== ds || normaliseFingerprint(String(back.fingerprint ?? '')) !== inside) throw new Error(`The storage ${sid} did not read back as added.`)
    s6.status = 'done'; s6.detail = `${sid} on the cluster, pinned to the same fingerprint`
  }
  return { url, instanceId: id, fingerprint: inside }
}
