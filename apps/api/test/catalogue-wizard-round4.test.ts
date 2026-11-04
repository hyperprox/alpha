// Re-check round: ordered job writes, honest restore, the mark after the job row, the tick tied to what was seen,
// and jobs whose container may still exist are never pruned.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  previewInstall, applyPreview, removeFailedInstall, restoreWizardState, cleanupCandidates, getInstallJob,
  persistJob, clearIdentityCache, type InstallJob,
} from "../src/lib/catalogue-installer"
import { setWizardStore, MemoryWizardStore, type WizardRecord } from "../src/lib/catalogue-store"
import { FakePve, deps, INPUT, settled } from "./fakes/catalogue-pve"

/** A store whose puts can be slowed or failed, per record, to reorder or lose writes. */
class FlakyStore extends MemoryWizardStore {
  delay: (r: WizardRecord) => number = () => 0
  failPut: (r: WizardRecord) => boolean = () => false
  async put(r: WizardRecord) {
    const ms = this.delay(r)
    if (ms) await new Promise(res => setTimeout(res, ms))
    if (this.failPut(r)) throw new Error("database unavailable")
    return super.put(r)
  }
}
const use = <T extends MemoryWizardStore>(s: T) => { setWizardStore(s); clearIdentityCache(); return s }

test("R1: a job's writes land in the order they were made, however slow each one is", async () => {
  const s = use(new FlakyStore())
  // Earlier writes are slower: without a chain the first would land last.
  s.delay = r => (r.data.steps.filter((x: any) => x.status === "done").length === 0 ? 30 : 0)
  const job: InstallJob = { jobId: "j-order", owner: "a@example.com", recipeId: "gitea", status: "running", log: "", startedAt: Date.now(),
    steps: [{ id: "container", label: "c", status: "running" }] }
  const first = persistJob(job)
  job.steps[0].status = "done"; job.status = "completed"
  const last = persistJob(job)
  await Promise.all([first, last])
  assert.equal((await s.get("j-order"))!.data.status, "completed")
})

test("R1: the final write's failure is surfaced on the job, not swallowed", async () => {
  const s = use(new FlakyStore())
  s.failPut = r => r.kind === "job" && r.data.status === "completed"
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const job = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  assert.equal(job.status, "completed")
  assert.match(job.storeError ?? "", /could not be saved: database unavailable/)
})

test("R1: a finished job whose final write was lost is never offered for clean-up after a restart", async () => {
  const s = use(new FlakyStore())
  s.failPut = r => r.kind === "job" && r.data.status === "completed"
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  const done = await settled((await applyPreview(preview!.id, "a@example.com", d)).jobId)
  assert.equal(done.status, "completed")
  assert.equal((await s.get(done.jobId))!.data.status, "running", "the store still says running")
  assert.equal(await s.get("creating:102"), null, "the create mark went when the job settled")

  await restoreWizardState()
  const back = getInstallJob(done.jobId)!
  assert.equal(back.status, "unknown")
  assert.match(back.error!, /could not tell how this install ended/)
  assert.ok(!cleanupCandidates("a@example.com").some(j => j.jobId === done.jobId))
  await assert.rejects(removeFailedInstall(done.jobId, "a@example.com", d), /Only a failed or interrupted install/)
  assert.deepEqual(f.deletes, [])
})

test("R1: only a running job whose create mark survived comes back interrupted, with clean-up", async () => {
  const s = use(new MemoryWizardStore())
  const mk = (jobId: string): InstallJob => ({ jobId, owner: "a@example.com", recipeId: "gitea", status: "running", log: "",
    vmid: 150, node: "node-a", created: true, startedAt: Date.now(), steps: [{ id: "install", label: "i", status: "running" }] })
  await s.put({ id: "j-marked", kind: "job", owner: "a@example.com", data: mk("j-marked"), expiresAt: null })
  await s.put({ id: "j-bare", kind: "job", owner: "a@example.com", data: mk("j-bare"), expiresAt: null })
  await s.put({ id: "creating:150", kind: "creating", owner: "a@example.com", data: { jobId: "j-marked", vmid: 150, node: "node-a" }, expiresAt: null })
  const r = await restoreWizardState()
  assert.equal(r.interrupted, 1)
  assert.equal(getInstallJob("j-marked")!.status, "interrupted")
  assert.equal(getInstallJob("j-bare")!.status, "unknown")
  const ids = cleanupCandidates("a@example.com").map(j => j.jobId)
  assert.ok(ids.includes("j-marked"))
  assert.ok(!ids.includes("j-bare"))
})

