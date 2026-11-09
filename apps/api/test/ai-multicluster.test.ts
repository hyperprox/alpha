// The assistant on more than one cluster: which cluster a question or request is about, facts read through
// each cluster's own context with nothing of one leaking into another's answer, and actions that are bound to
// the cluster they were prepared for. The routes run behind the real cluster-context hook, so a request's
// X-HyperProx-Cluster header is resolved exactly as in production; Proxmox, the model and the vault are fakes.
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildAiRoutes } from "../src/routes/ai"
import { PreparedStore } from "../src/lib/ai/prepared"
import { resolveTargets, withoutClusterWords, aboutLine, type ClusterRef } from "../src/lib/ai/clusters"
import { perClusterSources, homeOnlySource, type ClusterSourceDeps } from "../src/lib/ai/cluster-sources"
import { parseAction, guestWords, uiRouteFor, type ActionPlan } from "../src/lib/ai/actions"
import { setClusterStore, loadClusters, clusterRow, HOME_ID } from "../src/lib/clusters/registry"
import { MemoryClusterStore } from "../src/lib/clusters/store"
import { installClusterContext, runInCluster, currentClusterId, remoteRouteAllowed } from "../src/lib/clusters/context"
import { requiredRole, needsReconfirm, type Role } from "../src/lib/roles"
import { previewMonitoring, applyMonitoring, clearMonitoringPlans, SCAN_SCRIPT, MonitoringRefusal, type MonitoringDeps } from "../src/lib/clusters/monitoring"
import type { ClusterPanel } from "../src/lib/clusters/overview"
import type { ModelCall } from "../src/lib/ai/extract"
import { setAuditSink } from "../src/lib/audit"
import { GuestActionRefusal, destroy } from "../src/lib/clusters/guest-actions"
import { reconfirmFor, applyAction } from "../src/lib/ai/actions"
import { boundTo } from "../src/lib/ai/cluster-sources"
import { updateCluster } from "../src/lib/clusters/registry"
import { previewCopy, startCopy, setCopyKick, kickCopies, setJobStore, MemoryJobStore } from "../src/lib/clusters/files"
import { CertsService } from "../src/lib/certs/service"
import { MemoryCertsStore } from "../src/lib/certs/store"
import { defaultModules } from "../src/lib/certs/modules"

const R = "c0123456789", R2 = "c0123456780"
const HOME: ClusterRef = { id: HOME_ID, name: "Home cluster", kind: "home" }
const REMOTE: ClusterRef = { id: R, name: "Remote server", kind: "remote" }
const OTHER: ClusterRef = { id: R2, name: "Office lab", kind: "remote" }
const never: ModelCall = async () => { throw new Error("the model must not be called") }

// ---------------------------------------------------------------------------
//  Which cluster
// ---------------------------------------------------------------------------

test("targets: the open cluster by default, a named one, the remote, home, all", () => {
  const all = [HOME, REMOTE]
  assert.deepEqual(resolveTargets("how many containers?", all, HOME), { kind: "ok", clusters: [HOME], named: false, all: false })
  assert.deepEqual(resolveTargets("how many containers?", all, REMOTE), { kind: "ok", clusters: [REMOTE], named: false, all: false })
  assert.deepEqual((resolveTargets("how many containers on Remote server?", all, HOME) as any).clusters, [REMOTE])
  assert.deepEqual((resolveTargets("restart plex on the remote", all, HOME) as any).clusters, [REMOTE])
  assert.deepEqual((resolveTargets("how is the home cluster doing", all, REMOTE) as any).clusters, [HOME])
  assert.deepEqual((resolveTargets("what GPUs does each cluster have?", all, REMOTE) as any).clusters, [HOME, REMOTE])
  assert.deepEqual((resolveTargets("storage across all my clusters", all, HOME) as any).all, true)
  // "Home Assistant" is a plug-in, not the home cluster.
  assert.deepEqual((resolveTargets("is the home assistant light on?", all, REMOTE) as any).clusters, [REMOTE])
})

test("targets: an unknown name, several remotes, or no remote is asked about, never guessed", () => {
  const unknown = resolveTargets("how is the Lab cluster doing?", [HOME, REMOTE], HOME)
  assert.equal(unknown.kind, "ask")
  assert.match((unknown as any).message, /I do not know a cluster called "Lab"\. Your clusters are: Home cluster, Remote server/)
  assert.deepEqual((unknown as any).choices.map((c: ClusterRef) => c.name), ["Home cluster", "Remote server"])
  const two = resolveTargets("restart plex on the remote", [HOME, REMOTE, OTHER], HOME)
  assert.equal(two.kind, "ask")
  assert.deepEqual((two as any).choices.map((c: ClusterRef) => c.name), ["Remote server", "Office lab"])
  assert.match((resolveTargets("back up the remote now", [HOME], HOME) as any).message, /no remote cluster yet/)
})

test("targets: cluster words are taken out of the question, and the about line names each cluster", () => {
  assert.equal(withoutClusterWords("how many containers on Remote server?", [HOME, REMOTE]), "how many containers ?")
  assert.equal(withoutClusterWords("what GPUs does each cluster have", [HOME, REMOTE]), "what GPUs does have")
  assert.equal(aboutLine([REMOTE]), "Answering about Remote server (remote).")
  assert.equal(aboutLine([HOME, REMOTE]), "Answering about 2 clusters: Home cluster, Remote server.")
})

// ---------------------------------------------------------------------------
//  Reading requests to act
// ---------------------------------------------------------------------------

