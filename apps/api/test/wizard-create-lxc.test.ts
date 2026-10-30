// The create step against a fake Proxmox: it sends the run's fields and the template's constants, refuses
// anything that changed since the preview before creating, and surfaces Proxmox's own words on a refusal.
import { test } from "node:test"
import assert from "node:assert/strict"
import { stepCreateLXC, type JobState } from "../src/lib/wizard-executor"
import type { DeployFields } from "../src/lib/ai/templates/deploy-service"
import { ProxmoxClient } from "../src/lib/proxmox-client"
import { fields, runOf, DEBIAN } from "./fakes/deploy-run"

const UPID = "UPID:alpha:0001:0002:00000064:vzcreate:250:root@pam:"

const job = (f: DeployFields): JobState => ({ jobId: "j", status: "running", run: runOf(f), steps: [], currentStep: 0, startedAt: 0 })

function fakePve(over: Record<string, any> = {}) {
  const calls: { create?: any; waited?: any[]; downloaded?: any[] } = {}
  const guests = over.guests ?? [{ vmid: 101, type: "lxc", node: "alpha" }]
  const pve: any = {
    getNodes: async () => { throw new Error("the create step must not choose a node") },
    fetchStrict: async (path: string) => {
      if (path.startsWith("/cluster/resources")) return guests
      if (path === "/cluster/nextid") throw new Error("the create step must not choose an ID")
      if (/^\/nodes\/[^/]+\/network$/.test(path)) return over.network ?? [{ iface: "vmbr0", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.1" }]
      if (/^\/nodes\/[^/]+\/status$/.test(path)) return { "current-kernel": { machine: over.machine ?? "x86_64" } }
      if (path.endsWith("/aplinfo")) return over.aplinfo ?? [{ template: "debian-13-standard_13.1-2_amd64.tar.zst" }]
      if (path.includes("/content?content=vztmpl")) return over.templates ?? [{ volid: DEBIAN }]
      if (path.endsWith("/config")) return over.configs?.[path] ?? { net0: "name=eth0,ip=10.0.0.50/24,gw=10.0.0.1" }
      throw new Error("unexpected strict " + path)
    },
    fetchNode: async () => null,
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

test("create uses the fields exactly: node, storage, template, vmid, address", async () => {
  const { pve, calls } = fakePve()
  const j = job(fields({ node: "alpha", memory_mb: 768, disk_gb: 12, cores: 2 }))
  await stepCreateLXC(j, pve, noWait)
  assert.equal(calls.create.node, "alpha")
  const p = calls.create.params
  assert.equal(p.storage, "pool")
  assert.equal(p.ostemplate, DEBIAN)
  assert.equal(p.vmid, 250)
  assert.equal(p.hostname, "uptime-kuma")
  assert.equal(p.memory, 768)
  assert.equal(p.rootfs_size, 12)
  assert.equal(p.cores, 2)
  assert.match(p.net0, /^name=eth0,bridge=vmbr0,ip=10\.0\.0\.37\/24,gw=10\.0\.0\.1,firewall=1$/)
  assert.equal(j.lxcVmid, 250)
  assert.equal(j.lxcNode, "alpha")
  assert.equal(j.lxcIp, "10.0.0.37")
  assert.equal(j.createUpid, UPID)
})

test("a DHCP run sends ip=dhcp and leaves the address to start_and_verify", async () => {
  const { pve, calls } = fakePve()
  const j = job(fields({ ip: "dhcp", gateway: undefined }))
  await stepCreateLXC(j, pve, noWait)
  assert.equal(calls.create.params.net0, "name=eth0,bridge=vmbr0,ip=dhcp,firewall=1")
  assert.equal(j.lxcIp, undefined)
})

test("create sends the constants: unprivileged, nesting only, onboot, start", async () => {
  const { pve, calls } = fakePve()
  await stepCreateLXC(job(fields()), pve, noWait)
  const p = calls.create.params
  assert.equal(p.unprivileged, true)
  assert.equal(p.features, "nesting=1")
  assert.equal(p.onboot, true)
  assert.equal(p.start, true)
  // A field that says otherwise never reaches Proxmox.
  await assert.rejects(stepCreateLXC(job(fields({ features: "nesting=1,keyctl=1" as any })), fakePve().pve, noWait), /nesting=1/)
})

test("waits on the create task's UPID", async () => {
  const { pve, calls } = fakePve()
  await stepCreateLXC(job(fields()), pve, noWait)
  assert.equal(calls.waited![0][0], "alpha")
  assert.equal(calls.waited![0][1], UPID)
})

test("a refused create and a failed task both surface Proxmox's message", async () => {
  await assert.rejects(stepCreateLXC(job(fields()), fakePve({ createError: "HTTP 400 — rootfs: invalid format" }).pve, noWait), /invalid format/)
  await assert.rejects(stepCreateLXC(job(fields()), fakePve({ taskError: "Proxmox task failed (ERROR: unable to create)" }).pve, noWait), /unable to create/)
})

test("a bridge gateway that changed since the preview stops the create", async () => {
  const f = fakePve({ network: [{ iface: "vmbr0", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.254" }] })
  await assert.rejects(stepCreateLXC(job(fields()), f.pve, noWait), /gateway.*10\.0\.0\.254/)
  assert.equal(f.calls.create, undefined)
  const gone = fakePve({ network: [{ iface: "vmbr1", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.1" }] })
  await assert.rejects(stepCreateLXC(job(fields()), gone.pve, noWait), /vmbr0/)
  assert.equal(gone.calls.create, undefined)
})

test("an ID or address taken since the preview is refused before anything is created", async () => {
  const taken = fakePve({ guests: [{ vmid: 250, type: "lxc", node: "alpha" }] })
  await assert.rejects(stepCreateLXC(job(fields()), taken.pve, noWait), /250.*already used/)
  assert.equal(taken.calls.create, undefined)
  const ip = fakePve({ configs: { "/nodes/alpha/lxc/101/config": { net0: "name=eth0,ip=10.0.0.37/24" } } })
  await assert.rejects(stepCreateLXC(job(fields()), ip.pve, noWait), /10\.0\.0\.37 is already configured on guest 101/)
  assert.equal(ip.calls.create, undefined)
})

test("a template volid not yet on its storage is downloaded and waited on", async () => {
  const { pve, calls } = fakePve({ templates: [] })
  await stepCreateLXC(job(fields()), pve, noWait)
  assert.deepEqual(calls.downloaded![0], ["alpha", "tmpl", "debian-13-standard_13.1-2_amd64.tar.zst"])
  assert.equal(calls.waited![0][1], "UPID:dl")
  assert.equal(calls.create.params.ostemplate, DEBIAN)
  const present = fakePve()
  await stepCreateLXC(job(fields()), present.pve, noWait)
  assert.equal(present.calls.downloaded, undefined)
})

test("a template for another CPU than the node's is refused, present or to download", async () => {
  const arm = fakePve({ machine: "aarch64" })
  await assert.rejects(stepCreateLXC(job(fields()), arm.pve, noWait), /amd64.*arm64/)
  assert.equal(arm.calls.create, undefined)
  const notOffered = fakePve({ templates: [], aplinfo: [] })
  await assert.rejects(stepCreateLXC(job(fields()), notOffered.pve, noWait), /not on offer/)
  assert.equal(notOffered.calls.create, undefined)
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
