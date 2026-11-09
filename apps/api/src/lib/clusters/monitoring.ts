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
import { targetsDir } from '../targets'
import { prometheusBase } from '../service-health'
import { auditCredentialUse } from '../audit'

/** Refuse any script that names the cluster-joining files or services. */
export function assertSafeScript(script: string): void {
  if (/corosync|pve-cluster|\/etc\/pve\/(corosync|cluster|priv)|pmxcfs/i.test(script)) {
    throw new Error('Refused: this script names corosync or pve-cluster, which HyperProx never touches on any cluster.')
  }
}

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
if [ -f /etc/default/prometheus-node-exporter ] && grep -q 'HyperProx' /etc/default/prometheus-node-exporter; then echo "ours=yes"; else echo "ours=no"; fi
if [ -f /etc/hyperprox/node-exporter-installed ]; then echo "installed_by_us=yes"; else echo "installed_by_us=no"; fi
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
  writeTargets(clusterId: string, entries: Array<{ node: string; listen: string }>): void
  reload(): Promise<void>
  up(clusterId: string): Promise<Record<string, number>>
  sleep(ms: number): Promise<void>
}

const hostPort = (h: string, p: number) => (h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`)

export function productionMonitoringDeps(): MonitoringDeps {
  return {
    async nodes() { const { pveFromEnv } = await import('../pve-env'); return ((await pveFromEnv().fetchStrict<any[]>('/nodes')) ?? []).filter(n => n.status === 'online').map(n => String(n.node)) },
    async run(host, script) {
      assertSafeScript(script)
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
export function writeRemoteTargets(clusterId: string, entries: Array<{ node: string; listen: string }>, dir = targetsDir()): void {
  const p = path.join(dir, NODES_FILE)
  let list: any[] = []
  try { list = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [] } catch { list = [] }
  const kept = (Array.isArray(list) ? list : []).filter(t => t?.labels?.hpx_cluster !== clusterId)
  const mine = entries.map(e => ({ targets: [hostPort(e.listen, 9100)], labels: { node: remoteNodeLabel(clusterId, e.node), hpx_cluster: clusterId, hpx_node: e.node } }))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${p}.tmp`, JSON.stringify([...kept, ...mine], null, 2))
  fs.renameSync(`${p}.tmp`, p)
}

// ── Scripts ──────────────────────────────────────────────────────────────────

/**
 * Install (or re-point) node_exporter to listen on the private-link address only. The defaults file is written
 * BEFORE the package is installed, and apt keeps it (--force-confold), so the service never starts listening on
 * every interface, not even for a moment.
 */
export function installScript(opts: { amdGpu: boolean }): string {
  const args = ['--web.listen-address=${LISTEN_HP}', ...(opts.amdGpu ? ['--collector.drm'] : [])].join(' ')
  return `${COMMON()}
LISTEN="$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $3}')"
[ -n "$LISTEN" ] || hp_result failed "could not tell which address HyperProx reached this node on"
IFACE="$(ip -o addr show 2>/dev/null | awk -v a="$LISTEN" '{split($4,p,"/"); if (p[1]==a) {print $2; exit}}')"
case "$IFACE" in tailscale*|wg*|ts[0-9]*) ;; *) hp_result failed "$LISTEN is on \${IFACE:-no interface}, not a Tailscale or WireGuard link, so nothing was installed (metrics are only ever offered on a private link)";; esac
case "$LISTEN" in *:*) LISTEN_HP="[$LISTEN]:9100";; *) LISTEN_HP="$LISTEN:9100";; esac
mkdir -p /etc/hyperprox
DEF=/etc/default/prometheus-node-exporter
if [ -f "$DEF" ] && ! grep -q HyperProx "$DEF" && [ ! -f "$DEF.hyperprox-orig" ]; then cp -p "$DEF" "$DEF.hyperprox-orig"; fi
state="$(hp_write_file "$DEF" 0644 "# Written by HyperProx: node_exporter listens on the private link only ($IFACE), not the home network.
# Remove monitoring in HyperProx to undo this.
ARGS=\\"${args}\\"")" || hp_result failed "could not write $DEF"
if ! hp_installed prometheus-node-exporter; then
  why="$(hp_safe_apt_install prometheus-node-exporter)" || hp_result failed "$why"
  touch /etc/hyperprox/node-exporter-installed
fi
systemctl enable prometheus-node-exporter >/dev/null 2>&1
systemctl restart prometheus-node-exporter >/dev/null 2>&1 || hp_result failed "installed, but the service would not start (journalctl -u prometheus-node-exporter)"
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 3 "http://$LISTEN_HP/metrics" 2>/dev/null | grep -q '^node_exporter_build_info' && { ok=1; break; }; sleep 1; done
[ -n "$ok" ] || hp_result failed "nothing answers on $LISTEN_HP"
wide="$(ss -ltnH 2>/dev/null | awk '$4 ~ /:9100$/ {print $4}' | grep -v -F "$LISTEN" || true)"
[ -z "$wide" ] || hp_result failed "node_exporter also listens on $wide; stop whatever else serves port 9100 and try again"
${opts.amdGpu ? `curl -fsS --max-time 3 "http://$LISTEN_HP/metrics" | grep -q '^node_drm_gpu_busy_percent' || hp_result failed "listening on $LISTEN_HP only, but no AMD GPU figures appeared (is the amdgpu driver loaded?)"` : ''}
[ "$state" = same ] && hp_result already "already listening on $LISTEN_HP only"
hp_result done "listening on $LISTEN_HP only${opts.amdGpu ? ', with AMD GPU figures' : ''}"
`
}

