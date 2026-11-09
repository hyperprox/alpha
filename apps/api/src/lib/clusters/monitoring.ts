// =============================================================================
//  HyperProx — monitoring on a remote server (Add a server, step 5)
//
//  Scan first (read-only), then plain yes/no questions, then a preview of every step, then apply, then read
//  back. "Remove monitoring" undoes what HyperProx did and nothing else.
//
//  What it installs: node_exporter from the server's own Debian packages (CPU, memory, disks, network, and
//  the AMD GPU through its drm and hwmon collectors), listening ONLY on the private-link address HyperProx
//  reaches the node on: the address must be on a Tailscale or WireGuard interface, or nothing is installed.
//  Then HyperProx's Prometheus is pointed at it, with labels that keep the remote's series apart from home's.
//
//  Before anything else, an explicit check: HyperProx itself must reach that address. If it cannot, the
//  answer says how to fix it (put this HyperProx machine on the same tailnet, or give it a route); nothing is
//  ever left half done because of a network surprise.
//
//  Never touched, on any cluster: corosync, pve-cluster, /etc/pve. Every script is checked for that before
//  it is sent (assertSafeScript).
// =============================================================================

import os from 'node:os'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hardware } from '../hardware'
import { execOnNode, nodeCredential } from '../node-exec'
import { clusterRow, setMonitoring } from './registry'
import type { NodeMonitoring } from './store'
import { runInCluster, currentRemote } from './context'
import { remoteNodeLabel } from './overview'
import { targetsDir, redrawGpuRows } from '../targets'
import { prometheusBase } from '../service-health'
import { auditCredentialUse } from '../audit'

export { assertSafeScript, assertAptInstallOnly } from './script-guard'
import { assertSafeScript, assertAptInstallOnly } from './script-guard'

const COMMON = () => fs.readFileSync(path.join(hardware.NODE_DIR, 'common.sh'), 'utf8')

/** Read-only facts about one node. */
export const SCAN_SCRIPT = `
set -u
LISTEN="$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $3}')"
echo "listen=$LISTEN"
IFACE="$(ip -o addr show 2>/dev/null | awk -v a="$LISTEN" '{split($4,p,"/"); if (p[1]==a) {print $2; exit}}')"
echo "iface=$IFACE"
if dpkg-query -W -f='\${Status}' prometheus-node-exporter 2>/dev/null | grep -q 'install ok installed'; then echo "package=installed"; else echo "package=absent"; fi
if systemctl is-active --quiet prometheus-node-exporter 2>/dev/null; then echo "service=active"; else echo "service=inactive"; fi
echo "listening=$(ss -ltnH 2>/dev/null | awk '$4 ~ /:9100$/ {print $4}' | paste -sd, -)"
if grep -qi 0x1002 /sys/class/drm/card*/device/vendor 2>/dev/null; then echo "amd=yes"; else echo "amd=no"; fi
if [ -f /etc/default/prometheus-node-exporter ] && grep -q 'HyperProx' /etc/default/prometheus-node-exporter || [ -f /etc/hyperprox/node-exporter-prior ]; then echo "ours=yes"; else echo "ours=no"; fi
if [ -f /etc/hyperprox/node-exporter-installed ]; then echo "installed_by_us=yes"; else echo "installed_by_us=no"; fi
if grep -qi 0x8086 /sys/class/drm/card*/device/vendor 2>/dev/null; then echo "intel=yes"; else echo "intel=no"; fi
echo "intel_driver=$(for c in /sys/class/drm/card[0-9]*; do [ "$(cat "$c/device/vendor" 2>/dev/null)" = 0x8086 ] && basename "$(readlink -f "$c/device/driver")"; done 2>/dev/null | sort -u | paste -sd, -)"
if command -v python3 >/dev/null 2>&1; then echo "python3=yes"; else echo "python3=no"; fi
if command -v intel_gpu_top >/dev/null 2>&1; then echo "intel_gpu_top=yes"; else echo "intel_gpu_top=no"; fi
if [ -f /etc/systemd/system/hyperprox-intel-gpu-textfile.service ] || [ -f /etc/hyperprox/intel-gpu-prior ]; then echo "intel_ours=yes"; else echo "intel_ours=no"; fi
`

export interface NodeFacts {
  node: string
  address: string | null
  login: boolean
  reachable: boolean
  listen: string | null
  iface: string | null
  privateLink: boolean
  packageInstalled: boolean
  serviceActive: boolean
  listening: string[]
  amd: boolean
  ours: boolean
  installedByUs: boolean
  /** An Intel GPU is there; its kernel driver (i915, xe); python3 and intel_gpu_top present; HyperProx's Intel collector is installed. */
  intel: boolean
  intelDriver: string | null
  python3: boolean
  intelGpuTop: boolean
  intelOurs: boolean
  problem?: string
}

