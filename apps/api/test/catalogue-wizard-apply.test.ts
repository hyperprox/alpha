// The install wizard's preview/apply contract against a fake Proxmox: a server-held plan, an apply that takes
// only its id and checks everything again, and a clean-up that removes only what the wizard made.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { buildCatalogueRoutes } from "../src/routes/catalogue"
import {
  previewInstall, applyPreview, removeFailedInstall, readCluster, placementFor, checkIdentity,
  createFromPlan, installMark, planNet0, PREVIEW_TTL_MS, type WizardDeps,
} from "../src/lib/catalogue-installer"
import { FakePve, deps, INPUT, settled, GB, TMPL } from "./fakes/catalogue-pve"
import { findRecipe } from "../src/lib/catalogue"
import { requiredRole, needsReconfirm } from "../src/lib/roles"

// ── Preview ─────────────────────────────────────────────────────────────────

test("preview: holds the full plan server-side, with the template resolved, and creates nothing", async () => {
  const f = new FakePve()
  const r = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.deepEqual(r.errors, [])
  assert.ok(r.preview)
  assert.deepEqual(r.preview!.plan, {
    recipeId: "uptime-kuma", node: "node-a", vmid: 102, hostname: "uptime-kuma", cores: 1, memoryMb: 512, swapMb: 512,
    diskGb: 8, storage: "pool", bridge: "vmbr0", ip: "192.0.2.50/24", gateway: "192.0.2.1", dns: "192.0.2.53",
    template: TMPL, unprivileged: true,
  })
  assert.ok(r.checks.some(c => /ID 102 is not used/.test(c)))
  assert.ok(r.checks.some(c => /Nothing answered a ping/.test(c)))
  assert.equal(f.creates.length, 0)
})

test("preview: refuses a taken ID (VMs count too), an address in use, an offline node and a bad hostname", async () => {
  const f = new FakePve()
  const no = async (o: Partial<WizardInput>, re: RegExp, d = deps(f)) => {
    const r = await previewInstall(INPUT(o), "a@example.com", d)
    assert.equal(r.preview, undefined)
    assert.match(r.errors.join(" | "), re)
  }
  await no({ vmid: 101 }, /ID 101 is already used by another guest \(CT or VM\)\. 102 is free/)
  await no({ ip: "192.0.2.21/24" }, /set in the config of guest 100 \(web\)/)
  await no({ ip: "192.0.2.11/24" }, /address of node node-b/)
  await no({ ip: "192.0.2.60/24" }, /already answers on 192\.0\.2\.60/, deps(f, { ping: async () => true }))
  await no({ ip: "198.51.100.5/24" }, /not on the 198\.51\.100\.5\/24 network/)
  await no({ node: "node-c" }, /node-c is not online/)
  await no({ hostname: "Bad_Name" }, /not a usable hostname/)
  await no({ hostname: "web" }, /already the name of guest 100/)
  await no({ memoryMb: 200 * 1024 }, /RAM free; this needs/)
  await no({ ip: "dhcp" }, /gateway is set with DHCP/)
  assert.equal(f.creates.length, 0)
})

test("preview: below the recipe's minimum is a warning, not a refusal", async () => {
  const r = await previewInstall(INPUT({ memoryMb: 256 }), "a@example.com", deps(new FakePve()))
  assert.ok(r.preview)
  assert.match(r.warnings.join(" "), /256 MB RAM is below the 512 MB Uptime Kuma needs/)
})

test("preview: with no Debian or Ubuntu template it offers a download, and with none on offer it refuses", async () => {
  const f = new FakePve()
  f.templates = ["local:vztmpl/alpine-3.20-default_20240908_amd64.tar.xz"]
  f.offered = [{ template: "debian-13-standard_13.1-2_amd64.tar.zst" }]
  const r = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.equal(r.preview!.plan.template, "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst")
  assert.equal(r.preview!.plan.downloadTemplate, true)
  f.offered = []
  const none = await previewInstall(INPUT(), "a@example.com", deps(f))
  assert.equal(none.preview, undefined)
  assert.match(none.errors.join(" "), /No Debian or Ubuntu template on node-a/)
})

// ── Apply ───────────────────────────────────────────────────────────────────

test("apply: creates exactly the preview, unprivileged, through the API, then installs and checks it answers", async () => {
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed", job.error)
  assert.equal(f.creates.length, 1)
  const b = f.creates[0].body
  assert.equal(f.creates[0].node, "node-a")
  assert.deepEqual(
    ["vmid", "hostname", "ostemplate", "rootfs", "memory", "swap", "cores", "net0", "nameserver", "unprivileged", "features", "onboot"].map(k => b.get(k)),
    ["102", "uptime-kuma", TMPL, "pool:8", "512", "512", "1", "name=eth0,bridge=vmbr0,ip=192.0.2.50/24,gw=192.0.2.1,firewall=1", "192.0.2.53", "1", "nesting=1", "1"])
  assert.match(b.get("description")!, new RegExp(installMark(job.jobId)))
  assert.equal(job.ip, "192.0.2.50")
  assert.equal(job.url, "http://192.0.2.50:3001")
  assert.equal(job.steps.find(s => s.id === "verify")!.status, "done")
})