test("actions: read by code; questions, deploys and other talk are not actions", () => {
  assert.deepEqual(parseAction("restart plex on the remote"), { kind: "reboot", target: "plex on the remote", where: "restart plex on the remote" })
  assert.equal(parseAction("Please back up the remote now.")?.kind, "backup")
  assert.equal(parseAction("Can you stop gitea on Remote server?")?.kind, "stop")
  assert.equal(parseAction("snapshot plex as before-upgrade")?.snapName, "before-upgrade")
  assert.equal(parseAction("install monitoring on the remote")?.kind, "monitoring-install")
  assert.equal(parseAction("remove monitoring from Remote server")?.kind, "monitoring-remove")
  const c = parseAction("copy Movies to the remote")!
  assert.deepEqual([c.kind, c.target, c.copyTo, c.copyFrom], ["copy", "Movies", "the remote", undefined])
  assert.equal(parseAction("copy /srv/media/Movies from home to Remote server onto node node2")?.dstNode, "node2")
  for (const p of ["restart plex?", "Did last night's backup work?", "Deploy Uptime Kuma at status.example.com", "how is the remote server doing", "what is a snapshot"])
    assert.equal(parseAction(p), null, p)
  assert.equal(guestWords("the plex container on the remote now", [HOME, REMOTE]), "plex")
  assert.equal(guestWords("ct 201 on Remote server", [HOME, REMOTE]), "201")
})

test("actions: role and re-confirmation come from the route the same action has in the UI", () => {
  const g = { node: "node1", type: "lxc" as const, vmid: 201, name: "plex" }
  const route = (kind: ActionPlan["kind"]) => uiRouteFor({ kind, clusterId: R, guest: g })
  assert.equal(requiredRole("POST", route("reboot")), "operator")
  assert.equal(needsReconfirm("POST", route("reboot")), false)
  assert.equal(requiredRole("POST", route("backup")), "admin")
  assert.equal(needsReconfirm("POST", route("delete")), true)
  assert.equal(needsReconfirm("POST", route("monitoring-install")), true)
  assert.equal(needsReconfirm("POST", route("copy")), false)
  // The assistant's own routes stay admin, and only planning and applying accept a remote cluster.
  assert.equal(requiredRole("POST", "/api/ai/actions/apply"), "admin")
  assert.equal(requiredRole("POST", "/api/ai/wizard/plan"), "admin")
  assert.equal(remoteRouteAllowed("POST", "/api/ai/wizard/plan"), true)
  assert.equal(remoteRouteAllowed("POST", "/api/ai/actions/apply"), true)
  assert.equal(remoteRouteAllowed("POST", "/api/ai/wizard/execute"), false)
  assert.equal(remoteRouteAllowed("POST", "/api/ai/provider/select"), false)
  assert.equal(remoteRouteAllowed("GET", "/api/ai/wizard/jobs/x"), false)
})

// ---------------------------------------------------------------------------
//  A world of two (or three) clusters
// ---------------------------------------------------------------------------

interface Guest { vmid: number; node: string; type: "lxc" | "qemu"; name: string; status: string; digest: string; /** The config's own name; null: none (an unnamed VM). */ cfgName?: string | null }
type World = Record<string, { guests: Guest[]; gpu: string; measured: boolean; backupOk: boolean }>

function makeWorld(): World {
  return {
    [HOME_ID]: { gpu: "Arc A380", measured: true, backupOk: true, guests: [
      { vmid: 101, node: "node1", type: "lxc", name: "plex", status: "running", digest: "h101" },
      { vmid: 102, node: "node1", type: "lxc", name: "gitea", status: "running", digest: "h102" },
    ] },
    [R]: { gpu: "Radeon RX 6600", measured: false, backupOk: false, guests: [
      { vmid: 201, node: "node1", type: "lxc", name: "plex", status: "running", digest: "r201" },
      { vmid: 202, node: "node1", type: "qemu", name: "media-vm", status: "stopped", digest: "r202" },
    ] },
    [R2]: { gpu: "", measured: false, backupOk: true, guests: [] },
  }
}

/** A Proxmox that answers as whichever cluster the caller runs in: reading the wrong one shows in the answer. */
function fakePve(world: World) {
  return {
    async fetchStrict<T>(path: string): Promise<T> {
      const w = world[currentClusterId()]
      if (!w) throw new Error("no such cluster")
      if (path === "/cluster/resources" || path === "/cluster/resources?type=vm") {
        const nodes = path.endsWith("type=vm") ? [] : [{ type: "node", node: "node1", status: "online", maxcpu: 8, mem: 2 ** 31, maxmem: 2 ** 34 }]
        return [...nodes, ...w.guests.map(g => ({ type: g.type, vmid: g.vmid, node: g.node, name: g.name, status: g.status }))] as T
      }
      const cfg = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/config$/.exec(path)
      if (cfg) {
        const g = w.guests.find(x => x.vmid === Number(cfg[3]) && x.node === cfg[1])
        if (!g) throw new Error("HTTP 500: no such guest")
        return (g.cfgName === null ? { digest: g.digest } : { digest: g.digest, [g.type === "lxc" ? "hostname" : "name"]: g.cfgName ?? g.name }) as T
      }
      if (path === "/nodes") return [{ node: "node1", status: "online" }] as T
      if (/\/tasks\?typefilter=vzdump/.test(path)) return [] as T
      throw new Error(`unexpected ${path}`)
    },
  }
}

function panelFor(world: World, c: ClusterRef): ClusterPanel {
  const w = world[c.id]
  return {
    id: c.id, name: c.name, kind: c.kind, reachable: true, latencyMs: 5, nodes: { online: 1, total: 1 }, quorum: "standalone",
    guests: { running: w.guests.filter(g => g.status === "running").length, total: w.guests.length }, cpuPct: 10, memPct: 20, storagePct: 30,
    gpus: w.gpu ? [{ node: "node1", name: w.gpu, shortName: w.gpu, vendor: "x", kind: "dedicated", pci: null, load: w.measured ? 42 : null, vramUsed: null, vramTotal: null,
      memory: "dedicated", tempC: null, fanPct: null, freqMHz: null, powerW: null, state: w.measured ? "measured" : "not-monitored", stateNote: w.measured ? null : "not monitored",
      setupHref: null, capability: "HEVC decode", capabilityShort: "HEVC decode", capabilitySource: w.measured ? "vainfo" : "estimate" }] : [],
    gpuNote: null, lastBackup: { at: Date.now() - 3_600_000, ok: w.backupOk, node: "node1" },
    attention: w.backupOk ? [] : [{ clusterId: c.id, clusterName: c.name, kind: c.kind, severity: "warn", title: "The last backup did not finish cleanly", detail: "" }],
    monitoring: c.kind === "home",
  }
}