export function parseScan(node: string, address: string | null, text: string): NodeFacts {
  const kv = Object.fromEntries(String(text ?? '').split('\n').map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const iface = kv.iface || null
  return {
    node, address, login: true, reachable: true,
    listen: kv.listen && net.isIP(kv.listen) ? kv.listen : null,
    iface, privateLink: !!iface && /^(tailscale\d*|wg[\w-]*|ts\d+)$/.test(iface),
    packageInstalled: kv.package === 'installed', serviceActive: kv.service === 'active',
    listening: (kv.listening ?? '').split(',').filter(Boolean), amd: kv.amd === 'yes', ours: kv.ours === 'yes', installedByUs: kv.installed_by_us === 'yes',
    intel: kv.intel === 'yes', intelDriver: /^[\w,-]{1,64}$/.test(kv.intel_driver ?? '') ? kv.intel_driver : null,
    python3: kv.python3 === 'yes', intelGpuTop: kv.intel_gpu_top === 'yes', intelOurs: kv.intel_ours === 'yes',
  }
}

/** This HyperProx machine's own private-link interfaces (for the plain explanation when a server is unreachable). */
export function localPrivateLinks(): string[] {
  return Object.keys(os.networkInterfaces()).filter(n => /^(tailscale\d*|wg[\w-]*|ts\d+)$/.test(n))
}

export function tcpReachable(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

export interface MonitoringDeps {
  nodes(): Promise<string[]>
  run(host: string, script: string): Promise<{ code: number; output: string }>
  hasLogin(node: string): Promise<boolean>
  reachable(host: string, port: number): Promise<boolean>
  metrics(listen: string): Promise<string | null>
  writeTargets(clusterId: string, entries: Array<{ node: string; listen: string }>): unknown
  reload(): Promise<void>
  up(clusterId: string): Promise<Record<string, number>>
  sleep(ms: number): Promise<void>
  /** Redraw the Grafana board's GPU rows (an AMD row appears once a remote reports AMD figures). */
  dashboard?(): void
}

const hostPort = (h: string, p: number) => (h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`)

export function productionMonitoringDeps(): MonitoringDeps {
  return {
    async nodes() { const { pveFromEnv } = await import('../pve-env'); return ((await pveFromEnv().fetchStrict<any[]>('/nodes')) ?? []).filter(n => n.status === 'online').map(n => String(n.node)) },
    async run(host, script) {
      assertSafeScript(script)
      assertAptInstallOnly(script)
      // nodeCredential follows the cluster context: this cluster's login, never a home one.
      const node = Object.entries(currentRow().nodeAddresses).find(([, a]) => a === host)?.[0]
      const cred = node ? await nodeCredential(node) : null
      if (!cred) throw new Error('No saved login for that node.')
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, requirePin: true, timeoutMs: 10 * 60_000 })
      return { code: r.code, output: r.output }
    },
    async hasLogin(node) { return !!(await nodeCredential(node).catch(() => null)) },
    reachable: (h, p) => tcpReachable(h, p),
    async metrics(listen) {
      try { const r = await fetch(`http://${hostPort(listen, 9100)}/metrics`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.text() : null } catch { return null }
    },
    writeTargets: (id, entries) => writeRemoteTargets(id, entries),
    async reload() { try { await fetch(`${prometheusBase()}/-/reload`, { method: 'POST' }) } catch { /* not running */ } },
    async up(id) {
      try {
        const r = await fetch(`${prometheusBase()}/api/v1/query?query=${encodeURIComponent(`up{job="node",hpx_cluster="${id}"}`)}`, { signal: AbortSignal.timeout(4000) })
        const j: any = await r.json()
        return Object.fromEntries((j?.data?.result ?? []).map((x: any) => [x.metric?.hpx_node ?? '', Number(x.value?.[1])]))
      } catch { return {} }
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    dashboard: () => { redrawGpuRows() },
  }
}

function currentRow() {
  const r = currentRemote()
  if (!r) throw new Error('Monitoring installs run for a remote cluster only.')
  return r
}

// ── Prometheus targets ───────────────────────────────────────────────────────

const NODES_FILE = 'nodes.json'

/** Replace this cluster's entries in nodes.json; every other entry (home's included) is kept exactly. */
export function writeRemoteTargets(clusterId: string, entries: Array<{ node: string; listen: string }>, dir = targetsDir()): boolean {
  const p = path.join(dir, NODES_FILE)
  let list: any[] = []
  try { list = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [] } catch { list = [] }
  const all = Array.isArray(list) ? list : []
  const kept = all.filter(t => t?.labels?.hpx_cluster !== clusterId)
  // Nothing of this cluster's there and nothing to add: leave the file alone.
  if (kept.length === all.length && !entries.length) return false
  const mine = entries.map(e => ({ targets: [hostPort(e.listen, 9100)], labels: { node: remoteNodeLabel(clusterId, e.node), hpx_cluster: clusterId, hpx_node: e.node } }))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${p}.tmp`, JSON.stringify([...kept, ...mine], null, 2))
  fs.renameSync(`${p}.tmp`, p)
  return true
}

// ── Scripts ──────────────────────────────────────────────────────────────────

/**
 * Install (or re-point) node_exporter to listen on the private-link address only. The defaults file is written
 * BEFORE the package is installed, and apt keeps it (--force-confold), so the service never starts listening on
 * every interface, not even for a moment.
 *
 * The state before HyperProx (package installed? service enabled? running?) is recorded once, in
 * /etc/hyperprox/node-exporter-prior, so Remove puts exactly that back. Any failure after the defaults file is
 * written rolls back at once: the file is restored and the service is put back to its recorded state.
 * Every /etc path is under $R (HPX_SYSROOT, empty on a real node) so the scripts can be tested in a folder.
 */
export function installScript(opts: { amdGpu: boolean; intelGpu?: boolean }): string {
  // The Intel collector writes into node_exporter's textfile folder; the flag names it outright rather than
  // relying on the package's built-in default.
  const args = ['--web.listen-address=${LISTEN_HP}', ...(opts.amdGpu ? ['--collector.drm'] : []), ...(opts.intelGpu ? [`--collector.textfile.directory=${TEXTFILE_DIR}`] : [])].join(' ')
  return `${COMMON()}
${STATE_FNS}
LISTEN="$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $3}')"
[ -n "$LISTEN" ] || hp_result failed "could not tell which address HyperProx reached this node on"
IFACE="$(ip -o addr show 2>/dev/null | awk -v a="$LISTEN" '{split($4,p,"/"); if (p[1]==a) {print $2; exit}}')"
case "$IFACE" in tailscale*|wg*|ts[0-9]*) ;; *) hp_result failed "$LISTEN is on \${IFACE:-no interface}, not a Tailscale or WireGuard link, so nothing was installed (metrics are only ever offered on a private link)";; esac
case "$LISTEN" in *:*) LISTEN_HP="[$LISTEN]:9100";; *) LISTEN_HP="$LISTEN:9100";; esac
mkdir -p "$HPXD"
record_prior
if [ -f "$DEF" ] && ! grep -q HyperProx "$DEF" && [ ! -f "$DEF.hyperprox-orig" ]; then cp -p "$DEF" "$DEF.hyperprox-orig"; fi
state="$(hp_write_file "$DEF" 0644 "# Written by HyperProx: node_exporter listens on the private link only ($IFACE), not the home network.
# Remove monitoring in HyperProx to undo this.
ARGS=\\"${args}\\"")" || hp_result failed "could not write $DEF"
# From here on, a failure puts things back as they were before this run.
fail() { restore_prior; hp_result failed "$1 (rolled back: node_exporter is as it was before)"; }
if ! hp_installed prometheus-node-exporter; then
  why="$(hp_safe_apt_install prometheus-node-exporter)" || fail "$why"
  touch "$HPXD/node-exporter-installed"
