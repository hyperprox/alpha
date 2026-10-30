// The executor runs the template's fixed steps from typed fields, against fakes: a failed step stops the run,
// publishing never follows a failed or skipped install, and a first-run page is never published.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  executeDeployJob, getJob, stepStartAndVerify, stepHealthCheck, type ExecDeps, type JobState,
} from "../src/lib/wizard-executor"
import type { StepSpec } from "../src/lib/ai/templates/types"
import { fields, runOf, DEBIAN } from "./fakes/deploy-run"

const UPID = "UPID:alpha:0001:0002:00000064:vzcreate:250:root@pam:"   // started at 0x64 = 100
const noWait = async () => {}
const ALL: StepSpec["id"][] = ["create_lxc", "start_and_verify", "install_service", "health_check",
  "configure_proxy", "create_dns", "wait_propagation", "request_ssl"]
const steps = (ids: StepSpec["id"][]) => ids.map(id => ({ id, label: id }))

function fakeDeps(over: Record<string, any> = {}) {
  const calls: { create?: any; scripts: string[]; proxy: any[]; records: any[][]; fetched: string[] } =
    { scripts: [], proxy: [], records: [], fetched: [] }
  const pve: any = {
    getNodes: async () => [],
    fetchStrict: async (path: string) => {
      if (path.startsWith("/cluster/resources")) return [{ vmid: 101, type: "lxc", node: "alpha" }]
      if (path === "/cluster/status") return [{ type: "node", name: "alpha", ip: "10.0.0.2" }]
      if (/^\/nodes\/[^/]+\/network$/.test(path)) return [{ iface: "vmbr0", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.1" }]
      if (/^\/nodes\/[^/]+\/status$/.test(path)) return { "current-kernel": { machine: "x86_64" } }
      if (path.includes("/content?content=vztmpl")) return over.templates ?? [{ volid: DEBIAN }, { volid: "tmpl:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst" }]
      if (path.endsWith("/config")) return { net0: "name=eth0,ip=10.0.0.50/24" }
      throw new Error("unexpected strict " + path)
    },
    fetchNode: async (path: string) => {
      if (path.includes("/tasks?")) return over.tasks ?? []
      if (path.endsWith("/status/current")) return { status: "running" }
      if (path.endsWith("/interfaces")) return [{ name: "eth0", inet: "10.0.0.77/24" }]
      return null
    },
    createLXC: async (node: string, params: any) => { calls.create = { node, params }; return UPID },
    waitForTask: async () => {},
    downloadTemplate: async () => "UPID:dl",
  }
  const deps: Partial<ExecDeps> = {
    pve,
    wait: noWait,
    fetch: (async (url: string) => { calls.fetched.push(url); return { status: over.health ?? 200 } }) as any,
    exec: (async (o: any) => { calls.scripts.push(o.script); return { code: over.installCode ?? 0, output: over.installOutput ?? "", timedOut: false } }) as any,
    login: async () => (over.noLogin ? null : ({ username: "root", password: "x" } as any)),
    npm: async () => ({
      createProxyHost: async (h: any) => { calls.proxy.push(h); return { id: 7 } },
      requestCertificate: async () => ({ id: 9 }),
      updateProxyHost: async () => ({}),
    }) as any,
    dns: async () => ({
      getDomains: async () => (over.zones ?? ["example.com"]).map((domain: string) => ({ domain })),
      createRecord: async (...a: any[]) => { calls.records.push(a) },
    }) as any,
    wanIp: async () => "203.0.113.5",
    resolve4: async () => ["203.0.113.5"],
    ...over.deps,
  }
  return { deps, calls }
}

let n = 0
async function run(f = fields(), ids?: StepSpec["id"][], over: Record<string, any> = {}) {
  const { deps, calls } = fakeDeps(over)
  const id = `job-${n++}`
  await executeDeployJob(id, runOf(f, ids ? steps(ids) : undefined), deps)
  return { job: getJob(id)!, calls }
}
const statuses = (j: JobState) => Object.fromEntries(j.steps.map(s => [s.type, s.status]))

test("a lan run creates, starts, installs and checks, in the template's order", async () => {
  const { job, calls } = await run()
  assert.equal(job.status, "completed", job.error)
  assert.deepEqual(job.steps.map(s => s.type), ["create_lxc", "start_and_verify", "install_service", "health_check"])
  assert.equal(calls.create.params.vmid, 250)
  assert.deepEqual(calls.fetched, ["http://10.0.0.37:3001/"])
  assert.equal(job.serviceInstalled, true)
})

test("start_and_verify ignores start tasks older than this create", async () => {
  const j = (tasks: any[]): JobState => ({ jobId: "s", status: "running", run: runOf(fields()), steps: [], currentStep: 0,
    startedAt: 0, lxcVmid: 250, lxcNode: "alpha", lxcIp: "10.0.0.37", createUpid: UPID })
  // A start of an earlier guest with the same ID failed at 50; this create began at 100.
  const old = fakeDeps({ tasks: [{ starttime: 50, status: "ERROR: old" }] })
  assert.match(await stepStartAndVerify(j([]), old.deps.pve as any, noWait), /running/)
  const fresh = fakeDeps({ tasks: [{ starttime: 120, status: "ERROR: startup failed" }] })
  await assert.rejects(stepStartAndVerify(j([]), fresh.deps.pve as any, noWait), /would not start: ERROR: startup failed/)
})

test("start_and_verify reads a DHCP address", async () => {
  const j: JobState = { jobId: "d", status: "running", run: runOf(fields({ ip: "dhcp", gateway: undefined })), steps: [],
    currentStep: 0, startedAt: 0, lxcVmid: 250, lxcNode: "alpha", createUpid: UPID }
  await stepStartAndVerify(j, fakeDeps().deps.pve as any, noWait)
  assert.equal(j.lxcIp, "10.0.0.77")
})

test("health_check passes on the recipe's expected status and fails loudly otherwise", async () => {
  const j = (): JobState => ({ jobId: "h", status: "running", run: runOf(fields()), steps: [], currentStep: 0, startedAt: 0,
    lxcIp: "10.0.0.37", serviceInstalled: true })
  const answering = (status: number) => (async () => ({ status })) as any
  assert.match(await stepHealthCheck(j(), answering(302), noWait), /302/)   // uptime-kuma accepts 200 and 302
  await assert.rejects(stepHealthCheck(j(), answering(500), noWait), /http:\/\/10\.0\.0\.37:3001\/ answered 500.*200, 302/)
  const refused = (async () => { throw new Error("connect ECONNREFUSED") }) as any
  await assert.rejects(stepHealthCheck(j(), refused, noWait), /ECONNREFUSED/)
})

test("a failed install or health check stops the run; publishing steps stay pending", async () => {
  const pub = fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" })
  const failed = await run(pub, ALL, { installCode: 1, installOutput: "E: Unable to locate package" })
  assert.equal(failed.job.status, "failed")
  assert.equal(statuses(failed.job).install_service, "failed")
  assert.match(failed.job.error!, /INSTALL FAILED.*exited 1[\s\S]*Unable to locate package/)
  for (const s of ["health_check", "configure_proxy", "create_dns", "wait_propagation", "request_ssl"]) {
    assert.equal(statuses(failed.job)[s], "pending", s)
  }
  assert.equal(failed.calls.proxy.length, 0)

  const unhealthy = await run(pub, ALL, { health: 503 })
  assert.equal(unhealthy.job.status, "failed")
  assert.equal(statuses(unhealthy.job).health_check, "failed")
  assert.equal(statuses(unhealthy.job).configure_proxy, "pending")
  assert.equal(unhealthy.calls.proxy.length, 0)
  assert.equal(unhealthy.calls.records.length, 0)
})

test("publishing a recipe with a first-run page is refused until the first-run lock exists", async () => {
  const f = fields({ exposure: "public", domain: "kuma.example.com", admin_setup: "now" })
  const { job, calls } = await run(f, ALL)
  assert.equal(job.status, "failed")
  assert.equal(statuses(job).health_check, "completed")
  assert.equal(statuses(job).configure_proxy, "failed")
  assert.match(job.steps.find(s => s.type === "configure_proxy")!.error!,
    /Uptime Kuma shows a first-run setup page to whoever visits first, so HyperProx will not publish it yet\. Finish setup at http:\/\/10\.0\.0\.37:3001, then publish it\./)
  assert.equal(statuses(job).create_dns, "pending")
  assert.equal(calls.proxy.length, 0)
  assert.equal(calls.records.length, 0)
})

test("a public recipe with no first-run page is published to its port", async () => {
  const f = fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" })
  const { job, calls } = await run(f, ALL)
  assert.equal(job.status, "completed", job.error)
  assert.equal(calls.proxy[0].forward_host, "10.0.0.37")
  assert.equal(calls.proxy[0].forward_port, 3000)
  assert.deepEqual(calls.proxy[0].domain_names, ["home.example.com"])
})

test("create_dns writes to the longest matching zone", async () => {
  const f = fields({ service: "homepage", exposure: "public", domain: "home.lab.example.com", hostname: "homepage" })
  const { job, calls } = await run(f, ["create_dns"], { zones: ["example.com", "lab.example.com"] })
  assert.equal(job.status, "completed", job.error)
  assert.deepEqual(calls.records[0], ["lab.example.com", { type: "A", name: "home", data: "203.0.113.5", ttl: 600 }])
  const none = await run(fields({ service: "homepage", exposure: "public", domain: "home.example.net" }), ["create_dns"])
  assert.equal(none.job.status, "failed")
  assert.match(none.job.error!, /example\.net.*no DNS zone/)
  assert.equal(none.calls.records.length, 0)
})

test("with no node login the install is shown, not run; health_check is skipped and no publishing step runs", async () => {
  const lan = await run(fields(), undefined, { noLogin: true })
  assert.equal(lan.job.status, "completed", lan.job.error)
  const install = lan.job.steps.find(s => s.type === "install_service")!
  assert.equal(install.status, "skipped")
  assert.ok(install.commands!.some(c => /docker compose up -d/.test(c)))
  assert.equal(statuses(lan.job).health_check, "skipped")
  assert.equal(lan.calls.scripts.length, 0)
  assert.equal(lan.calls.fetched.length, 0)

  const pub = await run(fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" }), ALL, { noLogin: true })
  assert.equal(pub.job.status, "failed")
  assert.match(pub.job.error!, /not installed.*not published/i)
  for (const s of ["configure_proxy", "create_dns", "wait_propagation", "request_ssl"]) assert.equal(statuses(pub.job)[s], "pending", s)
  assert.equal(pub.calls.proxy.length, 0)
})

test("the install script follows the template's distro", async () => {
  const ubuntu = await run(fields({ template: "tmpl:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst" }))
  assert.match(ubuntu.calls.scripts[0], /docker-compose-v2/)
  const debian = await run(fields())
  assert.match(debian.calls.scripts[0], /apt-get install -y -qq ca-certificates curl docker\.io docker-compose(\s|$)/)
  assert.doesNotMatch(debian.calls.scripts[0], /docker-compose-v2/)
})

test("an unknown step type fails the run rather than being skipped", async () => {
  const { job } = await run(fields(), ["create_lxc", "verify_url" as any])
  assert.equal(job.status, "failed")
  assert.equal(statuses(job).verify_url, "failed")
})
