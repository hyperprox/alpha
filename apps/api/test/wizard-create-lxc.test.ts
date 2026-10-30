// The create step against a fake Proxmox: the parameters it sends, the node it picks, and that a refusal
// or a failed task reaches the user as Proxmox's own words instead of a ninety-second timeout.
import { test } from "node:test"
import assert from "node:assert/strict"
import { stepCreateLXC, executeWizardJob, getJob, type JobState } from "../src/lib/wizard-executor"
import { ProxmoxClient } from "../src/lib/proxmox-client"

const GB = 1024 ** 3
const UPID = "UPID:alpha:0001:0002:0003:vzcreate:250:root@pam:"

function plan(params: Record<string, unknown> = {}) {
  return {
    service: "Uptime Kuma", domain: "kuma.example.com",
    requirements: { ram_mb: 256, disk_gb: 2, cpu_cores: 1 },
    steps: [{ id: "c", type: "create_lxc", label: "Create", params: { hostname: "", node: "", vmid: 0, ip: "", gateway: "", ...params } }],
  }
}
const job = (p: any): JobState => ({ jobId: "j", status: "running", plan: p, steps: [], currentStep: 0, startedAt: 0 })

function fakePve(over: Record<string, any> = {}) {
  const calls: { create?: any; waited?: any[]; downloaded?: any[] } = {}
  const guests = over.guests ?? [
    { vmid: 101, type: "lxc", node: "alpha" },
  ]
  const pve: any = {
    getNodes: async () => over.nodes ?? [
      { node: "alpha", status: "online", maxmem: 16 * GB, mem: 12 * GB },
      { node: "beta",  status: "online", maxmem: 16 * GB, mem: 2 * GB },
    ],
    fetchStrict: async (path: string) => {
      if (path.startsWith("/cluster/resources")) return guests
      if (path === "/cluster/nextid") return "102"
      if (path.endsWith("/network")) return over.network ?? [{ iface: "vmbr0", type: "bridge", gateway: "10.0.0.1" }]
      if (path.endsWith("/aplinfo")) return [{ template: "debian-13-standard_13.1-2_amd64.tar.zst" }]
      throw new Error("unexpected strict " + path)
    },
    fetchNode: async (path: string) => {
      if (path.includes("/config")) return over.configs?.[path] ?? { net0: "name=eth0,ip=10.0.0.50/24,gw=10.0.0.1" }
      if (path.includes("storage?content=vztmpl")) return over.tmplStorages ?? [{ storage: "tmpl" }]
      if (path.includes("/content?content=vztmpl")) return over.templates ?? [
        { volid: "tmpl:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst" },
        { volid: "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst" },
      ]
      if (path.includes("storage?content=rootdir")) return [{ storage: "pool", type: "rbd", enabled: 1, active: 1, avail: 100 * GB }]
      if (path.endsWith("/status/current")) return { status: "running" }
      if (path.endsWith("/interfaces")) return [{ name: "eth0", inet: "10.0.0.77/24" }]
      return null
    },
    createLXC: async (node: string, params: any) => {
      if (over.createError) throw new Error(over.createError)
      calls.create = { node, params }; return UPID
    },
    waitForTask: async (...a: any[]) => {
      (calls.waited ??= []).push(a)
      if (over.taskError) throw new Error(over.taskError)
    },
    downloadTemplate: async (...a: any[]) => { (calls.downloaded ??= []).push(a); return "UPID:dl" },
  }
  return { pve, calls }
}
const noWait = async () => {}

test("sends a real rootfs size, no cast needed, and a Docker-capable unprivileged container", async () => {
  const { pve, calls } = fakePve()
  await stepCreateLXC(job(plan()), pve, noWait)
  const p = calls.create.params
  assert.equal(p.rootfs_size, 8)  // the plan asked for 2; Docker installs never get less than 8
  assert.equal(p.storage, "pool")
  assert.equal(p.unprivileged, true)
  assert.equal(p.features, "nesting=1")
  assert.equal(p.ostemplate, "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst")
  assert.equal(p.vmid, 102)
  assert.match(p.net0, /ip=dhcp/)
})

test("waits on the create task's UPID, not on a blind poll", async () => {
  const { pve, calls } = fakePve()
  await stepCreateLXC(job(plan()), pve, noWait)
  assert.equal(calls.waited![0][0], "beta")
  assert.equal(calls.waited![0][1], UPID)
})

test("a refused create and a failed task both surface Proxmox's message", async () => {
  await assert.rejects(stepCreateLXC(job(plan()), fakePve({ createError: "HTTP 400 — rootfs: invalid format" }).pve, noWait), /invalid format/)
  await assert.rejects(stepCreateLXC(job(plan()), fakePve({ taskError: "Proxmox task failed (ERROR: unable to create)" }).pve, noWait), /unable to create/)
})