fi
systemctl enable prometheus-node-exporter >/dev/null 2>&1
systemctl restart prometheus-node-exporter >/dev/null 2>&1 || fail "the service would not start (journalctl -u prometheus-node-exporter)"
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 3 "http://$LISTEN_HP/metrics" 2>/dev/null | grep -q '^node_exporter_build_info' && { ok=1; break; }; sleep 1; done
[ -n "$ok" ] || fail "nothing answers on $LISTEN_HP"
wide="$(ss -ltnH 2>/dev/null | awk '$4 ~ /:9100$/ {print $4}' | grep -v -F "$LISTEN" || true)"
[ -z "$wide" ] || fail "something also listens on $wide; stop whatever else serves port 9100 and try again"
${opts.amdGpu ? `curl -fsS --max-time 3 "http://$LISTEN_HP/metrics" | grep -q '^node_drm_gpu_busy_percent' || fail "no AMD GPU figures appeared (is the amdgpu driver loaded?)"` : ''}
[ "$state" = same ] && hp_result already "already listening on $LISTEN_HP only"
hp_result done "listening on $LISTEN_HP only${opts.amdGpu ? ', with AMD GPU figures' : ''}"
`
}

/** Shell shared by install and remove: where things are, the recorded state before HyperProx, and restoring it. */
const STATE_FNS = String.raw`HPXD="$R/etc/hyperprox"
DEF="$R/etc/default/prometheus-node-exporter"
PRIOR="$HPXD/node-exporter-prior"
yesno() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
record_prior() {
  [ -f "$PRIOR" ] && return 0
  printf 'installed=%s\nenabled=%s\nactive=%s\n' "$(yesno hp_installed prometheus-node-exporter)" \
    "$(yesno systemctl is-enabled --quiet prometheus-node-exporter)" "$(yesno systemctl is-active --quiet prometheus-node-exporter)" > "$PRIOR"
}
prior() { sed -n "s/^$1=//p" "$PRIOR" 2>/dev/null; }
restore_defaults() {
  if [ -f "$DEF" ] && grep -q HyperProx "$DEF"; then
    if [ -f "$DEF.hyperprox-orig" ]; then mv -f "$DEF.hyperprox-orig" "$DEF"; else rm -f "$DEF"; fi
  fi
}
# Put the defaults file and the service back exactly as recorded. A package HyperProx added is left disabled and
# stopped here; Remove takes it away.
restore_prior() {
  restore_defaults
  hp_installed prometheus-node-exporter || return 0
  if [ "$(prior installed)" != yes ] || [ "$(prior enabled)" != yes ]; then systemctl disable prometheus-node-exporter >/dev/null 2>&1 || true; else systemctl enable prometheus-node-exporter >/dev/null 2>&1 || true; fi
  if [ "$(prior installed)" = yes ] && [ "$(prior active)" = yes ]; then systemctl restart prometheus-node-exporter >/dev/null 2>&1 || true; else systemctl stop prometheus-node-exporter >/dev/null 2>&1 || true; fi
}`

/** Undo: the defaults file and the service back to the recorded state; the package removed only if HyperProx added it. */
export function removeScript(): string {
  return `${COMMON()}