function sourceDeps(world: World): ClusterSourceDeps {
  return {
    inCluster: (id, fn) => runInCluster(id, fn),
    fetchStrict: (p) => fakePve(world).fetchStrict(p),
    // Like the real one: read in its own cluster's context, from whatever cluster the caller runs in.
    panel: async () => { const id = currentClusterId(); return panelFor(world, id === R ? REMOTE : id === R2 ? OTHER : HOME) },
    copies: async () => [
      { id: "j1", mode: "copy", srcCluster: HOME_ID, srcNode: "node1", srcPath: "/srv/media/Movies", dstCluster: R, dstNode: "node1", dstPath: "/srv/media",
        speedKBps: 0, plexScan: false, state: "running", preview: { files: 3 }, progress: {}, error: null, attempts: 1, createdBy: "a", createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null },
    ],
    scan: async () => ({ nodes: [], summary: "", note: null }),
    monitoring: id => (id === R ? {} : {}),
    nameOf: id => (id === R ? "Remote server" : id === HOME_ID ? "Home cluster" : "Office lab"),
  }
}

let unlocked = true, role: Role = "admin", reconfirmed = false
let world: World
const calls: Array<{ cluster: string; op: string; vmid: number; arg?: string }> = []
const audits: Array<{ action: string; resource: string; details: Record<string, unknown> }> = []
let copyInput: any = null
// The connection key each cluster has now (address, port, certificate, token): a test changes one to simulate a new token.
let conns: Record<string, string> = {}
let stores = [{ storage: "local" }]
let powerThrows = false
let plans: PreparedStore<ActionPlan>
let monitoringApplied: string | null = null

async function app(remotes: ClusterRef[] = [REMOTE]) {
  const store = new MemoryClusterStore()
  const row = (c: ClusterRef, fp: string | null) => ({ id: c.id, name: c.name, kind: c.kind, address: c.kind === "home" ? "" : "pve1.example", port: 8006, note: "",
    certFingerprint: fp, certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: ["/srv/media"], monitoring: {}, plexUrl: null, createdBy: "x" })
  await store.upsert(row(HOME, null))
  for (const r of remotes) await store.upsert(row(r, "AA"))
  setClusterStore(store); await loadClusters()
  const pve = fakePve(world)
  const f = Fastify()
  installClusterContext(f)
  const sd = sourceDeps(world)
  f.register(buildAiRoutes({
    whoami: () => "admin@example.com",
    session: () => ({ sid: "s1", role }),
    activeProvider: async () => "anthropic",
    listProviders: async () => [],
    saveModel: async () => {},
    facts: async () => JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8")),
    sources: () => [],
    askCall: () => never,
    clusterSources: (c) => c.kind === "remote" ? [...perClusterSources(c, sd), homeOnlySource(c)] : perClusterSources(c, sd),
    intent: async () => ({ template: "none", question: false, answer: "no" }),
    actionPlans: (plans = new PreparedStore<ActionPlan>()),
    prepareDeps: () => ({
      inCluster: (id, fn) => runInCluster(id, fn), pve: () => pve as any, row: clusterRow, unlocked: () => unlocked, connection: id => conns[id] ?? `k-${id}`,
      backupStorages: async () => stores,
      monitoringPreview: async (id) => ({ planId: `mon-${id}`, steps: ["node1: install node_exporter"] }),
      copyPreview: async (_o, input) => { copyInput = input; return { previewId: "pv1", words: "3 file(s), 1 GB." } },
      nodes: async () => ["node1"], now: () => new Date(Date.UTC(2026, 0, 2, 3, 4)),
    }),
    applyDeps: () => ({
      row: clusterRow, unlocked: () => unlocked, reconfirmed: () => reconfirmed, connection: id => conns[id] ?? `k-${id}`,
      inCluster: (id, fn) => runInCluster(id, fn), pve: () => pve as any,
      ops: {
        power: async (_p, g, a) => { if (powerThrows) throw new GuestActionRefusal("plex is locked by a backup.", "state"); calls.push({ cluster: currentClusterId(), op: a, vmid: g.vmid }); return { ok: true, words: "read back" } },
        snapshot: async (_p, g, n) => { calls.push({ cluster: currentClusterId(), op: "snapshot", vmid: g.vmid, arg: n }); return { ok: true, words: "listed" } },
        backupNow: async (_p, g, s) => { calls.push({ cluster: currentClusterId(), op: "backup", vmid: g.vmid, arg: s }); return { upid: "UPID:x", node: g.node } },
        destroy: async (_p, g, n) => { calls.push({ cluster: currentClusterId(), op: "delete", vmid: g.vmid, arg: n }); return { ok: true, words: "gone" } },
      },
      applyMonitoring: async (planId, _o, clusterId) => { monitoringApplied = `${planId}@${clusterId}`; return { ok: true, results: [{ node: "node1", status: "done", reason: "" }], checks: [] } },
      startCopy: async () => ({ id: "job1", state: "queued" }),
      audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    }),
  }), { prefix: "/api/ai" })
  const header = (cluster?: string) => (cluster ? { "x-hyperprox-cluster": cluster } : {})
  return {
    plan: async (prompt: string, cluster?: string) => (await f.inject({ method: "POST", url: "/api/ai/wizard/plan", headers: header(cluster), payload: { prompt } })),
    apply: async (body: Record<string, unknown>, cluster?: string) => f.inject({ method: "POST", url: "/api/ai/actions/apply", headers: header(cluster), payload: body }),
  }
}