test("apply: refused, and nothing created, when the ID was taken between preview and apply", async () => {
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  f.guests.push({ vmid: 102, type: "qemu", node: "node-b", name: "someone-else", status: "stopped" })
  await assert.rejects(applyPreview(preview!.id, "a@example.com", d), (e: any) => {
    assert.equal(e.code, "changed")
    assert.match(e.problems.join(" "), /ID 102 is already used/)
    return true
  })
  assert.equal(f.creates.length, 0)
})

test("apply: refused when the address was taken in between, by a config or by a running guest", async () => {
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  f.live[100] = [{ name: "eth0", inet: "192.0.2.21/24" }, { name: "eth1", inet: "192.0.2.50/24" }]
  await assert.rejects(applyPreview(preview!.id, "a@example.com", d), /changed since the preview/)
  assert.equal(f.creates.length, 0)
})

test("apply: one use only, owner only, and not after it expires", async () => {
  const f = new FakePve()
  let now = 1_000_000
  const d = deps(f, { now: () => now })
  const p1 = (await previewInstall(INPUT(), "a@example.com", d)).preview!
  await assert.rejects(applyPreview(p1.id, "b@example.com", d), (e: any) => e.code === "not-found")
  await assert.rejects(applyPreview("not-an-id", "a@example.com", d), (e: any) => e.code === "not-found")
  await settled((await applyPreview(p1.id, "a@example.com", d)).jobId)
  await assert.rejects(applyPreview(p1.id, "a@example.com", d), (e: any) => e.code === "used")
  const p2 = (await previewInstall(INPUT({ vmid: 103, hostname: "kuma-two", ip: "dhcp", gateway: undefined }), "a@example.com", d)).preview!
  now += PREVIEW_TTL_MS + 1
  await assert.rejects(applyPreview(p2.id, "a@example.com", d), (e: any) => e.code === "expired")
})

// ── Clean-up ────────────────────────────────────────────────────────────────

test("clean-up: removes the container a failed install made, after checking its mark", async () => {
  const f = new FakePve(), d = deps(f, { exec: async () => ({ code: 1, output: "boom", timedOut: false }) as any })
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "failed")
  assert.equal(job.created, true)
  await assert.rejects(removeFailedInstall(job.jobId, "b@example.com", d), (e: any) => e.code === "not-found")
  assert.match(await removeFailedInstall(job.jobId, "a@example.com", d), /CT 102 was removed/)
  assert.deepEqual([f.stops, f.deletes], [["102"], ["102"]])
  await assert.rejects(removeFailedInstall(job.jobId, "a@example.com", d), (e: any) => e.code === "used")
})

