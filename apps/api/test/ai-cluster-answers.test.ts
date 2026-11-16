// How the assistant answers cluster questions: "what's on my cluster" as a deterministic inventory, the "how is
// everything" roll-call with no duplicate lines and one health that agrees with itself, backups across every job,
// and slow areas answered from their last reading within a budget instead of "could not be read".
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { answerQuestion, loadWithin, clearReadingCache, type AskSource, type SourceSummary } from "../src/lib/ai/ask"
import { isInventoryQuestion, inventoryText, type AppHints } from "../src/lib/ai/inventory"
import { appHints } from "../src/lib/ai/inventory-hints"
import { rollCallText, headlineNeedsAttention } from "../src/lib/ai/rollcall"
import { clusterHealth, cephChecksOf } from "../src/lib/ai/health"
import { clusterSummary, gatherBackups, backupSummary, gatherClusterSummary, selectionOfLog, selectionOfJob, cadenceOf, type ClusterSummary } from "../src/lib/ai/ask-sources"
import { statusSummary } from "../src/lib/ai/cluster-sources"
import { startLoop } from "../src/lib/ai/loop"
import { nextcloudPlugin } from "../src/plugins/nextcloud"
import type { ClusterPanel } from "../src/lib/clusters/overview"
import type { Inventory } from "../src/lib/homepage/types"
import type { ModelCall } from "../src/lib/ai/extract"

const never: ModelCall = async () => { throw new Error("the model must not be called") }
beforeEach(() => clearReadingCache())

const summary = (over: Partial<ClusterSummary> = {}): ClusterSummary => ({
  nodes: [{ node: "node1", online: true, cores: 8, memUsedMb: 1, memTotalMb: 2 }, { node: "node2", online: true, cores: 4, memUsedMb: 1, memTotalMb: 2 }],
  guests: [
    { vmid: 101, node: "node1", type: "lxc", name: "media", running: true, tags: ["media"] },
    { vmid: 102, node: "node1", type: "lxc", name: "sonarr", running: true },
    { vmid: 103, node: "node2", type: "lxc", name: "scratch", running: false },
    { vmid: 201, node: "node2", type: "qemu", name: "win11", running: true },
    { vmid: 202, node: "node2", type: "qemu", name: "kali", running: false },
  ],
  templates: [{ vmid: 9000, node: "node1", type: "lxc", name: "debian-13" }],
  storages: [], ceph: "HEALTH_OK", cephChecks: [], ha: { total: 1, problems: [], sids: ["ct:102"] }, version: "1.0.0", partial: [], ...over,
})

// ---------------------------------------------------------------------------
//  Inventory: routing
// ---------------------------------------------------------------------------

test("inventory intent: the ways people ask what is on the cluster", () => {
  for (const p of ["What's on my cluster?", "what is on the server", "What's running?", "what is running right now", "What do I have?",
    "list my guests", "List my apps", "show me my containers", "list all my VMs", "what containers do I have", "which guests are stopped",
    "what's in my homelab"]) assert.ok(isInventoryQuestion(p), p)
  for (const p of ["Is plex running?", "How many containers do I have?", "What's on my network?", "how is everything", "deploy gitea",
    "what is a container", "restart plex"]) assert.ok(!isInventoryQuestion(p), p)
  // On a named cluster or node.
  assert.ok(isInventoryQuestion("What's on Lab?", ["Lab"])); assert.ok(isInventoryQuestion("what's running on node2", ["node2"]))
  assert.ok(!isInventoryQuestion("What's on Lab?", []))
})

test("inventory intent: \"list my guests\" is answered from the cluster, with no intent or model call", async () => {
  let intent = 0, asked = ""
  const s = await startLoop("list my guests", {
    facts: {} as never, settings: { bridge: "vmbr0" }, now: () => new Date(0),
    intent: async () => { intent++; return { template: "deploy-service", question: false, answer: "" } },
    ask: async p => { asked = p; return "inventory" },
    extract: async () => { throw new Error("no extraction") },
  })
  assert.equal(s.state, "answer"); assert.equal(s.answer, "inventory"); assert.equal(asked, "list my guests"); assert.equal(intent, 0)
})

// ---------------------------------------------------------------------------
//  Inventory: the answer
// ---------------------------------------------------------------------------

const hints: AppHints = { apps: { 101: ["Plex", "Tautulli"], 102: ["Sonarr"] }, addresses: { 101: "192.0.2.11", 102: "192.0.2.12" }, asOf: null, note: null }