${STATE_FNS}
[ -f "$PRIOR" ] || [ -f "$HPXD/node-exporter-installed" ] || { grep -q HyperProx "$DEF" 2>/dev/null || hp_result already "nothing of HyperProx's was here"; }
if [ -f "$HPXD/node-exporter-installed" ]; then
  systemctl disable --now prometheus-node-exporter >/dev/null 2>&1 || true
  restore_defaults
  apt-get -q -y remove prometheus-node-exporter >/dev/null 2>&1 || hp_result failed "could not remove the prometheus-node-exporter package"
  rm -f "$HPXD/node-exporter-installed" "$PRIOR"; rmdir "$HPXD" 2>/dev/null || true
  hp_result done "removed node_exporter (HyperProx had installed it)"
fi
restore_prior
rm -f "$PRIOR"; rmdir "$HPXD" 2>/dev/null || true
hp_result done "node_exporter is back to how it was before HyperProx"
`
}

// ── Intel GPU: a collector in node_exporter's textfile folder ───────────────
//
// node_exporter has no Intel GPU collector. intel_gpu_top (package intel-gpu-tools) reads the GPU's busy
// engines, frequency and power from the kernel's perf counters, which need root. So a small root service runs
// it for every Intel GPU and writes the figures into node_exporter's textfile folder; node_exporter serves them
// on the private-link address it already listens on. No new port, no change to kernel.perf_event_paranoid.
//
// Packages: intel-gpu-tools only, with any brand-new libraries it needs. apt is asked first (a simulation); if
// it would upgrade or remove anything, or install a kernel, header, firmware, NVIDIA or Proxmox package, nothing
// is installed. No `apt-get update`, no upgrade of any kind. What was added is recorded, and Remove takes away
// exactly that (and only if removing it would take nothing else with it).

/** Debian's node_exporter textfile folder (its built-in default, and the one HyperProx passes explicitly). */
export const TEXTFILE_DIR = '/var/lib/prometheus/node-exporter'
export const INTEL_UNIT = 'hyperprox-intel-gpu-textfile'
const COLLECTOR = () => fs.readFileSync(path.join(hardware.NODE_DIR, 'intel-gpu-textfile.py'), 'utf8')

const INTEL_FNS = String.raw`HPXD="$R/etc/hyperprox"
IPRIOR="$HPXD/intel-gpu-prior"
IADDED="$HPXD/intel-gpu-added"
COLLECTOR="$R/usr/local/lib/hyperprox/intel-gpu-textfile.py"
UNIT="$R/etc/systemd/system/${INTEL_UNIT}.service"
TEXTDIR="$R${TEXTFILE_DIR}"
PROM="$TEXTDIR/hyperprox_intel_gpu.prom"
yesno() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
iprior() { sed -n "s/^$1=//p" "$IPRIOR" 2>/dev/null; }
# Install intel-gpu-tools, and nothing but it and the brand-new packages it needs. Prints why not, on failure.
hp_install_only() {
  local pkg="$1" sim new bad
  [ "$pkg" = intel-gpu-tools ] || { echo "HyperProx installs only intel-gpu-tools here"; return 1; }
  hp_has apt-get || { echo "this node has no apt-get"; return 1; }
  sim="$(apt-get -s -q install --no-install-recommends "$pkg" 2>&1)" \
    || { echo "apt cannot install $pkg here (if the node's package lists are old, run apt-get update on it yourself, then try again)"; return 1; }
  if printf '%s\n' "$sim" | grep -qE '^(Inst [^ ]+ \[|Remv |Purg )'; then
    echo "installing $pkg would upgrade or remove other packages, so nothing was installed:"
    printf '%s\n' "$sim" | grep -E '^(Inst [^ ]+ \[|Remv |Purg )' | head -5 | sed 's/^/  /'
    return 1
  fi
  new="$(printf '%s\n' "$sim" | awk '$1 == "Inst" {print $2}')"
  printf '%s\n' "$new" | grep -qx "$pkg" || { echo "apt would not install $pkg itself, so nothing was installed"; return 1; }
  bad="$(printf '%s\n' "$new" | grep -E '^(linux-|pve-|proxmox-|nvidia|libnvidia|firmware-|intel-microcode|amd64-microcode|grub|libc6$|systemd$|.*-dkms$|.*headers)' | head -5 | tr '\n' ' ')"
  [ -z "$bad" ] || { echo "installing $pkg would also install $bad(HyperProx never touches those), so nothing was installed"; return 1; }
  printf '%s\n' "$new" > "$IADDED"
  apt-get -q -y install --no-install-recommends -o Dpkg::Options::=--force-confold "$pkg" >/dev/null 2>&1 \
    || { echo "apt-get install $pkg failed"; return 1; }
}
# Remove exactly the packages HyperProx added, only if apt would remove nothing else with them.
hp_remove_added() {
  [ -s "$IADDED" ] || return 0
  local list sim extra p
  list=""
  for p in $(grep -E '^[a-z0-9][a-z0-9+.-]*$' "$IADDED"); do hp_installed "$p" && list="$list $p"; done
  [ -n "$list" ] || { rm -f "$IADDED"; return 0; }
  sim="$(apt-get -s -q remove $list 2>&1)" || { echo "apt cannot remove$list"; return 1; }
  extra="$(printf '%s\n' "$sim" | awk '$1 == "Remv" {print $2}' | grep -vxF -f "$IADDED" | head -5 | tr '\n' ' ')"
  [ -z "$extra" ] || { echo "left$list installed: removing them now would also remove $extra"; return 1; }
  apt-get -q -y remove $list >/dev/null 2>&1 || { echo "apt-get remove$list failed"; return 1; }
  rm -f "$IADDED"
}
# Take away the service, the collector and its file; the packages it added; the folder if HyperProx made it.
intel_undo() {
  systemctl disable --now ${INTEL_UNIT} >/dev/null 2>&1 || true
  rm -f "$UNIT" "$COLLECTOR" "$PROM" "$PROM.tmp"
  rmdir "$R/usr/local/lib/hyperprox" 2>/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1 || true
  LEFT=""
  if [ "$(iprior tools)" != yes ]; then LEFT="$(hp_remove_added)" || true; fi
  if [ "$(iprior textdir)" = no ]; then rmdir "$TEXTDIR" 2>/dev/null || true; fi
}`

const LISTEN_FNS = String.raw`LISTEN="$(printf '%s' "${'$'}{SSH_CONNECTION:-}" | awk '{print $3}')"
[ -n "$LISTEN" ] || hp_result failed "could not tell which address HyperProx reached this node on"
IFACE="$(ip -o addr show 2>/dev/null | awk -v a="$LISTEN" '{split($4,p,"/"); if (p[1]==a) {print $2; exit}}')"
case "$IFACE" in tailscale*|wg*|ts[0-9]*) ;; *) hp_result failed "$LISTEN is on ${'$'}{IFACE:-no interface}, not a Tailscale or WireGuard link, so nothing was installed";; esac
case "$LISTEN" in *:*) LISTEN_HP="[$LISTEN]:9100";; *) LISTEN_HP="$LISTEN:9100";; esac`

/**
 * Intel GPU figures through node_exporter. Runs after installScript({ intelGpu: true }) on the same node, so
 * node_exporter already reads the textfile folder. A first one-shot sample decides: figures, and the service is
 * started; "not supported on this GPU", and nothing is left behind (result "skipped", saying so); no permission
 * or any other failure, and everything this step did is undone (result "failed").
 */
export function intelInstallScript(): string {
  return `${COMMON()}