beforeEach(() => {
  unlocked = true; role = "admin"; reconfirmed = false; world = makeWorld()
  calls.length = 0; audits.length = 0; copyInput = null; monitoringApplied = null; conns = {}; stores = [{ storage: "local" }]; powerThrows = false
})
afterEach(() => setClusterStore(new MemoryClusterStore()))

// ---------------------------------------------------------------------------
//  Reading, per cluster
// ---------------------------------------------------------------------------

test("read: a question about the remote is answered from the remote only, and says so", async () => {
  const a = await app()
  const r = (await a.plan("How many containers are there on Remote server?")).json()
  assert.equal(r.conversational, true)
  assert.match(r.message, /^Answering about Remote server \(remote\)\.\n/)
  assert.match(r.message, /You have 1 container, 1 running and 0 stopped\./)   // home has 2
  assert.deepEqual(r.clusters, [REMOTE])
  // The same question with the remote open, and nothing named: the remote, labelled.
  const open = (await a.plan("How many containers are there?", R)).json()
  assert.match(open.message, /^Answering about Remote server \(remote\)\.\nYou have 1 container/)
  // Home, open and asked about, keeps the old path: no label (and here, no sources).
  const home = (await a.plan("How many containers are there?")).json()
  assert.equal(home.conversational, true)
  assert.doesNotMatch(home.message, /Answering about/)
})

test("read: each cluster's facts are labelled with its own name and nothing crosses over", async () => {
  const a = await app()
  const r = (await a.plan("What GPUs does each cluster have?")).json()
  const lines = r.message.split("\n")
  assert.equal(lines[0], "Answering about 2 clusters: Home cluster, Remote server.")
  const home = lines.find((l: string) => l.startsWith("Home cluster: "))!, remote = lines.find((l: string) => l.startsWith("Remote server: "))!
  assert.match(home, /Arc A380.*load 42% \(measured\).*checked with vainfo/)
  assert.doesNotMatch(home, /Radeon/)
  assert.match(remote, /Radeon RX 6600.*load not measured \(not monitored\).*estimated from the model name/)
  assert.doesNotMatch(remote, /Arc A380/)
  const g = (await a.plan("How many guests does each cluster have?", R)).json()
  assert.match(g.message, /Home cluster: You have 2 guests: 2 containers and 0 VMs/)
  assert.match(g.message, /Remote server: You have 2 guests: 1 container and 1 VM/)
})

test("read: how is the remote doing, copies, and a home-only feature on a remote", async () => {
  const a = await app()
  const s = (await a.plan("How is the remote server doing?")).json()
  assert.match(s.message, /Answering about Remote server \(remote\)/)
  assert.match(s.message, /1 of 2 running.*Needs attention: The last backup did not finish cleanly/s)
  const c = (await a.plan("What copies are running on Remote server?")).json()
  assert.match(c.message, /Movies from Home cluster to Remote server: running, 3 files\./)
  const cert = (await a.plan("Which certificates expire soon?", R)).json()
  assert.match(cert.message, /only available on the home cluster, so I cannot answer that for Remote server/)
  const mon = (await a.plan("Is monitoring installed on the remote?")).json()
  assert.match(mon.message, /Monitoring is not installed on Remote server/)
})

test("read: an unknown cluster name or an ambiguous remote is asked about", async () => {
  const a = await app([REMOTE, OTHER])
  const u = (await a.plan("How is the Lab cluster doing?")).json()
  assert.match(u.message, /I do not know a cluster called "Lab"/)
  assert.deepEqual(u.choices.map((c: any) => c.label), ["Home cluster", "Remote server", "Office lab"])
  assert.deepEqual(u.choices.map((c: any) => c.cluster), [HOME_ID, R, R2])
  const amb = (await a.plan("How is the remote doing?")).json()
  assert.match(amb.message, /more than one remote cluster/)
})

test("read: deploying is home-only, from a remote or naming one", async () => {
  const a = await app()
  for (const [p, h] of [["Deploy Gitea", R], ["Deploy Gitea on the remote", undefined]] as const) {
    const r = (await a.plan(p, h)).json()
    assert.match(r.message, /Deploying a service is only available on the home cluster/)
  }
})

// ---------------------------------------------------------------------------
//  Acting, bound to one cluster
// ---------------------------------------------------------------------------

test("act: restart plex on the remote is prepared for the remote and applied there, read back and audited", async () => {
  const a = await app()
  const r = (await a.plan("restart plex on the remote")).json()
  assert.equal(r.conversational, false)
  assert.deepEqual(r.action.cluster, REMOTE)
  assert.equal(r.action.role, "operator")
  assert.equal(r.action.needsReconfirm, false)
  assert.match(r.action.title, /^Restart plex on Remote server$/)
  assert.match(r.action.steps[0], /plex \(CT 201 on node1\) on Remote server \(remote\)/)
  const done = await a.apply({ planId: r.action.planId }, R)
  assert.equal(done.statusCode, 200, done.body)
  assert.deepEqual(calls, [{ cluster: R, op: "reboot", vmid: 201 }])
  assert.deepEqual(done.json().cluster, REMOTE)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, "cluster.guest.power")
  assert.equal(audits[0].resource, `cluster:${R}`)
  assert.deepEqual(audits[0].details, { by: "admin@example.com", via: "assistant", node: "node1", guest: "lxc/201", ok: true, action: "reboot" })
  // Used once.
  assert.equal((await a.apply({ planId: r.action.planId }, R)).statusCode, 404)
})