test("inventory: per node, each running guest with what it is, its address and HA; stopped and templates grouped at the end", () => {
  const out = inventoryText(summary(), hints, { prompt: "what's on my cluster", name: "Lab" })
  assert.equal(out.split("\n")[0], "On Lab: 5 guests, 3 running and 2 stopped (3 containers, 2 VMs), plus 1 template across 2 nodes.")
  assert.match(out, /node1 \(2 running\):\n- media \(container 101\): Plex, Tautulli, 192\.0\.2\.11\n- sonarr \(container 102\): Sonarr, 192\.0\.2\.12, HA/)
  assert.match(out, /node2 \(1 running\):\n- win11 \(VM 201\)\n/)
  assert.match(out, /Stopped \(2\): kali \(VM 202, node2; Kali Linux\)|Stopped \(2\): kali \(VM 202, node2\)/)
  assert.match(out, /scratch \(container 103, node2\)\./)
  assert.match(out, /\nTemplates \(1\): debian-13 \(node1\)\.$/)
  // A stopped guest is never listed under its node as running.
  assert.doesNotMatch(out.split("Stopped")[0], /scratch|kali/)
})

test("inventory: without detector hints, a known name or the tags say what a guest is; nothing is invented", () => {
  const out = inventoryText(summary(), null, { prompt: "what do I have" })
  assert.match(out, /- sonarr \(container 102\): Sonarr, HA/)   // the name is a known app
  assert.match(out, /- media \(container 101\): tagged media/)
  assert.match(out, /- win11 \(VM 201\)\n/)
  assert.doesNotMatch(out, /192\.0\.2/)
})

test("inventory: narrowed by node, type or apps; long lists are cut with a count; offline nodes said", () => {
  const many = summary({ guests: Array.from({ length: 20 }, (_, i) => ({ vmid: 300 + i, node: "node1", type: "lxc" as const, name: `worker${String(i).padStart(2, "0")}`, running: true })) })
  const out = inventoryText(many, null, {})
  assert.match(out, /node1 \(20 running\):/)
  assert.equal(out.split("\n").filter(l => l.startsWith("- worker")).length, 15)
  assert.match(out, /- and 5 more: worker15, worker16, worker17, worker18, worker19/)

  assert.match(inventoryText(summary(), hints, { prompt: "what's running on node2" }), /^On node2: 3 guests, 1 running and 2 stopped/)
  const vms = inventoryText(summary(), hints, { prompt: "list my VMs" })
  assert.match(vms, /^On your cluster: 2 VMs, 1 running and 1 stopped/); assert.doesNotMatch(vms, /sonarr|media/)
  const apps = inventoryText(summary(), hints, { prompt: "list my apps" })
  assert.match(apps, /^On your cluster: 2 guests with an app, 2 running and 0 stopped/); assert.doesNotMatch(apps, /win11/)

  const down = summary({ nodes: [{ node: "node1", online: true, cores: 1, memUsedMb: 1, memTotalMb: 1 }, { node: "node2", online: false, cores: 1, memUsedMb: 0, memTotalMb: 1 }],
    guests: [{ vmid: 201, node: "node2", type: "qemu", name: "win11", running: false }] })
  const d = inventoryText(down, null, {})
  assert.match(d, /node2: offline/); assert.match(d, /win11 \(VM 201, node2, node offline\)/)
  assert.match(inventoryText(summary({ partial: ["resources"] }), null, {}), /could not read the guest list/)
})

test("inventory: an answer never waits on the app detectors: late hints are left out with a note", async () => {
  const cluster: AskSource = { id: "cluster", title: "Cluster", blurb: "", aliases: /cluster/, budgetMs: 1500,
    load: async () => clusterSummary(summary()), hints: () => new Promise(() => {}) }
  const t0 = Date.now()
  const out = (await answerQuestion("What's on my cluster?", { sources: [cluster], call: never, fallback: "x" }))!
  assert.ok(Date.now() - t0 < 1400, `took ${Date.now() - t0} ms`)
  assert.match(out, /^On your cluster: 5 guests/); assert.match(out, /still being looked up/)
})

