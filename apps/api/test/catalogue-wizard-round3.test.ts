// Review round: GPU names, ID-to-address reasons, ambiguous node digits.
import { test } from "node:test"
import assert from "node:assert/strict"
import { pciGpus, reverseVmid, octetFromDigits } from "../src/lib/wizard-placement"

const vga = (vendor: string, device_name: string) => ({ class: "0x030000", vendor, device_name })

test("GPU: AMD APU names with a numeral suffix, and older APU names, are integrated", () => {
  for (const name of ["Phoenix1", "Phoenix3", "Raven2", "Kabini [Radeon HD 8330]", "Mullins [Radeon R4/R5 Graphics]",
    "Beema", "Trinity [Radeon HD 7660D]", "Richland [Radeon HD 8650G]", "Wrestler [Radeon HD 6310]", "Hawk Point1"]) {
    assert.deepEqual(pciGpus([vga("0x1002", name)]), { discrete: false, integrated: true }, name)
  }
  assert.deepEqual(pciGpus([vga("0x1002", "Navi 31 [Radeon RX 7900 XTX]")]), { discrete: true, integrated: false })
})

test("GPU: Intel Arc is a discrete card; other Intel graphics are integrated", () => {
  assert.deepEqual(pciGpus([vga("0x8086", "DG2 [Arc A380]")]), { discrete: true, integrated: false })
  assert.deepEqual(pciGpus([vga("0x8086", "Battlemage G21 [Arc B580]")]), { discrete: true, integrated: false })
  assert.deepEqual(pciGpus([vga("0x8086", "Alder Lake-S GT1 [UHD Graphics 730]")]), { discrete: false, integrated: true })
  assert.deepEqual(pciGpus([vga("0x8086", "Meteor Lake-P [Intel Arc Graphics]")]), { discrete: false, integrated: true },
    "Arc-branded graphics inside a CPU are integrated")
})

test("ID to address: built on the bridge's own address, and over 255 says so", () => {
  assert.deepEqual(octetFromDigits("192.0.2.205", "42", 2), { ip: "192.0.2.242" })
  assert.deepEqual(octetFromDigits("192.0.2.10", "42", 2), { ip: "192.0.2.42" })
  assert.match((octetFromDigits("192.0.2.250", "60", 2) as any).error, /260.*over 255/)
  assert.match((octetFromDigits("192.0.2.1", "300", 3) as any).error, /300.*over 255/)
})

test("ambiguous node digits: every node that fits is returned, and none is picked for the person", () => {
  const r = reverseVmid("{node_digit}{ip_last2}", 342, ["node-3", "edge3", "node-4"]) as any
  assert.deepEqual(r.nodes, ["node-3", "edge3"])
  assert.equal(r.node, undefined)
  const one = reverseVmid("{node_digit}{ip_last2}", 442, ["node-3", "edge3", "node-4"]) as any
  assert.equal(one.node, "node-4")
  assert.deepEqual(one.nodes, ["node-4"])
})

// ── Installer and routes ────────────────────────────────────────────────────
import Fastify from "fastify"
import {
  previewInstall, applyPreview, removeFailedInstall, restoreWizardState, cleanupCandidates, getInstallJob, isCreating,
  checkPlan, readCluster, clearIdentityCache, swapCeiling, PREVIEW_CAP, type InstallJob,
} from "../src/lib/catalogue-installer"
import { setWizardStore, MemoryWizardStore } from "../src/lib/catalogue-store"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import { findRecipe } from "../src/lib/catalogue"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

const fresh = () => { const s = new MemoryWizardStore(); setWizardStore(s); clearIdentityCache(); return s }
const failInstall = { exec: async () => ({ code: 1, output: "", timedOut: false }) as any }

test("clean-up deletes with purge=1 only, never destroy-unreferenced-disks", async () => {
  fresh()
  const f = new FakePve(), d = deps(f, failInstall)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  await removeFailedInstall(job.jobId, "a@example.com", d)
  assert.deepEqual(f.deletePaths, ["/nodes/node-a/lxc/102?purge=1"])
})