${INTEL_FNS}
${LISTEN_FNS}
grep -qi 0x8086 "$R"/sys/class/drm/card*/device/vendor 2>/dev/null || hp_result skipped "no Intel GPU on this node"
hp_has python3 || hp_result skipped "needs python3, which this node does not have; nothing was installed"
mkdir -p "$HPXD"
[ -f "$IPRIOR" ] || printf 'tools=%s\\ntextdir=%s\\n' "$(yesno hp_installed intel-gpu-tools)" "$([ -d "$TEXTDIR" ] && echo yes || echo no)" > "$IPRIOR"
fail() { intel_undo; rm -f "$IPRIOR"; rmdir "$HPXD" 2>/dev/null || true; hp_result failed "$1 (rolled back: nothing of this step is left\${LEFT:+; $LEFT})"; }
if ! hp_installed intel-gpu-tools; then why="$(hp_install_only intel-gpu-tools)" || fail "$why"; fi
mkdir -p "$TEXTDIR"
cstate="$(hp_write_file "$COLLECTOR" 0755 "$(cat <<'HPX_PY'
${COLLECTOR().trimEnd()}
HPX_PY
)")" || fail "could not write the collector"
# One sample first, straight into the textfile folder: it says whether intel_gpu_top supports this GPU at all.
timeout 40 python3 "$COLLECTOR" --once --interval 2 --dir "$TEXTDIR" >/dev/null 2>&1
if ! grep -q '^hyperprox_intel_gpu_info{.*status="ok"' "$PROM" 2>/dev/null; then
  why="$(sed -n 's/^hyperprox_intel_gpu_info{.*status="\\([a-z_]*\\)",reason="\\([^"]*\\)".*/\\1: \\2/p' "$PROM" 2>/dev/null | head -1)"
  case "$why" in
    unsupported:*) intel_undo; rm -f "$IPRIOR"; rmdir "$HPXD" 2>/dev/null || true
      hp_result skipped "not supported on this GPU: \${why#unsupported: } (driver \$(sed -n 's/.*driver="\\([^"]*\\)".*/\\1/p' "$PROM" 2>/dev/null | head -1)\${LEFT:+; $LEFT}); nothing was left installed";;
    no_permission:*) fail "\${why#no_permission: }";;
    "") fail "intel_gpu_top gave no sample";;
    *) fail "\${why#*: }";;
  esac
fi
ustate="$(hp_write_file "$UNIT" 0644 "[Unit]
Description=HyperProx Intel GPU figures for node_exporter (intel_gpu_top, no port of its own)
After=multi-user.target

[Service]
# Root: intel_gpu_top reads the GPU's perf counters. kernel.perf_event_paranoid is left as it is.
ExecStart=/usr/bin/python3 /usr/local/lib/hyperprox/intel-gpu-textfile.py --dir ${TEXTFILE_DIR} --interval 5
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=3
Nice=10
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${TEXTFILE_DIR}
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target")" || fail "could not write $UNIT"
systemctl daemon-reload >/dev/null 2>&1
systemctl enable ${INTEL_UNIT} >/dev/null 2>&1 || fail "the service could not be enabled"
if [ "$ustate" = written ] || [ "$cstate" = written ] || ! systemctl is-active --quiet ${INTEL_UNIT}; then
  systemctl restart ${INTEL_UNIT} >/dev/null 2>&1 || fail "the service would not start (journalctl -u ${INTEL_UNIT})"