test("inventory hints: the kept inventory is used at once and rebuilt in the background when stale; viewers get no addresses", async () => {
  const inv = {
    guests: [{ vmid: 101, name: "media", node: "node1", type: "lxc", status: "running", tags: [], addresses: ["192.0.2.11"], machineId: "lxc-101" },
      { vmid: 102, name: "sonarr", node: "node1", type: "lxc", status: "running", tags: ["hyperprox-ignore"], addresses: ["192.0.2.12"], machineId: "lxc-102" },
      { vmid: 103, name: "private", node: "node1", type: "lxc", status: "running", tags: [], addresses: ["192.0.2.13"], machineId: "lxc-103" }],
    services: [{ key: "plex", url: "http://192.0.2.11:32400", source: "scan", guest: { vmid: 101, name: "media", node: "node1", type: "lxc" } },
      { key: "sonarr", url: "http://192.0.2.12:8989", source: "plugin", guest: { vmid: 102, name: "sonarr", node: "node1", type: "lxc" } }],
    proxyHosts: [], sites: [], excludedMachineIds: ["lxc-103"], builtAt: 0, errors: [], failed: [], pluginUrls: {},
  } as unknown as Inventory
  let builds = 0
  const base = { build: async () => { builds++; return inv }, freshMs: 60_000, budgetMs: 100, now: () => 1_000_000,
    sites: async () => [{ name: "Blog", kindName: "WordPress", vmid: 104 }] }
  const h = await appHints({ ...base, peek: () => ({ inv, at: 1_000_000 - 120_000 }), showAddresses: true })
  assert.deepEqual(h.apps, { 101: ["Plex"], 102: ["Sonarr"], 104: ["WordPress website Blog"] })
  // Ignored and excluded guests show no address.
  assert.deepEqual(h.addresses, { 101: "192.0.2.11" })
  assert.equal(h.asOf, 1_000_000 - 120_000); assert.equal(builds, 1)   // stale: one background rebuild
  const viewer = await appHints({ ...base, peek: () => ({ inv, at: 1_000_000 }), showAddresses: false })
  assert.deepEqual(viewer.addresses, {}); assert.equal(builds, 1)     // fresh: no rebuild
  const never = await appHints({ ...base, peek: () => null, build: () => new Promise(() => {}), showAddresses: true })
  assert.deepEqual(never.apps, { 104: ["WordPress website Blog"] }); assert.match(never.note!, /still being looked up/)
})

// ---------------------------------------------------------------------------
//  Health: one place, the same words everywhere
// ---------------------------------------------------------------------------

const cephWarn = { health: { status: "HEALTH_WARN", checks: { POOL_NO_REDUNDANCY: { severity: "HEALTH_WARN", summary: { message: "1 pool(s) have no replicas configured" } } } } }

test("health: an accepted Ceph warning is a known warning, never a problem; an unaccepted one is a problem", () => {
  const known = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, ["POOL_NO_REDUNDANCY"]) })
  const h = clusterHealth(known)
  assert.deepEqual(h.problems, []); assert.equal(h.ceph, "Ceph has a known warning"); assert.ok(h.cephKnownOnly)
  assert.match(clusterSummary(known).headline, /Ceph has a known warning\.$/)
  const open = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, []) })
  assert.deepEqual(clusterHealth(open).problems, ["Ceph: 1 pool(s) have no replicas configured"])
  // A check muted in Ceph itself is known as well.
  const muted = { health: { ...cephWarn.health, mutes: [{ code: "POOL_NO_REDUNDANCY" }] } }
  assert.equal(cephChecksOf(muted, [])[0].known, true)
})

test("health: gatherClusterSummary reads the checks and the HA resources", async () => {
  const s = await gatherClusterSummary((async (p: string) => {
    if (p === "/cluster/resources") return [{ type: "node", node: "node1", status: "online" }, { type: "lxc", vmid: 101, node: "node1", name: "a", status: "running", tags: "media;web" },
      { type: "lxc", vmid: 9000, node: "node1", name: "tpl", status: "stopped", template: 1 }]
    if (p === "/cluster/ceph/status") return cephWarn
    if (p === "/cluster/ha/status/current") return [{ type: "service", sid: "ct:101", state: "started" }]
    throw new Error(p)
  }) as never, { accepted: () => ["POOL_NO_REDUNDANCY"] })
  assert.deepEqual(s.guests[0].tags, ["media", "web"]); assert.deepEqual(s.templates, [{ vmid: 9000, node: "node1", type: "lxc", name: "tpl" }])
  assert.deepEqual(s.ha?.sids, ["ct:101"]); assert.equal(s.cephChecks?.[0].known, true)
})