test("act: a plan made on home is refused with a remote header, and the reverse; it is then used up", async () => {
  const a = await app()
  const home = (await a.plan("restart plex")).json()
  assert.deepEqual(home.action.cluster, HOME)
  const replay = await a.apply({ planId: home.action.planId }, R)
  assert.equal(replay.statusCode, 409)
  assert.equal(replay.json().code, "wrong_cluster")
  assert.match(replay.json().error, /prepared for Home cluster, but this request is for Remote server\. Nothing was done/)
  assert.equal((await a.apply({ planId: home.action.planId })).statusCode, 404)
  const remote = (await a.plan("restart plex", R)).json()
  assert.deepEqual(remote.action.cluster, REMOTE)
  const back = await a.apply({ planId: remote.action.planId })
  assert.equal(back.statusCode, 409)
  assert.equal(back.json().code, "wrong_cluster")
  assert.deepEqual(calls, [], "nothing ran on either cluster")
})

test("act: the browser cannot name the target, and a changed guest or connection refuses", async () => {
  const a = await app()
  const r = (await a.plan("restart plex on the remote")).json()
  for (const k of ["cluster", "guest", "vmid", "node", "plan"]) {
    const bad = await a.apply({ planId: r.action.planId, [k]: "x" }, R)
    assert.equal(bad.statusCode, 400, k)
  }
  world[R].guests[0].digest = "edited"
  const changed = await a.apply({ planId: r.action.planId }, R)
  assert.equal(changed.statusCode, 409)
  assert.match(changed.json().error, /settings changed since this was prepared/)
  const again = (await a.plan("restart plex on the remote")).json()
  setClusterStore(new MemoryClusterStore())
  const gone = await a.apply({ planId: again.action.planId }, R)
  assert.equal(gone.statusCode, 404, "the cluster was removed: the header itself is refused")
  assert.deepEqual(calls, [])
})

test("act: delete needs the master password again and the name typed; the plan waits for both", async () => {
  const a = await app()
  const r = (await a.plan("delete media-vm on Remote server")).json()
  assert.equal(r.action.needsReconfirm, true)
  assert.equal(r.action.typedName, "media-vm")
  assert.equal(r.action.role, "admin")
  const first = await a.apply({ planId: r.action.planId }, R)
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, "reconfirm_required")
  reconfirmed = true
  const unnamed = await a.apply({ planId: r.action.planId, confirmName: "media" }, R)
  assert.equal(unnamed.statusCode, 428)
  const ok = await a.apply({ planId: r.action.planId, confirmName: "media-vm" }, R)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(calls, [{ cluster: R, op: "delete", vmid: 202, arg: "media-vm" }])
  assert.equal(audits[0].action, "cluster.guest.delete")
  // A running guest is never offered for deletion.
  assert.match((await a.plan("delete plex on Remote server")).json().message, /is running\. Stop it first/)
})

test("act: locked vault prepares nothing and applies nothing", async () => {
  const a = await app()
  const r = (await a.plan("back up plex on the remote")).json()
  unlocked = false
  assert.match((await a.plan("restart plex on the remote")).json().message, /HyperProx is locked, so I did nothing/)
  const applied = await a.apply({ planId: r.action.planId }, R)
  assert.equal(applied.statusCode, 423)
  assert.deepEqual(calls, [])
})

test("act: never more than the signed-in role allows", async () => {
  const a = await app()
  role = "operator"
  assert.match((await a.plan("back up plex on the remote")).json().message, /needs the admin role, and you are signed in as operator, so I did not prepare it/)
  assert.match((await a.plan("delete media-vm on the remote")).json().message, /needs the admin role/)
  assert.match((await a.plan("install monitoring on the remote")).json().message, /needs the admin role/)
  role = "viewer"
  assert.match((await a.plan("restart plex on the remote")).json().message, /needs the operator role/)
  // Prepared as admin, applied after the role dropped: refused and used up.
  role = "admin"
  const r = (await a.plan("snapshot plex on the remote")).json()
  assert.match(r.action.steps[1], /named ai-20260102-0304/)
  role = "operator"
  const refused = await a.apply({ planId: r.action.planId }, R)
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().code, "forbidden")
  assert.deepEqual(calls, [])
})

test("act: back up now, monitoring and a copy go through the same functions, bound to their cluster", async () => {
  const a = await app()
  const b = (await a.plan("back up the remote now")).json()
  assert.match(b.message, /Which guest on Remote server should I back up\?/)
  // Choices name the guest by ID and carry the cluster: a name the remote chose never becomes the request.
  assert.deepEqual(b.choices[0], { label: "back up plex (201) on Remote server", prompt: "back up 201", cluster: R })
  const bk = (await a.plan("back up plex on Remote server")).json()
  assert.equal((await a.apply({ planId: bk.action.planId }, R)).statusCode, 200)
  assert.deepEqual(calls.at(-1), { cluster: R, op: "backup", vmid: 201, arg: "local" })

  const m = (await a.plan("install monitoring on the remote")).json()
  assert.equal(m.action.needsReconfirm, true)
  assert.equal((await a.apply({ planId: m.action.planId }, R)).json().code, "reconfirm_required")
  reconfirmed = true
  assert.equal((await a.apply({ planId: m.action.planId }, R)).statusCode, 200)
  assert.equal(monitoringApplied, `mon-${R}@${R}`)
  assert.equal(audits.at(-1)!.action, "cluster.monitoring.apply")
  assert.match((await a.plan("install monitoring on the home cluster")).json().message, /Setup checklist/)

  const c = (await a.plan("copy Movies to the remote")).json()
  assert.deepEqual(c.action.cluster, REMOTE)
  assert.deepEqual(c.action.from, HOME)
  assert.deepEqual(copyInput, { src: { cluster: HOME_ID, node: "node1", path: "/srv/media/Movies" }, dst: { cluster: R, node: "node1", path: "/srv/media" }, speedKBps: 0, plexScan: false })
  assert.equal((await a.apply({ planId: c.action.planId })).json().code, "wrong_cluster")
  const c2 = (await a.plan("copy Movies to the remote")).json()
  const started = await a.apply({ planId: c2.action.planId }, R)
  assert.equal(started.statusCode, 200)
  assert.equal(started.json().jobId, "job1")
})