fi
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 3 "http://$LISTEN_HP/metrics" 2>/dev/null | grep -q '^hyperprox_intel_gpu_info{.*status="ok"' && { ok=1; break; }; sleep 1; done
[ -n "$ok" ] || fail "node_exporter on $LISTEN_HP does not serve the Intel figures (is it reading ${TEXTFILE_DIR}?)"
gpus="$(grep -c '^hyperprox_intel_gpu_info{.*status="ok"' "$PROM" 2>/dev/null || true)"
[ "$ustate" = same ] && [ "$cstate" = same ] && hp_result already "Intel GPU figures already measured ($gpus GPU), served by node_exporter on $LISTEN_HP"
hp_result done "Intel GPU figures measured ($gpus GPU), served by node_exporter on $LISTEN_HP; no new port"
`
}

/** Undo the Intel step: service, collector and figures gone; intel-gpu-tools removed only if HyperProx added it. */
export function intelRemoveScript(): string {
  return `${COMMON()}
${INTEL_FNS}
[ -f "$IPRIOR" ] || [ -f "$UNIT" ] || hp_result already "nothing of HyperProx's Intel GPU monitoring was here"
intel_undo
rm -f "$IPRIOR"; rmdir "$HPXD" 2>/dev/null || true
[ -z "$LEFT" ] || hp_result done "Intel GPU monitoring removed; $LEFT"
hp_result done "Intel GPU monitoring removed; the node is as it was before"
`
}

// ── Scan, questions, preview, apply ─────────────────────────────────────────

export interface Question { id: 'server-metrics' | 'amd-gpu' | 'intel-gpu' | 'proxmox-metrics'; ask: string; what: string; available: boolean; default: boolean; why?: string }

export async function scanMonitoring(clusterId: string, deps: MonitoringDeps = productionMonitoringDeps()) {
  return runInCluster(clusterId, async () => {
    const row = clusterRow(clusterId)
    if (!row || row.kind !== 'remote') throw new Error('Monitoring here is for a remote server.')
    const nodes = await deps.nodes()
    const facts: NodeFacts[] = []
    for (const node of nodes) {
      const address = row.nodeAddresses[node] ?? null
      const blank = (problem: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({ node, address, login: false, reachable: false, listen: null, iface: null, privateLink: false, packageInstalled: false, serviceActive: false, listening: [], amd: false, ours: false, installedByUs: false, intel: false, intelDriver: null, python3: false, intelGpuTop: false, intelOurs: false, problem, ...extra })
      if (!address) { facts.push(blank('No address is saved for this node (Edit server -> Nodes and logins).')); continue }
      if (!(await deps.reachable(address, 22))) {
        const links = localPrivateLinks()
        facts.push(blank(links.length
          ? `HyperProx cannot reach ${address} (port 22). This HyperProx machine is on ${links.join(', ')}; check the server is on the same tailnet or network, and that its firewall lets this machine in.`
          : `HyperProx cannot reach ${address}. This HyperProx machine is not on a Tailscale or WireGuard link: put it on the same tailnet first (VPN page: add Tailscale to the HyperProx container), or give it a route, then scan again.`))
        continue
      }
      if (!(await deps.hasLogin(node))) { facts.push(blank('No node login is saved, so HyperProx cannot look. Add one under Nodes and logins.', { reachable: true })); continue }
      try {
        const r = await deps.run(address, SCAN_SCRIPT)
        const f = parseScan(node, address, r.output)
        if (!f.listen) f.problem = 'Could not tell which address HyperProx reached the node on.'
        else if (!f.privateLink) f.problem = `HyperProx reaches this node on ${f.listen}, which is on ${f.iface ?? 'no interface'}, not a Tailscale or WireGuard link. Metrics are only offered on a private link: save the node's Tailscale or WireGuard address instead.`
        facts.push(f)
      } catch (e: any) { facts.push(blank(`The scan did not run: ${e?.message ?? e}`, { reachable: true, login: true })) }
    }
    const ready = facts.filter(f => !f.problem)
    const anyAmd = ready.some(f => f.amd)
    const intelReady = ready.filter(f => f.intel && f.python3)
    const intelWhy = !ready.some(f => f.intel) ? 'No Intel GPU was found.'
      : !intelReady.length ? 'The node with the Intel GPU has no python3, which the collector needs.' : undefined
    const questions: Question[] = [
      { id: 'server-metrics', ask: 'Watch this server\'s CPU, memory, disks and network?', what: 'Installs node_exporter from the server\'s own packages. It listens on the private-link address only, never on the home network.', available: ready.length > 0, default: true, ...(ready.length ? {} : { why: 'No node is ready (see each node\'s note).' }) },
      { id: 'amd-gpu', ask: 'Show the AMD GPU\'s load, video memory and temperature?', what: 'Turns on node_exporter\'s GPU collector. Drivers are never touched.', available: anyAmd, default: anyAmd, ...(anyAmd ? {} : { why: 'No AMD GPU was found.' }) },
      { id: 'intel-gpu', ask: 'Show the Intel GPU\'s load (3D, video, blitter and video-enhance engines), clock and power?', what: 'Adds intel-gpu-tools from the server\'s own packages (that package and any new libraries it needs; if apt would upgrade or remove anything, or touch a kernel, driver or Proxmox package, nothing is installed) and a small root service that writes the figures into node_exporter\'s textfile folder. No new port. Built-in Intel graphics share system memory, so there is no separate video memory to show.', available: intelReady.length > 0, default: intelReady.length > 0, ...(intelWhy ? { why: intelWhy } : {}) },
      { id: 'proxmox-metrics', ask: 'Proxmox figures (guests, storage, backups) in Grafana?', what: 'Coming soon. The Command center already shows them through the admin token.', available: false, default: false, why: 'Coming soon.' },
    ]
    return { nodes: facts, questions }
  })
}