const panel = (over: Partial<ClusterPanel> = {}): ClusterPanel => ({
  id: "home", name: "Lab", kind: "home", reachable: true, latencyMs: 1, nodes: { online: 2, total: 2 }, quorum: "ok", guests: { running: 3, total: 5 },
  cpuPct: 10, memPct: 20, storagePct: 30, networkStorage: [], gpus: [], gpuNote: null, lastBackup: { at: Date.now(), ok: true, node: "node1" }, attention: [], monitoring: true, ...over,
})

test("health: the Status answer and the cluster line agree about Ceph", () => {
  const known = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, ["POOL_NO_REDUNDANCY"]) })
  const st = statusSummary({ id: "home", name: "Lab", kind: "home" }, panel(), Date.now(), known)
  assert.match(st.headline, /nothing needs attention \(a known warning\)\.$/)
  assert.ok(st.lines.includes("Ceph has a known warning.")); assert.ok(st.lines.some(l => /^Known warning: 1 pool/.test(l)))
  const open = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, []) })
  const bad = statusSummary({ id: "home", name: "Lab", kind: "home" }, panel(), Date.now(), open)
  assert.match(bad.headline, /1 thing needs attention\.$/); assert.ok(bad.lines.includes("Needs attention: Ceph: 1 pool(s) have no replicas configured."))
  // Before: the panel alone, which does not read Ceph, said nothing needs attention.
  assert.doesNotMatch(bad.lines.join(" "), /Nothing needs attention/)
})

// ---------------------------------------------------------------------------
//  The roll-call
// ---------------------------------------------------------------------------

const src = (id: string, title: string, sum: Partial<SourceSummary> & { headline: string }, over: Partial<AskSource> = {}): AskSource =>
  ({ id, title, blurb: "", aliases: new RegExp(id), load: async () => ({ lines: [], ...sum }), ...over })

test("roll-call: the cluster once, load balancing once, what needs attention first", async () => {
  const known = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, ["POOL_NO_REDUNDANCY"]) })
  const sources = [
    src("cluster", "Cluster", { ...clusterSummary(known) }),
    src("status", "Status", { headline: "Lab: 2/2 nodes online, 3/5 guests running, nothing needs attention.", data: panel() }),
    src("placement", "Load balancing: guests", { headline: "Load balancing: 5 guests on 2 nodes, 1 tied to their node." }, { overview: false }),
    src("placement-balance", "Load balancing", { headline: "Load balancing: Balanced: CPU and memory within 21 points across 2 nodes." }),
    src("hardware", "Hardware scan", { headline: "Lab hardware: 2 nodes scanned." }, { overview: false }),
    src("pbs", "Proxmox Backup Server", { headline: "Backup server: 1 server, 1 needs attention." }),
    src("alerts", "Alerts", { headline: "Alerts: 1 firing.", data: { prometheus: true, rows: [{ name: "CephHealthWarning", title: "Ceph health warning", state: "firing", muted: false }] } }),
    src("plugin:homepage", "Homepage", { headline: "Homepage: connected, nothing to summarise.", noSummary: true }),
  ]
  const out = (await answerQuestion("how is everything", { sources, call: never, fallback: "x" }))!
  const count = (t: string) => out.split(t).length - 1
  assert.equal(count("Cluster:"), 1); assert.equal(count("Load balancing"), 1); assert.equal(count("Lab:"), 0); assert.equal(count("Hardware"), 0)
  assert.match(out, /^Needs attention:\n- Backup server: 1 server, 1 needs attention\.\n\nEverything else:\n/)
  assert.match(out, /Cluster: 2\/2 nodes online, 3\/5 guests running, Ceph has a known warning; nothing needs attention \(known warning: 1 pool\(s\) have no replicas configured\)\./)
  // The Ceph alert is the known warning, not a new problem.
  assert.match(out, /Alerts: 1 known alert firing, nothing new\./)
  assert.match(out, /Connected, with nothing to report: Homepage\./)
  assert.doesNotMatch(out, /HEALTH_WARN|Attached:/)
})

test("roll-call: an unaccepted Ceph warning leads, and no other line says the cluster is fine", () => {
  const open = summary({ ceph: "HEALTH_WARN", cephChecks: cephChecksOf(cephWarn, []) })
  const out = rollCallText([
    { s: src("cluster", "Cluster", { headline: "" }), sum: clusterSummary(open), state: "ok" },
    { s: src("status", "Status", { headline: "" }), sum: { headline: "Lab: fine", lines: [], data: panel() }, state: "ok" },
  ])
  assert.match(out, /^Needs attention:\n- Cluster: 2\/2 nodes online, 3\/5 guests running, Ceph HEALTH_WARN; 1 thing needs attention: Ceph: 1 pool/)
  assert.doesNotMatch(out, /nothing needs attention/i)
})