test("clean-up refuses when the HA state cannot be read", async () => {
  fresh()
  const f = new FakePve(), d = deps(f, failInstall)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  f.failing.add("/cluster/ha/resources")
  await assert.rejects(removeFailedInstall(job.jobId, "a@example.com", d), /could not confirm whether CT 102 is under HA/)
  assert.deepEqual(f.deletes, [])
})

test("address: a failed live read and an agentless VM are unknown; without the tick a static IP is refused", async () => {
  fresh()
  const f = new FakePve()
  f.failing.add("/nodes/node-a/lxc/100/interfaces")
  f.configs[101].agent = "0"
  const r = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.equal(r.preview, undefined)
  const all = r.errors.join(" ")
  assert.match(all, /could not be asked which address they hold: 100 \(web, read failed\), 101 \(gpu-vm, no guest agent\)/)
  assert.match(all, /tick "I checked this address"/)

  const ok = await previewInstall(INPUT({ addressAck: true } as any), "a@example.com", deps(f))
  assert.ok(ok.preview)
  assert.equal(ok.preview!.plan.addressAck, true)
  assert.ok(!ok.checks.some(c => /^No running guest reports/.test(c)), "never claims what was not read")
  assert.ok(ok.checks.some(c => /none reports 192\.0\.2\.50; 2 could not be asked/.test(c)))
  assert.match(ok.warnings.join(" "), /You confirmed you checked 192\.0\.2\.50 yourself/)
})

test("address: the unread live sources are named in partial", async () => {
  const f = new FakePve()
  f.failing.add("/nodes/node-a/lxc/100/interfaces")
  const { identityView } = await import("../src/lib/catalogue-installer")
  clearIdentityCache()
  const { view } = await identityView("k", true, deps(f))
  assert.ok(view.partial.includes("live:100"))
})