test("act: ambiguous or unknown guests and clusters are asked about", async () => {
  const a = await app([REMOTE, OTHER])
  const which = (await a.plan("restart plex on the remote")).json()
  assert.match(which.message, /more than one remote cluster/)
  assert.deepEqual(which.choices.map((c: any) => [c.prompt, c.cluster]), [["restart plex on Remote server", R], ["restart plex on Office lab", R2]])
  assert.match((await a.plan("restart nosuch on Remote server")).json().message, /could not find a guest called "nosuch" on Remote server/)
  assert.match((await a.plan("start plex on Remote server")).json().message, /already running/)
})

test("monitoring: a preview made for one cluster is never applied through another", async () => {
  const store = new MemoryClusterStore()
  await store.upsert({ id: R, name: "Remote server", kind: "remote", address: "pve1.example", port: 8006, note: "", certFingerprint: "AA", certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { node1: "pve1.example" }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: "x" })
  setClusterStore(store); await loadClusters(); clearMonitoringPlans()
  setAuditSink({ write: async () => {} })
  const deps: MonitoringDeps = {
    nodes: async () => ["node1"], hasLogin: async () => true, reachable: async () => true,
    async run(_h, script) {
      if (script === SCAN_SCRIPT) return { code: 0, output: "listen=10.0.0.7\niface=tailscale0\npackage=absent\nservice=inactive\nlistening=\namd=no\nours=no\ninstalled_by_us=no" }
      return { code: 0, output: "HPX-RESULT\tdone\tlistening on 10.0.0.7:9100 only" }
    },
    metrics: async () => "node_exporter_build_info{} 1", writeTargets: () => {}, reload: async () => {}, up: async () => ({ node1: 1 }), sleep: async () => {},
  }
  const prev = await previewMonitoring(R, "owner@example.com", "install", { "server-metrics": true }, deps)
  await assert.rejects(applyMonitoring(prev.planId, "owner@example.com", deps, R2), MonitoringRefusal)
  const ok = await applyMonitoring(prev.planId, "owner@example.com", deps, R)
  assert.equal(ok.ok, true)
  setAuditSink(null)
})

// ---------------------------------------------------------------------------
//  The real-scenario inventory: test/scenarios/multi-cluster/*.yaml, each a prompt as a person would type it,
//  the cluster they had open, and what the assistant must answer or prepare. No model is called by any of them.
// ---------------------------------------------------------------------------

// js-yaml ships no types; only load() is used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require("js-yaml") as { load(src: string): unknown }

interface MultiScenario {
  id: string; prompt: string; open: "home" | "remote"; role?: Role; remotes?: number; found_by: string
  expect: { kind: "answer" | "action"; action?: string; cluster?: string; needs_reconfirm?: boolean; typed_name?: string; role?: Role; includes?: string[]; excludes?: string[]; choices?: string[] }
}

const SCENARIO_DIR = join(__dirname, "scenarios", "multi-cluster")
for (const file of readdirSync(SCENARIO_DIR).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const s = yaml.load(readFileSync(join(SCENARIO_DIR, file), "utf8")) as MultiScenario
  test(`scenario ${s.id}`, async () => {
    const a = await app(s.remotes === 2 ? [REMOTE, OTHER] : [REMOTE])
    if (s.role) role = s.role
    const r = (await a.plan(s.prompt, s.open === "remote" ? R : undefined)).json()
    assert.equal(r.ok, true, JSON.stringify(r))
    const e = s.expect
    if (e.kind === "action") {
      assert.equal(r.conversational, false, r.message)
      assert.equal(r.action.action, e.action)
      assert.equal(r.action.cluster.name, e.cluster)
      if (e.needs_reconfirm !== undefined) assert.equal(r.action.needsReconfirm, e.needs_reconfirm)
      if (e.role) assert.equal(r.action.role, e.role)
      if (e.typed_name !== undefined) assert.equal(r.action.typedName, e.typed_name)
    } else {
      assert.equal(r.conversational, true)
    }
    const text = r.action ? [r.action.title, r.action.words, ...r.action.steps].join("\n") : String(r.message)
    for (const want of e.includes ?? []) assert.ok(text.includes(want), `${s.id}: expected "${want}" in:\n${text}`)
    for (const not of e.excludes ?? []) assert.ok(!text.includes(not), `${s.id}: did not expect "${not}" in:\n${text}`)
    if (e.choices) assert.deepEqual(r.choices.map((c: any) => c.label), e.choices)
    assert.deepEqual(calls, [], "preparing never acts")
  })
}

// ---------------------------------------------------------------------------
//  Review fixes: each with its own regression test
// ---------------------------------------------------------------------------

test("C1: home's sources run in home's context even with a remote open", async () => {
  const probe = { id: "p", title: "P", blurb: "", aliases: /x/, load: async () => ({ headline: currentClusterId(), lines: [] }) }
  const [b] = boundTo(HOME_ID, [probe], (id, fn) => runInCluster(id, fn))
  const store = new MemoryClusterStore()
  await store.upsert({ id: R, name: "Remote server", kind: "remote", address: "pve1.example", port: 8006, note: "", certFingerprint: "AA", certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: "x" })
  setClusterStore(store); await loadClusters()
  assert.equal((await runInCluster(R, () => b.load())).headline, HOME_ID)
})