test("roll-call: a headline needs attention only for a real count", () => {
  for (const h of ["Backup server: 1 server, 1 needs attention.", "Notifications: 2 channels, 1 failing.", "Nextcloud: cloud: 2 errors", "Websites: 2 sites, 1 not answering."])
    assert.ok(headlineNeedsAttention(h), h)
  for (const h of ["Home Assistant: 4 entities, 0 unavailable", "Notifications: 2 channels, 0 failing.", "QNAP: 1 NAS, all healthy."])
    assert.ok(!headlineNeedsAttention(h), h)
})

// ---------------------------------------------------------------------------
//  Slow areas: a budget, the last reading, never "could not be read" for slow
// ---------------------------------------------------------------------------

const slow = (ms: number, sum: SourceSummary) => new Promise<SourceSummary>(r => setTimeout(() => r(sum), ms))

test("slow source: answered from its last reading within the budget, with its time; refreshed in the background", async () => {
  let delay = 0, n = 0
  const nas: AskSource = { id: "qnap", title: "QNAP NAS", blurb: "", aliases: /nas/, budgetMs: 80,
    load: () => slow(delay, { headline: `QNAP: reading ${++n}.`, lines: [`reading ${n}`] }) }
  let clock = Date.UTC(2026, 0, 1, 12, 0)
  const now = () => clock
  assert.equal((await loadWithin(nas, { cacheKey: "admin", now })).state, "ok")            // fast: read now, kept
  delay = 300; clock += 10 * 60_000
  const t0 = Date.now()
  const l = await loadWithin(nas, { cacheKey: "admin", now })
  assert.ok(Date.now() - t0 < 250, `waited ${Date.now() - t0} ms`)
  assert.equal(l.state, "cached"); assert.equal(l.sum.headline, "QNAP: reading 1."); assert.equal(l.sum.asOf, Date.UTC(2026, 0, 1, 12, 0))
  const said = rollCallText([l], clock)
  assert.match(said, /QNAP: reading 1 \(as of \d\d:\d\d\)\./); assert.doesNotMatch(said, /could not be read|Still being read/)
  await new Promise(r => setTimeout(r, 300))                                                // the slow read finished meanwhile
  delay = 300
  assert.equal((await loadWithin(nas, { cacheKey: "admin", now })).sum.headline, "QNAP: reading 2.")
  // Kept apart by who asked: a viewer never gets an admin's reading.
  assert.equal((await loadWithin(nas, { cacheKey: "viewer", now })).state, "pending")
})

test("slow source with no earlier reading: said as still being read, not as a failure; a real failure says why", async () => {
  const stuck: AskSource = { id: "plugin:nextcloud", title: "Nextcloud", blurb: "", aliases: /nextcloud/, budgetMs: 60, load: () => new Promise(() => {}) }
  const broken: AskSource = { id: "plugin:x", title: "X", blurb: "", aliases: /\bx\b/, load: async () => { throw new Error("ECONNREFUSED 192.0.2.9:443") } }
  const fine: AskSource = { id: "dns", title: "DNS", blurb: "", aliases: /dns/, load: async () => ({ headline: "DNS: 2 zones.", lines: [] }) }
  const t0 = Date.now()
  const out = (await answerQuestion("status", { sources: [fine, stuck, broken], call: never, fallback: "x" }))!
  assert.ok(Date.now() - t0 < 1000)
  assert.match(out, /Still being read, because it is slow to answer: Nextcloud\. Ask again in a minute\./)
  assert.match(out, /Could not read: X \(it did not answer\)\./); assert.doesNotMatch(out, /192\.0\.2|ECONNREFUSED|timed out/)
  const one = (await answerQuestion("is nextcloud ok", { sources: [stuck], call: never, fallback: "x" }))!
  assert.match(one, /^Nextcloud is slow to answer and still being read\. Ask again in a minute\.$/)
})

test("Nextcloud: the assistant reads the kept readings and says how old they are", async () => {
  const at = Date.now() - 20 * 60_000
  let path = ""
  const r = await nextcloudPlugin.summary!({ get: async (p: string) => { path = p; return [{ id: "1", name: "cloud", version: "30.0.1", update: null, counts: { error: 0, warning: 2, info: 1 }, error: null, at }] } } as never)
  assert.equal(path, "/readings/cached")
  assert.match(r.lines[0], /^cloud: Nextcloud 30\.0\.1; 0 errors, 2 warnings, 1 notes \(as of \d\d:\d\d\)$/)
})

