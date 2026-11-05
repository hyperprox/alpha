// The executor runs the template's fixed steps from typed fields, against fakes: a failed step stops the run,
// publishing never follows a failed or skipped install, and a first-run page is never published.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  executeDeployJob, getJob, stepStartAndVerify, stepHealthCheck, stepCreateDNS, type ExecDeps, type JobState,
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
      if (path.startsWith("/cluster/resources")) return [{ vmid: 101, type: "lxc", node: "alpha", name: "web" }]
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
    proxy: {
      createHost: async (h: any) => { calls.proxy.push(h); return { hostId: "7" } },
      requestCertificate: async () => ({ id: "9" }),
      updateHost: async () => ({}),
    },
    dns: async () => ({
      getDomains: async () => (over.zones ?? ["example.com"]).map((domain: string) => ({ domain })),
      getRecords: async (zone: string) => (over.records?.[zone] ?? []),
      createRecord: async (...a: any[]) => { calls.records.push(a) },
    }) as any,
    wanIp: async () => "203.0.113.5",
    resolve4: async () => ["203.0.113.5"],
    letsEncryptEmail: () => "certs@example.com",
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
  assert.equal(calls.proxy[0].forwardHost, "10.0.0.37")
  assert.equal(calls.proxy[0].forwardPort, 3000)
  assert.deepEqual(calls.proxy[0].domains, ["home.example.com"])
})

const dnsJob = (domain: string): JobState => ({ jobId: "dns", status: "running", steps: [], currentStep: 0, startedAt: 0,
  run: runOf(fields({ service: "homepage", exposure: "public", domain, hostname: "homepage" })) })

test("create_dns writes to the longest matching zone", async () => {
  const { deps, calls } = fakeDeps({ zones: ["example.com", "lab.example.com"] })
  await stepCreateDNS(dnsJob("home.lab.example.com"), deps as ExecDeps)
  assert.deepEqual(calls.records[0], ["lab.example.com", { type: "A", name: "home", data: "203.0.113.5", ttl: 600 }])
  const none = fakeDeps()
  await assert.rejects(stepCreateDNS(dnsJob("home.example.net"), none.deps as ExecDeps), /example\.net.*no DNS zone/)
  assert.equal(none.calls.records.length, 0)
})

test("create_dns refuses a name that gained an A, AAAA or CNAME record since the plan, and never appends", async () => {
  for (const type of ["A", "AAAA", "CNAME"]) {
    const { deps, calls } = fakeDeps({ records: { "example.com": [{ type, name: "home", data: "x", ttl: 600 }] } })
    await assert.rejects(stepCreateDNS(dnsJob("home.example.com"), deps as ExecDeps), /home\.example\.com already has a DNS record/, type)
    assert.equal(calls.records.length, 0, type)
  }
  // A record for another name, or a TXT on this one, does not block it.
  const ok = fakeDeps({ records: { "example.com": [{ type: "A", name: "www", data: "x", ttl: 600 }, { type: "TXT", name: "home", data: "x", ttl: 600 }] } })
  await stepCreateDNS(dnsJob("home.example.com"), ok.deps as ExecDeps)
  assert.equal(ok.calls.records.length, 1)
})

test("a run with no install step cannot publish", async () => {
  const f = fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" })
  const { job, calls } = await run(f, ["create_lxc", "start_and_verify", "configure_proxy", "create_dns"])
  assert.equal(job.status, "failed")
  assert.equal(statuses(job).configure_proxy, "pending")
  assert.equal(calls.proxy.length, 0)
  assert.equal(calls.records.length, 0)
})

test("the certificate email comes from the executor's deps, not the shell", async () => {
  const f = fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" })
  const none = await run(f, ALL, { deps: { letsEncryptEmail: () => "" } })
  assert.equal(none.job.status, "failed")
  assert.match(none.job.steps.find(s => s.type === "request_ssl")!.error!, /Let's Encrypt email not configured/)
})

test("a hostname taken by another guest since the plan is refused before the create", async () => {
  const { job, calls } = await run(fields({ hostname: "web" }))
  assert.equal(job.status, "failed")
  assert.match(job.error!, /web is already the name of guest 101/)
  assert.equal(calls.create, undefined)
})

test("with no node login the install is shown, not run; health_check is skipped and no publishing step runs", async () => {
  const lan = await run(fields(), undefined, { noLogin: true })
  // Nothing is running: the run says so, even on the LAN.
  assert.equal(lan.job.status, "failed")
  assert.match(lan.job.error!, /not installed/i)
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
  const { job } = await run(fields(), ["create_lxc", "complete_guest"])
  assert.equal(job.status, "failed")
  assert.equal(statuses(job).complete_guest, "failed")
})

test("the executor refuses a malformed or wildcard domain at the proxy and the DNS step", async () => {
  for (const d of ["*.example.com", "a..example.com", "foo_bar.example.com", "x y.example.com"]) {
    const dns = fakeDeps()
    await assert.rejects(stepCreateDNS(dnsJob(d), dns.deps as ExecDeps), /is not a hostname HyperProx will publish/, d)
    assert.equal(dns.calls.records.length, 0, d)

    const { job, calls } = await run(fields({ service: "homepage", exposure: "public", domain: d, hostname: "homepage" }), ALL)
    assert.equal(job.status, "failed", d)
    assert.equal(statuses(job).configure_proxy, "failed", d)
    assert.match(job.steps.find(s => s.type === "configure_proxy")!.error!, /is not a hostname HyperProx will publish/, d)
    assert.equal(statuses(job).create_dns, "pending", d)
    assert.equal(calls.proxy.length, 0, d)
    assert.equal(calls.records.length, 0, d)
  }
})

test("Homepage's allowed hosts are the container's address and port, plus the domain when public", async () => {
  const lan = await run(fields({ service: "homepage", hostname: "homepage" }))
  assert.equal(lan.job.status, "completed", lan.job.error)
  assert.match(lan.calls.scripts[0], /\nHOMEPAGE_ALLOWED_HOSTS=10\.0\.0\.37:3000\n/)
  const pub = await run(fields({ service: "homepage", exposure: "public", domain: "home.example.com", hostname: "homepage" }), ALL)
  assert.equal(pub.job.status, "completed", pub.job.error)
  assert.match(pub.calls.scripts[0], /\nHOMEPAGE_ALLOWED_HOSTS=10\.0\.0\.37:3000,home\.example\.com\n/)
  // The health check sends the same Host the variable allows.
  assert.deepEqual(pub.calls.fetched, ["http://10.0.0.37:3000/"])
})