test("C1: a certificate inventory built while a remote was open is never served for home", async () => {
  const store = new MemoryClusterStore()
  await store.upsert({ id: R, name: "Remote server", kind: "remote", address: "pve1.example", port: 8006, note: "", certFingerprint: "AA", certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: "x" })
  setClusterStore(store); await loadClusters()
  const policy = { acme: { directoryUrl: "https://acme.test/directory", staging: false, email: "a@example.com", keyType: "ec256" }, schedule: { check: "15 6 * * *" },
    alerts: { warnFraction: 0.33, criticalDays: 7, webhookUrl: "" }, certificates: {}, probes: [], targets: {} } as any
  const svc = new CertsService({
    store: new MemoryCertsStore(), secrets: {} as any, log: () => undefined, dnsProviders: async () => [],
    deploy: {} as any,
    modules: { ...defaultModules, loadCertsPolicy: () => ({ loaded: true, path: "/t.yaml", policy }) as any,
      buildInventory: (async (d: any) => (await d.nodeCertificates()).map((n: any) => ({ names: [n.node], daysLeft: 30, notAfter: null, verdict: "ok", source: "node" }))) as any },
    sources: { npmCertificates: async () => [], npmHosts: async () => [], npmCertificateUsers: async () => [], deleteNpmCertificate: async () => undefined, npmLoginIsAdmin: async () => true,
      // Answers as whichever cluster it is read in, as livePve() did before the fix.
      nodeCertificates: async () => [{ node: currentClusterId() === R ? "remote-node" : "home-node", host: "h", certs: [] }] } as any,
  } as any)
  const fromRemote = await runInCluster(R, () => svc.overview(false))
  assert.deepEqual(fromRemote.inventory.map(e => e.names[0]), ["remote-node"])
  const fromHome = await svc.overview(false)
  assert.deepEqual(fromHome.inventory.map(e => e.names[0]), ["home-node"], "home's inventory is home's")
})

test("C2: an unnamed VM is confirmed by the name destroy() checks, and a wrong name keeps the plan", async () => {
  world[R].guests.push({ vmid: 203, node: "node1", type: "qemu", name: "VM 203", status: "stopped", digest: "r203", cfgName: null })
  const a = await app()
  const r = (await a.plan("delete 203 on Remote server")).json()
  assert.equal(r.action.typedName, "203")
  reconfirmed = true
  assert.equal((await a.apply({ planId: r.action.planId, confirmName: "VM 203" }, R)).statusCode, 428)
  const ok = await a.apply({ planId: r.action.planId, confirmName: "203" }, R)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(calls, [{ cluster: R, op: "delete", vmid: 203, arg: "203" }])
})

test("C3: a guest with a bad ID is never planned, and a plan holding one is refused; delete always re-confirms", async () => {
  world[R].guests.push({ vmid: 100.5, node: "node1", type: "qemu", name: "evil", status: "stopped", digest: "x" })
  const a = await app()
  assert.match((await a.plan("delete evil on Remote server")).json().message, /could not find a guest called "evil"/)
  // Fails closed either way: a delete always asks, and any other action on a bad guest cannot even build its route.
  assert.equal(reconfirmFor({ kind: "delete", clusterId: R, guest: { node: "node1", type: "qemu", vmid: 100.5, name: "evil" } }), true)
  assert.throws(() => reconfirmFor({ kind: "reboot", clusterId: R, guest: { node: "node1", type: "qemu", vmid: 100.5, name: "evil" } }))
  assert.equal(reconfirmFor({ kind: "delete", clusterId: R, guest: { node: "node1", type: "qemu", vmid: 202, name: "m" } }), true)
  assert.equal(reconfirmFor({ kind: "monitoring-remove", clusterId: R }), true)
  const id = plans.put("admin@example.com", { kind: "delete", owner: "admin@example.com", clusterId: R, clusterName: "Remote server", clusterKind: "remote",
    fingerprint: "AA", conn: `k-${R}`, guest: { node: "node1", type: "qemu", vmid: 100.5, name: "evil" }, digest: "x", confirmName: "evil" })
  reconfirmed = true
  const bad = await a.apply({ planId: id, confirmName: "evil" }, R)
  assert.equal(bad.statusCode, 422)
  assert.deepEqual(calls, [])
})

test("C4: every refusal and error on apply writes an audit entry with ok:false and its code, never a value", async () => {
  const a = await app()
  const codes = async (fn: () => Promise<unknown>) => { const before = audits.length; await fn(); return audits.slice(before).map(x => [x.action, x.details.ok, x.details.code, x.details.via]) }
  // wrong cluster
  let p = (await a.plan("restart plex on the remote")).json().action.planId
  assert.deepEqual(await codes(() => a.apply({ planId: p })), [["cluster.guest.power", false, "wrong_cluster", "assistant"]])
  // not found (used up)
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["assistant.apply", false, "not_found", "assistant"]])
  // connection changed (a new token)
  p = (await a.plan("restart plex on the remote")).json().action.planId
  conns[R] = "new-token"
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["cluster.guest.power", false, "cluster_changed", "assistant"]])
  conns = {}
  // digest changed
  p = (await a.plan("restart plex on the remote")).json().action.planId
  world[R].guests[0].digest = "edited"
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["cluster.guest.power", false, "changed", "assistant"]])
  world[R].guests[0].digest = "r201"
  // forbidden
  p = (await a.plan("snapshot plex on the remote")).json().action.planId
  role = "operator"
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["cluster.guest.snapshot", false, "forbidden", "assistant"]])
  role = "admin"
  // re-confirm, then typed name
  p = (await a.plan("delete media-vm on the remote")).json().action.planId
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["cluster.guest.delete", false, "reconfirm_required", "assistant"]])
  reconfirmed = true
  assert.deepEqual(await codes(() => a.apply({ planId: p, confirmName: "nope" }, R)), [["cluster.guest.delete", false, "confirm", "assistant"]])
  // an error thrown by the action itself
  p = (await a.plan("restart plex on the remote")).json().action.planId
  powerThrows = true
  const thrown = await a.apply({ planId: p }, R)
  assert.equal(thrown.statusCode, 422)
  assert.deepEqual(audits.at(-1)!.details, { by: "admin@example.com", via: "assistant", ok: false, code: "state", action: "reboot", node: "node1", guest: "lxc/201" })
  // locked
  unlocked = false
  assert.deepEqual(await codes(() => a.apply({ planId: p }, R)), [["assistant.apply", false, "locked", "assistant"]])
  assert.deepEqual(calls, [])
})