interface Plan {
  id: string; clusterId: string; owner: string; kind: 'install' | 'remove'; createdAt: number; used: boolean
  steps: Array<{ node: string; address: string; words: string; script: string; amd: boolean; what: 'node-exporter' | 'intel-gpu' | 'targets' }>
}
const plans = new Map<string, Plan>()
const PLAN_MS = 10 * 60_000

export class MonitoringRefusal extends Error {}

export async function previewMonitoring(clusterId: string, owner: string, kind: 'install' | 'remove', answers: Record<string, boolean>, deps: MonitoringDeps = productionMonitoringDeps()) {
  const scan = await scanMonitoring(clusterId, deps)
  const steps: Plan['steps'] = []
  for (const f of scan.nodes) {
    if (f.problem || !f.address) continue
    if (kind === 'install') {
      if (!answers['server-metrics']) continue
      const amd = !!answers['amd-gpu'] && f.amd
      const intel = !!answers['intel-gpu'] && f.intel && f.python3
      steps.push({ node: f.node, address: f.address, amd, what: 'node-exporter', script: installScript({ amdGpu: amd, intelGpu: intel }),
        words: `${f.node}: ${f.packageInstalled ? 'use the node_exporter already installed' : 'install node_exporter (prometheus-node-exporter, from its own packages; nothing is upgraded or removed)'}, listening on ${f.listen}:9100 only (${f.iface})${amd ? ', with the AMD GPU collector on' : ''}${intel ? ', reading its textfile folder' : ''}. Then point HyperProx's Prometheus at it.` })
      if (intel) {
        steps.push({ node: f.node, address: f.address, amd: false, what: 'intel-gpu', script: intelInstallScript(),
          words: `${f.node}: Intel GPU figures: ${f.intelGpuTop ? 'use the intel_gpu_top already installed' : 'install intel-gpu-tools (only that package and new libraries it needs; refused if apt would upgrade, remove, or touch a kernel, driver or Proxmox package)'}, then a root service ${INTEL_UNIT} writes the figures to ${TEXTFILE_DIR}. One sample is taken first: if intel_gpu_top does not support this GPU${f.intelDriver ? ` (driver ${f.intelDriver})` : ''}, nothing is left installed and the panel says "not supported".` })
      }
    } else {
      if (f.intelOurs) steps.push({ node: f.node, address: f.address, amd: false, what: 'intel-gpu', script: intelRemoveScript(),
        words: `${f.node}: remove the Intel GPU collector (service, script and figures), and intel-gpu-tools if HyperProx installed it.` })
      if (f.ours || f.installedByUs) steps.push({ node: f.node, address: f.address, amd: false, what: 'node-exporter', script: removeScript(),
        words: `${f.node}: ${f.installedByUs ? 'remove node_exporter (HyperProx installed it)' : 'put node_exporter\'s settings back as they were before HyperProx'}, and stop Prometheus scraping it.` })
    }
  }
  if (kind === 'remove' && !steps.length) {
    // Nothing on the server, but Prometheus may still list it: removing the targets is the whole plan.
    steps.push({ node: '', address: '', amd: false, what: 'targets', script: '', words: 'Stop Prometheus scraping this server (nothing of HyperProx\'s is installed on it).' })
  }
  if (!steps.length) throw new MonitoringRefusal('Nothing to do: answer yes to at least one question, and make sure a node is ready.')
  for (const s of steps) if (s.script) { assertSafeScript(s.script); assertAptInstallOnly(s.script) }
  const plan: Plan = { id: randomUUID(), clusterId, owner, kind, createdAt: Date.now(), used: false, steps }
  plans.set(plan.id, plan)
  for (const [id, p] of plans) if (Date.now() - p.createdAt > PLAN_MS) plans.delete(id)
  return { planId: plan.id, kind, steps: steps.map(s => s.words), nodes: scan.nodes, expiresInMinutes: PLAN_MS / 60_000 }
}