test("the plan's node is used, even when another has more free memory", async () => {
  const { pve, calls } = fakePve()
  await stepCreateLXC(job(plan({ node: "alpha" })), pve, noWait)
  assert.equal(calls.create.node, "alpha")
})

test("a named node that is offline or too full is refused, not silently replaced", async () => {
  await assert.rejects(stepCreateLXC(job(plan({ node: "alpha" })), fakePve({ nodes: [
    { node: "alpha", status: "online", maxmem: 16 * GB, mem: 16 * GB - 64 * 1048576 },
    { node: "beta", status: "online", maxmem: 16 * GB, mem: 0 },
  ] }).pve, noWait), /less than the 512 MB/)
})

test("a given vmid and ip are used; the gateway is the bridge's, whatever the plan says", async () => {
  const { pve, calls } = fakePve()
  const j = job(plan({ vmid: 250, ip: "10.0.0.37/24", gateway: "10.9.9.9" }))
  await stepCreateLXC(j, pve, noWait)
  assert.equal(calls.create.params.vmid, 250)
  assert.match(calls.create.params.net0, /ip=10\.0\.0\.37\/24,gw=10\.0\.0\.1,/)
  assert.equal(j.lxcIp, "10.0.0.37")
})

test("a vmid in use, an ip in use, a bad ip and an off-network ip are all refused before anything is created", async () => {
  const run = (params: any) => { const f = fakePve(); return stepCreateLXC(job(plan(params)), f.pve, noWait).then(() => f.calls.create) }
  await assert.rejects(run({ vmid: 101 }), /already used/)
  await assert.rejects(run({ ip: "10.0.0.50/24" }), /already configured on guest 101/)
  await assert.rejects(run({ ip: "10.0.0.300/24" }), /not an IPv4/)
  await assert.rejects(run({ ip: "10.5.0.9/24" }), /not on the same network/)
})

test("an ip with no bridge gateway to read is refused rather than guessed", async () => {
  await assert.rejects(stepCreateLXC(job(plan({ ip: "10.0.0.37/24", gateway: "10.0.0.1" })),
    fakePve({ network: [{ iface: "vmbr0", type: "bridge" }] }).pve, noWait), /no gateway/)
})

test("a template is downloaded only when none exists, and the download is waited on", async () => {
  const { pve, calls } = fakePve({ templates: [] })
  await stepCreateLXC(job(plan()), pve, noWait)
  assert.equal(calls.downloaded![0][2], "debian-13-standard_13.1-2_amd64.tar.zst")
  assert.equal(calls.create.params.ostemplate, "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst")
  const present = fakePve()
  await stepCreateLXC(job(plan()), present.pve, noWait)
  assert.equal(present.calls.downloaded, undefined)
})

// ── waitForTask, on the real client with its transport stubbed ──────────────────────────────

function clientWith(statuses: any[], log: string[] = []) {
  const c = new ProxmoxClient("h", 8006, "u@pam!t", "s")
  let i = 0
  ;(c as any).fetchStrict = async () => statuses[Math.min(i++, statuses.length - 1)]
  ;(c as any).fetchNode = async () => log.map((t, n) => ({ n: n + 1, t }))
  return c
}

test("waitForTask: returns on OK, polling until the task stops", async () => {
  await clientWith([{ status: "running" }, { status: "stopped", exitstatus: "OK" }]).waitForTask("n", UPID, { sleep: async () => {} })
})

test("waitForTask: a failed task throws its exit status and log tail", async () => {
  await assert.rejects(
    clientWith([{ status: "stopped", exitstatus: "unable to create CT" }], ["line one", "TASK ERROR: boom"])
      .waitForTask("n", UPID, { sleep: async () => {} }),
    (e: Error) => /unable to create CT/.test(e.message) && /TASK ERROR: boom/.test(e.message))
})

test("waitForTask: gives up after the timeout", async () => {
  await assert.rejects(
    clientWith([{ status: "running" }]).waitForTask("n", UPID, { timeoutMs: 4000, intervalMs: 2000, sleep: async () => {} }),
    /still running/)
})

// ── a failed or impossible install stops the run ───────────────────────────────────────────

test("no install recipe: the run stops at install_service and the later steps stay pending", async () => {
  const steps = ["install_service", "configure_proxy", "create_dns", "request_ssl"].map(t => ({ id: t, type: t, label: t }))
  await executeWizardJob("j-norecipe", { service: "Mystery App", domain: "x.example.com", steps })
  const j = getJob("j-norecipe")!
  assert.equal(j.status, "failed")
  assert.equal(j.steps[0].status, "failed")
  assert.deepEqual(j.steps.slice(1).map(s => s.status), ["pending", "pending", "pending"])
  assert.match(j.error!, /no install recipe/)
  assert.match(j.error!, /Not run: configure_proxy, create_dns, request_ssl/)
})