test("C4: a copy started by the assistant is audited with via: assistant, and starts at once", async () => {
  const store = new MemoryClusterStore()
  await store.upsert({ id: R, name: "Remote server", kind: "remote", address: "pve1.example", port: 8006, note: "", certFingerprint: "AA", certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: ["/srv/media"], monitoring: {}, plexUrl: null, createdBy: "x" })
  setClusterStore(store); await loadClusters(); setJobStore(new MemoryJobStore())
  const seen: any[] = []
  setAuditSink({ write: async r => { seen.push(r) } })
  const runner = { async run(_c: string, _n: string, script: string) {
    if (script.includes("rsync -a --dry-run --stats")) return { code: 0, output: "Number of files: 3 (reg: 2, dir: 1)\nNumber of regular files transferred: 1\nTotal transferred file size: 2,048 bytes\n" }
    return { code: 0, output: "OK /srv/media/x\n" }
  }, async sshAddress() { return "10.0.0.9" } } as any
  const prev = await previewCopy("owner@example.com", { src: { cluster: R, node: "node1", path: "/srv/media/A" }, dst: { cluster: R, node: "node1", path: "/srv/media/B" }, speedKBps: 0, plexScan: false }, runner)
  await startCopy(prev.previewId, "owner@example.com", "assistant")
  assert.equal(seen.at(-1).action, "cluster.files.copy")
  assert.equal(seen.at(-1).details.via, "assistant")
  let kicked = 0
  setCopyKick(() => { kicked++ }); kickCopies(); setCopyKick(null)
  assert.equal(kicked, 1)
  setAuditSink(null)
})

test("P1: a hostile guest name never becomes the request a choice sends", async () => {
  world[R].guests.push({ vmid: 204, node: "node1", type: "lxc", name: "plex. x", status: "running", digest: "r204" })
  const a = await app()
  const b = (await a.plan("back up the remote now")).json()
  assert.ok(b.choices.every((c: any) => /^back up \d+$/.test(c.prompt) && c.cluster === R), JSON.stringify(b.choices))
  // The chip, sent as the browser sends it (with its cluster), acts on that guest on that cluster only.
  const r = (await a.plan("back up 204", R)).json()
  assert.deepEqual(r.action.cluster, REMOTE)
  assert.match(r.action.steps[0], /CT 204/)
})

test("P2: reserved and duplicate names are refused; an old remote called Home never captures the word", async () => {
  const store = new MemoryClusterStore()
  const row = (id: string, name: string) => ({ id, name, kind: "remote" as const, address: `${id}.example`, port: 8006, note: "", certFingerprint: "AA", certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: "x" })
  await store.upsert(row(R, "Home"))           // saved before the rule
  await store.upsert(row(R2, "Office lab"))
  setClusterStore(store); await loadClusters()
  await assert.rejects(updateCluster(R2, { name: "remote" }), /assistant reads it as a word/)
  await assert.rejects(updateCluster(R2, { name: "ALL" }), /assistant reads it as a word/)
  await assert.rejects(updateCluster(R2, { name: "home cluster" }), /already called/)
  await updateCluster(R, { note: "kept" })      // an old name is not broken by an unrelated edit
  const list = [HOME, { id: R, name: "Home", kind: "remote" as const }, OTHER]
  assert.deepEqual((resolveTargets("restart plex on home", list, OTHER) as any).clusters, [HOME])
})

test("P3: a delete is refused when the HA list cannot be read", async () => {
  let deleted = false
  const pve = {
    async fetchStrict(path: string, method?: string) {
      if (path.endsWith("/config")) return { name: "m" }
      if (path.endsWith("/status/current")) return { status: "stopped", name: "m" }
      if (path === "/cluster/ha/resources") throw new Error("HTTP 500")
      if (method === "DELETE") { deleted = true; return "UPID:x" }
      return []
    },
  } as any
  await assert.rejects(destroy({ pve }, { node: "node1", type: "qemu", vmid: 202 }, "m"), /could not read the HA list/)
  assert.equal(deleted, false)
})

test("P4: a partial guest match or an unnamed storage is asked about, never picked", async () => {
  world[R].guests = [{ vmid: 205, node: "node1", type: "lxc", name: "plex-old", status: "running", digest: "a" },
    { vmid: 206, node: "node1", type: "lxc", name: "local-vm", status: "running", digest: "b" }]
  const a = await app()
  const stop = (await a.plan("stop plex on Remote server")).json()
  assert.equal(stop.conversational, true)
  assert.match(stop.message, /No guest on Remote server is called exactly "plex"/)
  assert.deepEqual(stop.choices.map((c: any) => c.prompt), ["stop 205"])
  stores = [{ storage: "local" }, { storage: "pbs" }]
  const bk = (await a.plan("back up local-vm on Remote server")).json()
  assert.match(bk.message, /Which storage/)
  assert.deepEqual(bk.choices.map((c: any) => c.prompt), ["back up 206 to storage local", "back up 206 to storage pbs"])
  const named = (await a.plan("back up 206 to storage pbs", R)).json()
  assert.ok(named.action, named.message)
  assert.match(named.action.words, /backup to pbs/)
  assert.deepEqual(calls, [])
})