test("address: with the node list unreadable, node addresses are unknown and need the tick", async () => {
  fresh()
  const f = new FakePve()
  f.failing.add("/cluster/status")
  const r = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.equal(r.preview, undefined)
  assert.match(r.errors.join(" "), /nodes' own addresses could not be read/)
  const ok = await previewInstall(INPUT({ addressAck: true } as any), "a@example.com", deps(f))
  assert.ok(ok.checks.some(c => /nodes' own addresses could not be read/.test(c)))
  assert.ok(!ok.checks.some(c => /is no node's address/.test(c)))
  const dhcp = await previewInstall(INPUT({ ip: "dhcp", gateway: undefined }), "a@example.com", deps(f))
  assert.ok(dhcp.preview, "DHCP needs no address proof")
})

test("apply refuses a recipe that needs a GPU on a node with none, as placement does", async () => {
  const f = new FakePve()
  const view = await readCluster(f.client, async () => true)
  const r = checkPlan(INPUT(), { ...findRecipe("uptime-kuma")!, needsGpu: true }, view, { seen: [], unknown: [] }, false)
  assert.match(r.errors.join(" "), /needs a GPU and node-a has none/)
})

test("swap is capped at twice the RAM and 8 GB; open previews are capped", async () => {
  assert.equal(swapCeiling(512), 1024)
  assert.equal(swapCeiling(16384), 8192)
  fresh()
  const f = new FakePve()
  const r = await previewInstall(INPUT({ swapMb: 2048 }), "a@example.com", deps(f))
  assert.match(r.errors.join(" "), /Swap can be at most 1024 MB/)
  const s = fresh()
  for (let i = 0; i < PREVIEW_CAP; i++) await s.put({ id: `p${i}`, kind: "preview", owner: "x", data: {}, expiresAt: new Date(Date.now() + 60_000) })
  const full = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.match(full.errors.join(" "), /already 200 open install previews/)
})

test("the ID stays held until the whole job settles, not just the create", async () => {
  fresh()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const f = new FakePve()
  const d = deps(f, { exec: async () => { await gate; return { code: 0, output: "", timedOut: false } as any } })
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await applyPreview(preview!.id, "a@example.com", d)
  for (let i = 0; i < 200 && f.creates.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(f.creates.length, 1)
  assert.equal(isCreating(102), true, "held while the install runs")
  release()
  await settled(job.jobId)
  assert.equal(isCreating(102), false)
})

test("persistence: previews survive in the store; a job mid-install at restart is interrupted and offered for clean-up", async () => {
  const s = fresh()
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  assert.equal((await s.get(preview!.id))!.kind, "preview")

  // A job the store says was running, with its create mark: as if the API died mid-install.
  const job: InstallJob = {
    jobId: "11111111-1111-4111-8111-111111111111", owner: "a@example.com", recipeId: "uptime-kuma", status: "running",
    log: "", vmid: 102, node: "node-a", startedAt: Date.now(),
    steps: [{ id: "container", label: "Create", status: "done" }, { id: "install", label: "Install", status: "running" }],
  }
  await s.put({ id: job.jobId, kind: "job", owner: job.owner, data: job, expiresAt: new Date(Date.now() + 3600_000) })
  await s.put({ id: "creating:102", kind: "creating", owner: job.owner, data: { jobId: job.jobId, vmid: 102, node: "node-a" }, expiresAt: null })
  await s.put({ id: "old-preview", kind: "preview", owner: "x", data: {}, expiresAt: new Date(Date.now() - 1000) })

  const r = await restoreWizardState()
  assert.equal(r.interrupted, 1)
  const back = getInstallJob(job.jobId)!
  assert.equal(back.status, "interrupted")
  assert.equal(back.created, true, "the create mark says a container may exist")
  assert.equal(back.steps[1].status, "failed")
  assert.ok(cleanupCandidates("a@example.com").some(j => j.jobId === job.jobId))
  assert.deepEqual(cleanupCandidates("nobody@example.com"), [])
  assert.equal(await s.get("creating:102"), null, "no ID is being created after a restart")
  assert.equal(await s.get("old-preview"), null, "expired previews are pruned")

  // The same mark checks decide the clean-up: the fake's CT 102 does not exist, so nothing is deleted.
  assert.match(await removeFailedInstall(job.jobId, "a@example.com", d), /no longer exists/)
  assert.equal((await s.get(job.jobId))!.data.removed, true)
})

test("routes: the identity check reuses one read for ~10 s and pings only when asked", async () => {
  fresh()
  const f = new FakePve()
  let pings = 0
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: deps(f, { ping: async () => { pings++; return false } }) }))
  const ask = (extra = {}) => a.inject({ method: "POST", url: "/wizard/identity", payload: { node: "node-a", ip: "192.0.2.50/24", ...extra } })
  await ask(); await ask(); await ask()
  assert.equal(f.reads.get("/nodes"), 1, "three keystrokes, one cluster read")
  assert.equal(pings, 0, "typing never pings")
  const checked = await ask({ ping: true })
  assert.equal(pings, 1)
  assert.equal(checked.json().data.ip.pinged, false)
  const list = await a.inject({ method: "GET", url: "/wizard/jobs" })
  assert.equal(list.statusCode, 200)
})

test("routes: ambiguous node digits list every node and pick none", async () => {
  fresh()
  const f = new FakePve()
  const orig = f.answer.bind(f)
  f.answer = async (p: string, m: string, b?: string) => p === "/nodes"
    ? [{ node: "node-1", status: "online", maxcpu: 8, maxmem: 32 * 1024 ** 3, mem: 0 }, { node: "edge1", status: "online", maxcpu: 8, maxmem: 32 * 1024 ** 3, mem: 0 }]
    : orig(p, m, b)
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => "a@example.com", wizard: deps(f, { readRule: async () => ({ kind: "pattern", pattern: "{node_digit}{ip_last2}" }) }) }))
  const r = await a.inject({ method: "POST", url: "/wizard/identity", payload: { node: "node-1", vmid: 142 } })
  const rev = r.json().data.reverse
  assert.deepEqual(rev.nodes, ["node-1", "edge1"])
  assert.equal(rev.node, undefined)
  assert.match(rev.problem, /fits more than one node/)
})