export async function applyMonitoring(planId: string, owner: string, deps: MonitoringDeps = productionMonitoringDeps()) {
  const plan = plans.get(planId)
  if (!plan || plan.owner !== owner) throw new MonitoringRefusal('No such preview. Preview again.')
  if (plan.used) throw new MonitoringRefusal('That preview was already applied. Preview again.')
  if (Date.now() - plan.createdAt > PLAN_MS) { plans.delete(planId); throw new MonitoringRefusal('That preview is older than ten minutes. Preview again.') }
  plan.used = true
  return runInCluster(plan.clusterId, async () => {
    const row = clusterRow(plan.clusterId)!
    const results: Array<{ node: string; status: string; reason: string }> = []
    const monitoring: Record<string, NodeMonitoring> = structuredClone(row.monitoring ?? {})
    const targets: Array<{ node: string; listen: string }> = []
    const failedNodes = new Set<string>()
    for (const s of plan.steps) {
      if (!s.script) continue
      // The Intel collector needs the node_exporter this run just set up: not on a node where that failed.
      if (plan.kind === 'install' && s.what === 'intel-gpu' && failedNodes.has(s.node)) {
        results.push({ node: s.node, status: 'skipped', reason: 'Intel GPU figures were not set up, because node_exporter did not install on this node' })
        continue
      }
      await auditCredentialUse('node_login.use', `node:${s.node}`, { purpose: `monitoring ${plan.kind}`, cluster: plan.clusterId, by: owner })
      let out: { code: number; output: string }
      try { out = await deps.run(s.address, s.script) } catch (e: any) { results.push({ node: s.node, status: 'failed', reason: e?.message ?? String(e) }); continue }
      const r = hardware.parseResult(out.output, out.code)
      results.push({ node: s.node, status: r.status, reason: r.reason })
      const at = new Date().toISOString()
      if (plan.kind === 'install' && s.what === 'node-exporter') {
        const listen = (r.status === 'done' || r.status === 'already') ? /listening on \[?([0-9a-fA-F:.]+)\]?:9100/.exec(r.reason)?.[1] : undefined
        if (listen) { targets.push({ node: s.node, listen }); monitoring[s.node] = { nodeExporter: { listen, installedByHyperProx: true, at }, ...(s.amd ? { amdGpu: { at } } : {}) } }
        else failedNodes.add(s.node)
      }
      if (plan.kind === 'install' && s.what === 'intel-gpu' && monitoring[s.node]) {
        const st = intelOutcome(r)
        if (st) monitoring[s.node] = { ...monitoring[s.node], intelGpu: { at, ...st } }
        else if (r.status === 'failed') { const { intelGpu: _gone, ...rest } = monitoring[s.node]; monitoring[s.node] = rest }
      }
      if (plan.kind === 'remove' && s.what === 'node-exporter' && (r.status === 'done' || r.status === 'already')) delete monitoring[s.node]
    }
    if (plan.kind === 'remove') { for (const k of Object.keys(monitoring)) delete monitoring[k] }
    // Keep targets for nodes already monitored and not touched in this run.
    const keep = plan.kind === 'install' ? Object.entries(monitoring).filter(([n, m]) => m.nodeExporter && !targets.some(t => t.node === n)).map(([n, m]) => ({ node: n, listen: m.nodeExporter!.listen })) : []
    deps.writeTargets(plan.clusterId, [...keep, ...targets])
    await deps.reload()
    await setMonitoring(plan.clusterId, monitoring)
    try { deps.dashboard?.() } catch { /* the board is redrawn on the next sync anyway */ }

    // Read back from HyperProx's side: the exporter answers here, and Prometheus scrapes it.
    const checks: Array<{ node: string; ok: boolean; words: string }> = []
    if (plan.kind === 'install') {
      for (const t of targets) {
        const m = await deps.metrics(t.listen)
        checks.push({ node: t.node, ok: !!m && /^node_exporter_build_info/m.test(m), words: m ? `HyperProx reads ${t.listen}:9100.` : `HyperProx cannot read ${t.listen}:9100. Is this HyperProx machine on the same private link?` })
        // Intel figures: read back here too, not taken from the script's word.
        if (monitoring[t.node]?.intelGpu?.status === 'measured') {
          const ok = !!m && /^hyperprox_intel_gpu_info\{[^}]*status="ok"/m.test(m)
          checks.push({ node: t.node, ok, words: ok ? 'HyperProx reads the Intel GPU figures.' : 'The Intel GPU figures are not in what node_exporter serves yet.' })
        }
      }
      let up: Record<string, number> = {}
      for (let i = 0; i < 6 && targets.some(t => up[t.node] !== 1); i++) { await deps.sleep(i === 0 ? 1000 : 8000); up = await deps.up(plan.clusterId) }
      for (const t of targets) checks.push({ node: t.node, ok: up[t.node] === 1, words: up[t.node] === 1 ? 'Prometheus is collecting from it.' : 'Prometheus has not collected from it yet (it scrapes every 15 seconds; check again in a minute).' })
    }
    return { results, checks, ok: results.every(r => r.status !== 'failed') && checks.every(c => c.ok) }
  })
}

/** What an Intel step's result means for the panel: measured, not supported on this GPU, or nothing to record. */
export function intelOutcome(r: { status: string; reason: string }): { status: 'measured' | 'unsupported'; reason?: string } | null {
  if (r.status === 'done' || r.status === 'already') return { status: 'measured' }
  if (r.status === 'skipped' && /^not supported on this GPU/.test(r.reason)) return { status: 'unsupported', reason: r.reason.slice(0, 200) }
  return null
}

/** Test seam. */
export function clearMonitoringPlans(): void { plans.clear() }