test("clean-up: refuses a container without this install's mark, one under HA, and a job that created nothing", async () => {
  const f = new FakePve(), d = deps(f, { exec: async () => ({ code: 1, output: "", timedOut: false }) as any })
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  f.configs[102].description = "someone else's container"
  await assert.rejects(removeFailedInstall(job.jobId, "a@example.com", d), /does not carry this install's mark/)
  f.configs[102].description = installMark(job.jobId)
  f.ha = [{ sid: "ct:102" }]
  await assert.rejects(removeFailedInstall(job.jobId, "a@example.com", d), /managed by HA/)
  assert.deepEqual(f.deletes, [])

  const g = new FakePve(), e = deps(g)
  g.createFails = true
  const p = (await previewInstall(INPUT(), "a@example.com", e)).preview!
  const failed = await settled((await applyPreview(p.id, "a@example.com", e)).jobId)
  assert.equal(failed.status, "failed")
  g.configs[102] = { description: "not ours" }
  await assert.rejects(removeFailedInstall(failed.jobId, "a@example.com", e), /does not carry this install's mark/)
  g.guests = g.guests.filter(x => x.vmid !== 102)
  assert.match(await removeFailedInstall(failed.jobId, "a@example.com", e), /no longer exists/)
  assert.deepEqual(g.deletes, [])
})

test("create: DHCP plans send ip=dhcp and no gateway; no DNS means no nameserver", async () => {
  assert.equal(planNet0({ bridge: "vmbr1", ip: "dhcp" }), "name=eth0,bridge=vmbr1,ip=dhcp,firewall=1")
  const f = new FakePve()
  await createFromPlan({ ...INPUT({ ip: "dhcp", gateway: undefined, dns: undefined }), template: TMPL, unprivileged: true },
    findRecipe("gitea")!, "job-1", f.client)
  assert.equal(f.creates[0].body.get("nameserver"), null)
  assert.equal(f.creates[0].body.get("unprivileged"), "1")
})

// ── Placement and identity on the same fake ─────────────────────────────────

test("placement: reads the cluster, passes over the GPU node and the offline one, and says why", async () => {
  const f = new FakePve()
  const view = await readCluster(f.client, async () => true)
  const b = view.nodes.find(n => n.node === "node-b")!
  assert.equal(b.hasGpu, true)
  assert.match(b.gpuSource!, /guest 101/)
  const p = placementFor(findRecipe("uptime-kuma")!, { cores: 1, memoryMb: 512, diskGb: 8 }, view)
  assert.equal(p.recommendation!.node, "node-a")
  assert.match(p.recommendation!.reason, /^node-a: .*shared storage \(pool\).*keeps the GPU node free/)
  assert.deepEqual(p.nodes.find(n => n.node === "node-c")!.verdict.why, ["offline"])
  assert.deepEqual(p.nodes.find(n => n.node === "node-a")!.rootStorages.map(s => s.storage), ["pool"])
})

test("identity: next free ID by default; with the pattern rule, the node and address give the ID and back", async () => {
  const f = new FakePve()
  const view = await readCluster(f.client, async () => true)
  const none = async () => null
  const L = { seen: [], unknown: [] }
  assert.equal((await checkIdentity({ node: "node-a" }, view, { kind: "next-free" }, L, none)).suggestedVmid, 102)
  const rule = { kind: "pattern" as const, pattern: "9{ip_last3}" }
  const fwd = await checkIdentity({ node: "node-a", ip: "192.0.2.50/24" }, view, rule, L, none)
  assert.deepEqual([fwd.suggestedVmid, fwd.derived], [9050, { vmid: 9050, taken: false }])
  const back = await checkIdentity({ node: "node-a", vmid: 9077 }, view, rule, L, none)
  assert.deepEqual(back.reverse, { ip: "192.0.2.77/24" })
  view.guests.push({ vmid: 9050, node: "node-a", type: "lxc", name: "x", status: "stopped", config: null })
  const taken = await checkIdentity({ node: "node-a", ip: "192.0.2.50/24" }, view, rule, L, none)
  assert.match(taken.derived!.problem!, /gives 9050, which another guest already has/)
  assert.equal(taken.suggestedVmid, 102, "a taken derived ID is not suggested")
})

// ── Routes ──────────────────────────────────────────────────────────────────

function app(f: FakePve, who = "a@example.com", over: Partial<WizardDeps> = {}) {
  const a = Fastify()
  a.register(buildCatalogueRoutes({ whoami: () => who, wizard: deps(f, over) }))
  return a
}

test("routes: apply takes only a preview id; a changed cluster is a 409 with the reasons", async () => {
  const f = new FakePve(), a = app(f)
  const pv = await a.inject({ method: "POST", url: "/wizard/preview", payload: INPUT() })
  assert.equal(pv.statusCode, 200, pv.body)
  const { previewId, plan } = pv.json().data
  assert.equal(plan.unprivileged, true)
  const smuggled = await a.inject({ method: "POST", url: "/wizard/apply", payload: { previewId, node: "node-b" } })
  assert.equal(smuggled.statusCode, 400)
  assert.match(smuggled.json().error, /only previewId/)
  f.guests.push({ vmid: 102, type: "lxc", node: "node-b", name: "late", status: "stopped" })
  const r = await a.inject({ method: "POST", url: "/wizard/apply", payload: { previewId } })
  assert.equal(r.statusCode, 409)
  assert.match(r.json().problems.join(" "), /ID 102 is already used/)
  assert.equal(f.creates.length, 0)
})

test("routes: a bad plan is a 422 with every problem; placement and identity answer", async () => {
  const f = new FakePve(), a = app(f)
  const bad = await a.inject({ method: "POST", url: "/wizard/preview", payload: INPUT({ vmid: 100, ip: "192.0.2.21/24" }) })
  assert.equal(bad.statusCode, 422)
  assert.equal(bad.json().problems.length >= 2, true)
  const pl = await a.inject({ method: "GET", url: "/wizard/placement?recipeId=gitea" })
  assert.equal(pl.statusCode, 200, pl.body)
  assert.equal(pl.json().data.recommendation.node, "node-a")
  assert.equal(pl.json().data.nextVmid, 102)
  const id = await a.inject({ method: "POST", url: "/wizard/identity", payload: { node: "node-a", ip: "192.0.2.21/24", vmid: 100 } })
  assert.match(id.json().data.ip.problems.join(" "), /guest 100/)
  assert.equal(id.json().data.vmid.free, false)
})

test("routes: the ID rule is saved only when valid", async () => {
  const a = app(new FakePve())
  assert.equal((await a.inject({ method: "PUT", url: "/wizard/settings", payload: { vmidRule: { kind: "pattern", pattern: "{vmid}" } } })).statusCode, 400)
  const ok = await a.inject({ method: "PUT", url: "/wizard/settings", payload: { vmidRule: { kind: "pattern", pattern: "{node_digit}{ip_last2}" } } })
  assert.deepEqual(ok.json().data.vmidRule, { kind: "pattern", pattern: "{node_digit}{ip_last2}" })
})

test("routes: there is no one-call /install route any more", async () => {
  const a = app(new FakePve())
  for (const payload of [{ recipeId: "gitea" }, { recipeId: "gitea", intoVmid: 100 }]) {
    assert.equal((await a.inject({ method: "POST", url: "/install", payload })).statusCode, 404)
  }
})

test("access: every wizard route is admin, reads included; apply and clean-up need the master password again", () => {
  for (const [m, p] of [["GET", "/api/catalogue/wizard/placement"], ["POST", "/api/catalogue/wizard/identity"],
    ["GET", "/api/catalogue/wizard/settings"], ["PUT", "/api/catalogue/wizard/settings"], ["POST", "/api/catalogue/wizard/preview"],
    ["GET", "/api/catalogue/wizard/preview/x"], ["POST", "/api/catalogue/wizard/apply"], ["POST", "/api/catalogue/wizard/jobs/x/cleanup"]]) {
    assert.equal(requiredRole(m, p), "admin", `${m} ${p}`)
  }
  assert.equal(needsReconfirm("POST", "/api/catalogue/wizard/apply"), true)
  assert.equal(needsReconfirm("POST", "/api/catalogue/wizard/jobs/abc/cleanup"), true)
  assert.equal(needsReconfirm("POST", "/api/catalogue/wizard/preview"), false)
})

// ── Fix round: the vault item, CIFS storage, promised memory ────────────────

test("clean-up: the generated-login vault item goes too, but only one this install created", async () => {
  for (const existed of [false, true]) {
    const f = new FakePve()
    const items = new Map<string, Record<string, string>>()
    if (existed) items.set("apps/grafana-102", { note: "kept by someone" })
    const deleted: string[] = []
    const d = deps(f, {
      exec: async () => ({ code: 1, output: "", timedOut: false }) as any,
      readSecrets: async (c, p) => ({ ...(items.get(`${c}/${p}`) ?? {}) }),
      saveSecrets: async (c, p, v) => { items.set(`${c}/${p}`, { ...(items.get(`${c}/${p}`) ?? {}), ...v }) },
      deleteSecrets: async (c, p) => { deleted.push(`${c}/${p}`); items.delete(`${c}/${p}`) },
    })
    const { preview } = await previewInstall(INPUT({ recipeId: "grafana", hostname: "grafana" }), "a@example.com", d)
    const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
    assert.equal(job.status, "failed")
    const msg = await removeFailedInstall(job.jobId, "a@example.com", d)
    if (existed) {
      assert.deepEqual(deleted, [])
      assert.match(msg, /existed before this install, so it was kept/)
    } else {
      assert.deepEqual(deleted, ["apps/grafana-102"])
      assert.match(msg, /removed from the vault/)
    }
  }
})

test("preview: a CIFS storage is refused with the reason, even when it says it holds containers", async () => {
  const f = new FakePve()
  const orig = f.answer.bind(f)
  f.answer = async (p: string, m: string, b?: string) => /^\/nodes\/[^/]+\/storage$/.test(p)
    ? [...await orig(p, m, b), { storage: "nas", type: "cifs", content: "rootdir,vztmpl", active: 1, shared: 1, avail: 5000 * GB }]
    : orig(p, m, b)
  const r = await previewInstall(INPUT({ storage: "nas" }), "a@example.com", deps(f))
  assert.equal(r.preview, undefined)
  assert.match(r.errors.join(" "), /CIFS\/SMB shares cannot hold a container's root disk/)
  const view = await readCluster(f.client, async () => true)
  const p = placementFor(findRecipe("gitea")!, { cores: 1, memoryMb: 512, diskGb: 8 }, view)
  const a = p.nodes.find(n => n.node === "node-a")!
  assert.deepEqual(a.rootStorages.map(s => s.storage), ["pool"])
  assert.deepEqual(a.excludedStorages.map(s => s.storage), ["nas"])
})

test("placement: promised memory is the sum of running guests' maxmem per node", async () => {
  const f = new FakePve()
  f.guests[0].maxmem = 4 * GB
  f.guests.push({ vmid: 150, type: "lxc", node: "node-a", name: "off", status: "stopped", maxmem: 16 * GB })
  const view = await readCluster(f.client, async () => true)
  assert.equal(view.nodes.find(n => n.node === "node-a")!.memCommittedMb, 4096, "stopped guests promise nothing")
})