/** Undo: put the defaults file back, and remove the package only if HyperProx installed it. */
export function removeScript(): string {
  return `${COMMON()}
DEF=/etc/default/prometheus-node-exporter
changed=""
if [ -f "$DEF" ] && grep -q HyperProx "$DEF"; then
  if [ -f "$DEF.hyperprox-orig" ]; then mv -f "$DEF.hyperprox-orig" "$DEF"; else rm -f "$DEF"; fi
  changed=1
fi
if [ -f /etc/hyperprox/node-exporter-installed ]; then
  systemctl disable --now prometheus-node-exporter >/dev/null 2>&1 || true
  apt-get -q -y remove prometheus-node-exporter >/dev/null 2>&1 || hp_result failed "could not remove the prometheus-node-exporter package"
  rm -f /etc/hyperprox/node-exporter-installed
  rmdir /etc/hyperprox 2>/dev/null || true
  hp_result done "removed node_exporter (HyperProx had installed it)"
fi
if [ -n "$changed" ]; then systemctl restart prometheus-node-exporter >/dev/null 2>&1 || true; hp_result done "node_exporter is back to how it was before HyperProx"; fi
hp_result already "nothing of HyperProx's was here"
`
}

// ── Scan, questions, preview, apply ─────────────────────────────────────────

export interface Question { id: 'server-metrics' | 'amd-gpu' | 'proxmox-metrics'; ask: string; what: string; available: boolean; default: boolean; why?: string }