// ---------------------------------------------------------------------------
//  Backups: the latest run of every job
// ---------------------------------------------------------------------------

const fixture = JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/ask-cluster-jobs.json"), "utf8"))
const backupFetch = (over: Record<string, unknown> = {}) => {
  const fake = { ...fixture, ...over }
  return (async (p: string) => {
    if (p === "/nodes") return fake.nodes
    if (p === "/cluster/backup") { if (!fake.backupJobs) throw new Error("403"); return fake.backupJobs }
    const t = /^\/nodes\/([^/]+)\/tasks\?/.exec(p)
    if (t) return fake.backupTasks[t[1]] ?? []
    const l = /^\/nodes\/[^/]+\/tasks\/([^/]+)\/log(\?.*)?$/.exec(p)
    if (l) {
      const all = fake.backupLogs[decodeURIComponent(l[1])].map((t: string, n: number) => ({ n: n + 1, t }))
      return /limit=3/.test(l[2] ?? "") ? all.slice(0, 3) : all
    }
    throw new Error("unexpected " + p)
  }) as never
}
const NOW = 1767225600000

test("backups: the latest run of each job, matched by the guests it selects; a manual backup is not a job", async () => {
  const r = await gatherBackups(backupFetch(), NOW)
  assert.deepEqual(r.jobs.map(j => [j.schedule, j.guests.length, j.guests.every(g => g.ok)]), [["22:00", 3, true], ["sun 21:00", 2, true]])
  const s = backupSummary(r, NOW)
  assert.equal(s.headline, "Backups: 3 of 3 guests backed up last night; weekly job OK (2 of 2 on Sunday 2025-12-28).")
  assert.equal(s.attention, undefined)
  assert.doesNotMatch(s.lines.join(" "), /102 \(manual/)
})

test("backups: a failed guest in any job needs attention; a job with no run in 8 days is said", async () => {
  const logs = { ...fixture.backupLogs, "UPID:beta:w:1:1:vzdump:201:root@pam:": [fixture.backupLogs["UPID:beta:w:1:1:vzdump:201:root@pam:"][0], "INFO: Starting Backup of VM 201 (qemu)", "ERROR: Backup of VM 201 failed - storage is offline"] }
  const s = backupSummary(await gatherBackups(backupFetch({ backupLogs: logs }), NOW), NOW)
  assert.match(s.headline, /3 of 3 guests backed up last night; the weekly job \(sun 21:00\): 1 of 2 failed\./)
  assert.deepEqual(s.attention, ["guest 201 (storage is offline)"])
  const jobs = [...fixture.backupJobs, { id: "backup-monthly", type: "vzdump", enabled: 1, schedule: "mon 03:00", vmid: "103" }]
  const idle = backupSummary(await gatherBackups(backupFetch({ backupJobs: jobs }), NOW), NOW)
  assert.match(idle.headline, /the weekly job \(mon 03:00\): no run in the last 8 days/)
  assert.ok(idle.attention?.some(a => /mon 03:00/.test(a)))
})

test("backups: without the job list, the most recent run alone, as before", async () => {
  const r = await gatherBackups(backupFetch({ backupJobs: null }), NOW)
  assert.equal(r.jobs.length, 1); assert.equal(r.jobs[0].schedule, null)
  assert.match(backupSummary(r, NOW).lines[0], /^Last night's backup \(22:00\): 3 guests backed up, 0 failed/)
})

test("backups: selections and schedules", () => {
  assert.equal(selectionOfLog("INFO: starting new backup job: vzdump 201 101 --storage x --mode snapshot"), "ids:101,201")
  assert.equal(selectionOfLog("INFO: starting new backup job: vzdump --all 1 --exclude 105,104 --storage x"), "all|104,105")
  assert.equal(selectionOfLog("INFO: starting new backup job: vzdump --pool media --storage x"), "pool:media")
  assert.equal(selectionOfJob({ vmid: "101,201" }), "ids:101,201"); assert.equal(selectionOfJob({ all: 1, exclude: "105,104" }), "all|104,105")
  assert.deepEqual(["02:00", "sun 01:00", "mon..fri 03:00", "monthly"].map(cadenceOf), ["daily", "weekly", "other", "other"])
})