test("R2: the job row is written before the create mark; if it cannot be, nothing is created", async () => {
  const s = use(new FlakyStore())
  s.failPut = r => r.kind === "job"
  const f = new FakePve(), d = deps(f)
  const { preview } = await previewInstall(INPUT(), "a@example.com", d)
  await assert.rejects(applyPreview(preview!.id, "a@example.com", d), /could not record the install/)
  assert.equal(f.creates.length, 0)
  assert.equal(await s.get("creating:102"), null)

  const order: string[] = []
  const t = use(new FlakyStore())
  t.delay = r => { order.push(`${r.kind}`); return r.kind === "job" && order.filter(x => x === "job").length === 1 ? 20 : 0 }
  const g = new FakePve(), e = deps(g)
  const p = (await previewInstall(INPUT(), "a@example.com", e)).preview!
  await settled((await applyPreview(p.id, "a@example.com", e)).jobId)
  assert.ok(order.indexOf("job") < order.indexOf("creating"), order.join(","))
})

test("R3: the tick covers exactly the unknowns the person saw; a grown set is refused and asked again", async () => {
  use(new MemoryWizardStore())
  const f = new FakePve()
  f.failing.add("/nodes/node-a/lxc/100/interfaces")
  // Ticked for something else than what is unknown now: refused at preview.
  const wrong = await previewInstall(INPUT({ addressAck: ["cluster-status"] } as any), "a@example.com", deps(f))
  assert.equal(wrong.preview, undefined)
  assert.match(wrong.errors.join(" "), /more could not be checked than when you ticked/)

  const ok = await previewInstall(INPUT({ addressAck: ["live:100"] } as any), "a@example.com", deps(f))
  assert.ok(ok.preview, ok.errors.join(" "))
  assert.deepEqual(ok.preview!.plan.addressAck, ["live:100"])

  // Between preview and apply, the node list stops answering too: the set has grown.
  f.failing.add("/cluster/status")
  await assert.rejects(applyPreview(ok.preview!.id, "a@example.com", deps(f)), (e: any) => {
    assert.equal(e.code, "changed")
    assert.match(e.problems.join(" "), /more could not be checked than when you ticked/)
    return true
  })
  assert.equal(f.creates.length, 0)
})

test("R4: a job whose container may still exist is never pruned; finished or cleaned jobs are", async () => {
  const s = use(new MemoryWizardStore())
  const base = { owner: "a@example.com", recipeId: "gitea", log: "", vmid: 150, node: "node-a", startedAt: 0, steps: [] }
  const cases: Array<[string, Partial<InstallJob>, boolean]> = [
    ["interrupted-made", { status: "interrupted", created: true }, false],
    ["failed-made", { status: "failed", created: true }, false],
    ["unknown", { status: "unknown", created: true }, false],
    ["running", { status: "running" }, false],
    ["completed", { status: "completed", created: true }, true],
    ["cleaned", { status: "failed", created: true, removed: true }, true],
    ["failed-nothing", { status: "failed" }, true],
  ]
  for (const [id, o] of cases) await persistJob({ ...base, jobId: id, ...o } as InstallJob)
  await s.pruneExpired(new Date(Date.now() + 365 * 24 * 3600_000))
  for (const [id, , pruned] of cases) assert.equal((await s.get(id)) === null, pruned, id)
})