export async function scanMonitoring(clusterId: string, deps: MonitoringDeps = productionMonitoringDeps()) {
  return runInCluster(clusterId, async () => {
    const row = clusterRow(clusterId)
    if (!row || row.kind !== 'remote') throw new Error('Monitoring here is for a remote server.')
    const nodes = await deps.nodes()
    const facts: NodeFacts[] = []
    for (const node of nodes) {
      const address = row.nodeAddresses[node] ?? null
      const blank = (problem: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({ node, address, login: false, reachable: false, listen: null, iface: null, privateLink: false, packageInstalled: false, serviceActive: false, listening: [], amd: false, ours: false, installedByUs: false, problem, ...extra })
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
    const questions: Question[] = [
      { id: 'server-metrics', ask: 'Watch this server\'s CPU, memory, disks and network?', what: 'Installs node_exporter from the server\'s own packages. It listens on the private-link address only, never on the home network.', available: ready.length > 0, default: true, ...(ready.length ? {} : { why: 'No node is ready (see each node\'s note).' }) },
      { id: 'amd-gpu', ask: 'Show the AMD GPU\'s load, video memory and temperature?', what: 'Turns on node_exporter\'s GPU collector. Drivers are never touched.', available: anyAmd, default: anyAmd, ...(anyAmd ? {} : { why: 'No AMD GPU was found.' }) },
      { id: 'proxmox-metrics', ask: 'Proxmox figures (guests, storage, backups) in Grafana?', what: 'Coming soon. The Command center already shows them through the admin token.', available: false, default: false, why: 'Coming soon.' },
    ]
    return { nodes: facts, questions }
  })
}

interface Plan {
  id: string; clusterId: string; owner: string; kind: 'install' | 'remove'; createdAt: number; used: boolean
  steps: Array<{ node: string; address: string; words: string; script: string; amd: boolean }>
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
      steps.push({ node: f.node, address: f.address, amd, script: installScript({ amdGpu: amd }),
        words: `${f.node}: ${f.packageInstalled ? 'use the node_exporter already installed' : 'install node_exporter (prometheus-node-exporter, from its own packages; nothing is upgraded or removed)'}, listening on ${f.listen}:9100 only (${f.iface})${amd ? ', with the AMD GPU collector on' : ''}. Then point HyperProx's Prometheus at it.` })
    } else if (f.ours || f.installedByUs) {
      steps.push({ node: f.node, address: f.address, amd: false, script: removeScript(),
        words: `${f.node}: ${f.installedByUs ? 'remove node_exporter (HyperProx installed it)' : 'put node_exporter\'s settings back as they were before HyperProx'}, and stop Prometheus scraping it.` })
    }
  }
  if (kind === 'remove' && !steps.length) {
    // Nothing on the server, but Prometheus may still list it: removing the targets is the whole plan.
    steps.push({ node: '', address: '', amd: false, script: '', words: 'Stop Prometheus scraping this server (nothing of HyperProx\'s is installed on it).' })
  }
  if (!steps.length) throw new MonitoringRefusal('Nothing to do: answer yes to at least one question, and make sure a node is ready.')
  for (const s of steps) if (s.script) assertSafeScript(s.script)
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
    for (const s of plan.steps) {
      if (!s.script) continue
      await auditCredentialUse('node_login.use', `node:${s.node}`, { purpose: `monitoring ${plan.kind}`, cluster: plan.clusterId, by: owner })
      let out: { code: number; output: string }
      try { out = await deps.run(s.address, s.script) } catch (e: any) { results.push({ node: s.node, status: 'failed', reason: e?.message ?? String(e) }); continue }
      const r = hardware.parseResult(out.output, out.code)
      results.push({ node: s.node, status: r.status, reason: r.reason })
      if (plan.kind === 'install' && (r.status === 'done' || r.status === 'already')) {
        const listen = /listening on \[?([0-9a-fA-F:.]+)\]?:9100/.exec(r.reason)?.[1]
        if (listen) { targets.push({ node: s.node, listen }); monitoring[s.node] = { nodeExporter: { listen, installedByHyperProx: true, at: new Date().toISOString() }, ...(s.amd ? { amdGpu: { at: new Date().toISOString() } } : {}) } }
      }
      if (plan.kind === 'remove' && (r.status === 'done' || r.status === 'already')) delete monitoring[s.node]
    }
    if (plan.kind === 'remove') { for (const k of Object.keys(monitoring)) delete monitoring[k] }
    // Keep targets for nodes already monitored and not touched in this run.
    const keep = plan.kind === 'install' ? Object.entries(monitoring).filter(([n, m]) => m.nodeExporter && !targets.some(t => t.node === n)).map(([n, m]) => ({ node: n, listen: m.nodeExporter!.listen })) : []
    deps.writeTargets(plan.clusterId, [...keep, ...targets])
    await deps.reload()
    await setMonitoring(plan.clusterId, monitoring)

    // Read back from HyperProx's side: the exporter answers here, and Prometheus scrapes it.
    const checks: Array<{ node: string; ok: boolean; words: string }> = []
    if (plan.kind === 'install') {
      for (const t of targets) {
        const m = await deps.metrics(t.listen)
        checks.push({ node: t.node, ok: !!m && /^node_exporter_build_info/m.test(m), words: m ? `HyperProx reads ${t.listen}:9100.` : `HyperProx cannot read ${t.listen}:9100. Is this HyperProx machine on the same private link?` })
      }
      let up: Record<string, number> = {}
      for (let i = 0; i < 6 && targets.some(t => up[t.node] !== 1); i++) { await deps.sleep(i === 0 ? 1000 : 8000); up = await deps.up(plan.clusterId) }
      for (const t of targets) checks.push({ node: t.node, ok: up[t.node] === 1, words: up[t.node] === 1 ? 'Prometheus is collecting from it.' : 'Prometheus has not collected from it yet (it scrapes every 15 seconds; check again in a minute).' })
    }
    return { results, checks, ok: results.every(r => r.status !== 'failed') && checks.every(c => c.ok) }
  })
}

/** Test seam. */
export function clearMonitoringPlans(): void { plans.clear() }
