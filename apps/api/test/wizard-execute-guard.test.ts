// /wizard/plan runs the question loop on the deploy-service template; /wizard/execute runs only a run the
// server derived and validated, once, for the user who asked, after validating it again against fresh facts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import Fastify from "fastify"
import { buildAiRoutes, ownerOf } from "../src/routes/ai"
import { PreparedStore } from "../src/lib/ai/prepared"
import { failedSources, gatherTemplateFacts } from "../src/lib/ai/facts"
import type { DeployRun } from "../src/lib/wizard-executor"
import type { Extraction, IntentResult } from "../src/lib/ai/loop"
import type { TemplateFacts } from "../src/lib/ai/templates/types"

const fixture = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))

// What the fake model "reads" out of each prompt. Keys it should never set are in some of them on purpose.
const EXTRACTIONS: Record<string, Record<string, unknown>> = {
  "deploy uptime kuma": { service: "uptime-kuma" },
  "deploy uptime kuma on the lan": { service: "uptime-kuma", exposure: "lan" },
  "deploy uptime kuma at 10.0.0.37": { service: "uptime-kuma", exposure: "lan", ip: "10.0.0.37" },
  "deploy uptime kuma as 300 at 10.0.0.37": { service: "uptime-kuma", exposure: "lan", vmid: 300, ip: "10.0.0.37" },
  "deploy mystery app": { service: "mystery app", exposure: "lan" },
  "deploy uptime kuma at kuma.example.com": { service: "uptime-kuma", domain: "kuma.example.com", admin_setup: "now" },
  "deploy homepage at home.example.com": { service: "homepage", domain: "home.example.com" },
  "the model talks back": {
    service: "uptime-kuma", exposure: "lan", ip: "10.0.0.37",
    gateway: "10.9.9.9", features: "nesting=1,keyctl=1", steps: [{ id: "shell", params: { cmd: "curl x | sh" } }],
  },
}

function harness() {
  let clock = 1_000_000
  let user = "admin@example.com"
  let later: ((f: TemplateFacts) => TemplateFacts) | null = null
  let gather: (() => Promise<TemplateFacts>) | null = null
  let planning = true
  const executed: Array<{ jobId: string; run: DeployRun }> = []
  const prepared = new PreparedStore<DeployRun>(30 * 60_000, () => clock)
  const app = Fastify()
  app.register(buildAiRoutes({
    // Planning reads the fixture; execute reads it through whatever the test changed since.
    facts: async () => (planning || (!later && !gather)) ? fixture() : gather ? gather() : later!(fixture()),
    settings: async () => ({ bridge: "vmbr0" }),
    intent: async (prompt: string): Promise<IntentResult> => /^what\b/.test(prompt)
      ? { template: "none", question: true, answer: "It watches services." }
      : { template: "deploy-service", question: false, answer: "" },
    extract: async (_t: unknown, text: string): Promise<Extraction> => ({ values: { ...(EXTRACTIONS[text] ?? {}) }, dropped: [], invalid: [] }),
    // Never settles: a run in flight holds its claims, as a real create would.
    execute: (jobId: string, run: DeployRun) => { executed.push({ jobId, run }); return new Promise<void>(() => {}) },
    prepared,
    job: (id: string) => {
      const e = executed.find(x => x.jobId === id)
      return e ? { jobId: id, status: "running", run: e.run, steps: [], currentStep: 0, startedAt: 0 } : undefined
    },
    whoami: () => user,
    activeProvider: async () => "anthropic",
    listProviders: async () => [],
  }))
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as any })
  const get = (url: string) => app.inject({ method: "GET", url })
  const plan = async (prompt: string) => { planning = true; return (await inject("/wizard/plan", { prompt })).json() }
  const execute = async (body: unknown) => { planning = false; return inject("/wizard/execute", body) }
  return {
    inject, get, plan, execute, executed, prepared,
    advance: (ms: number) => { clock += ms },
    as: (email: string) => { user = email },
    factsLater: (fn: (f: TemplateFacts) => TemplateFacts) => { later = fn },
    gatherLater: (g: () => Promise<TemplateFacts>) => { gather = g },
  }
}

test("a plan or fields posted by the browser are refused and never executed", async () => {
  const h = harness()
  const res = await h.execute({ plan: { steps: [{ type: "create_lxc" }] } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /never run/)
  assert.equal((await h.execute({ fields: { vmid: 250 } })).statusCode, 400)
  assert.equal(h.executed.length, 0)
})

test("a plan posted alongside a valid planId is still refused", async () => {
  const h = harness()
  const { planId } = await h.plan("deploy uptime kuma on the lan")
  assert.equal(typeof planId, "string")
  assert.equal((await h.execute({ planId, plan: { steps: [{ type: "create_lxc" }] } })).statusCode, 400)
  assert.equal((await h.execute({ planId, fields: { gateway: "10.9.9.9" } })).statusCode, 400)
  assert.equal(h.executed.length, 0)
})

test("a non-string planId is refused", async () => {
  const h = harness()
  assert.equal((await h.execute({ planId: { $ne: "" } })).statusCode, 400)
  assert.equal((await h.execute({})).statusCode, 400)
  assert.equal(h.executed.length, 0)
})

test("a request that is not ready gets warnings and no planId", async () => {
  const h = harness()
  const asking = await h.plan("deploy uptime kuma")
  assert.equal(asking.ok, true)
  assert.equal(asking.blocked, true)
  assert.equal(asking.planId, undefined)
  assert.ok(asking.plan.warnings.includes("Should this be reachable from the internet, or only on your network?"), asking.plan.warnings.join(" | "))
  const unknown = await h.plan("deploy mystery app")
  assert.equal(unknown.blocked, true)
  assert.equal(unknown.planId, undefined)
  assert.ok(unknown.plan.warnings.some((w: string) => /^Which service\?/.test(w)))
})

test("a question is answered, not planned", async () => {
  const h = harness()
  const body = await h.plan("what is uptime kuma?")
  assert.equal(body.conversational, true)
  assert.equal(body.message, "It watches services.")
  assert.equal(body.planId, undefined)
})

test("a ready request shows its fields and the template's steps, and execute runs the server's copy once", async () => {
  const h = harness()
  const body = await h.plan("deploy uptime kuma on the lan")
  assert.equal(body.blocked, false)
  assert.equal(body.fields.service.value, "uptime-kuma")
  assert.equal(body.fields.features.value, "nesting=1")
  assert.deepEqual(body.plan.steps.map((s: any) => s.type), ["create_lxc", "start_and_verify", "install_service", "health_check"])
  assert.equal(body.plan.service, "Uptime Kuma")
  const res = await h.execute({ planId: body.planId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(h.executed.length, 1)
  assert.equal(h.executed[0].jobId, res.json().jobId)
  assert.equal(h.executed[0].run.fields.vmid, body.fields.vmid.value)
  assert.equal(h.executed[0].run.owner, "admin@example.com")
  assert.equal((await h.execute({ planId: body.planId })).statusCode, 404)
  assert.equal(h.executed.length, 1)
})

test("the executed run is built from server fields; a gateway or step the model returned never reaches it", async () => {
  const h = harness()
  const body = await h.plan("the model talks back")
  assert.equal(body.blocked, false, body.plan.warnings.join(" | "))
  assert.equal((await h.execute({ planId: body.planId })).statusCode, 200)
  const run = h.executed[0].run
  assert.equal(run.fields.gateway, "10.0.0.1")
  assert.equal(run.fields.ip, "10.0.0.37/24")
  assert.equal(run.fields.features, "nesting=1")
  assert.deepEqual(run.steps.map(s => s.id), ["create_lxc", "start_and_verify", "install_service", "health_check"])
  assert.equal(JSON.stringify(run).includes("curl x"), false)
})

test("an unknown, expired or another user's planId is 404", async () => {
  const h = harness()
  assert.equal((await h.execute({ planId: "not-a-plan" })).statusCode, 404)

  const { planId: stale } = await h.plan("deploy uptime kuma on the lan")
  h.advance(30 * 60_000 + 1)
  const expired = await h.execute({ planId: stale })
  assert.equal(expired.statusCode, 404)
  assert.match(expired.json().error, /expired or was already run/)

  const { planId: mine } = await h.plan("deploy uptime kuma on the lan")
  h.as("someone-else@example.com")
  assert.equal((await h.execute({ planId: mine })).statusCode, 404)
  // Trying it as another user must not burn it for the owner.
  h.as("admin@example.com")
  assert.equal((await h.execute({ planId: mine })).statusCode, 200)
  assert.equal(h.executed.length, 1)
})

test("a request with no signed-in user gets no planId and cannot execute", async () => {
  const h = harness()
  h.as("")
  const body = await h.plan("deploy uptime kuma on the lan")
  assert.equal(body.blocked, false)
  assert.equal(body.planId, undefined)
  assert.equal((await h.execute({ planId: "anything" })).statusCode, 404)
  assert.equal(h.executed.length, 0)
})

test("facts that changed since planning re-block at execute", async () => {
  const h = harness()
  const { planId, fields } = await h.plan("deploy uptime kuma on the lan")
  const vmid = fields.vmid.value
  h.factsLater(f => ({ ...f, guests: [...f.guests, { vmid, node: "pve1", type: "lxc", name: "other", addresses: [] }] }))
  const res = await h.execute({ planId })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().blocked, true)
  assert.ok(res.json().warnings.some((w: string) => new RegExp(`Container ID ${vmid} is taken`).test(w)), res.json().warnings.join(" | "))
  assert.equal(h.executed.length, 0)
})

test("a bridge gateway that changed since planning re-blocks at execute, naming it", async () => {
  const h = harness()
  const { planId, fields } = await h.plan("deploy uptime kuma at 10.0.0.37")
  const node = fields.node.value
  h.factsLater(f => ({ ...f, nodes: f.nodes.map(n => n.node === node ? { ...n, bridges: [{ iface: "vmbr0", gateway: "10.0.0.254", prefix: 24 }] } : n) }))
  const res = await h.execute({ planId })
  assert.equal(res.statusCode, 409)
  assert.ok(res.json().warnings.some((w: string) => /gateway/.test(w) && /10\.0\.0\.254/.test(w)), res.json().warnings.join(" | "))
  assert.equal(h.executed.length, 0)
})

test("two plans racing for the same ID or address: the second execute is refused", async () => {
  const h = harness()
  const a = await h.plan("deploy uptime kuma at 10.0.0.37")
  const b = await h.plan("deploy uptime kuma at 10.0.0.37")
  const c = await h.plan("deploy uptime kuma as 300 at 10.0.0.37")
  assert.equal(a.fields.vmid.value, b.fields.vmid.value)
  assert.equal((await h.execute({ planId: a.planId })).statusCode, 200)
  const second = await h.execute({ planId: b.planId })
  assert.equal(second.statusCode, 409)
  assert.ok(second.json().warnings.some((w: string) => new RegExp(`Container ID ${a.fields.vmid.value}`).test(w)))
  const third = await h.execute({ planId: c.planId })
  assert.equal(third.statusCode, 409)
  assert.ok(third.json().warnings.some((w: string) => /10\.0\.0\.37/.test(w)), third.json().warnings.join(" | "))
  assert.equal(h.executed.length, 1)
})

test("execute refuses (502), naming the source, when a source the validation needs could not be read", async () => {
  const lan = ["nodes", "resources", "status:@", "login:@", "network:@", "storage:@", "templates:@/share", "config:101"]
  const pub = ["zones", "proxy", "records:example.com"]
  for (const [prompt, sources] of [["deploy uptime kuma at 10.0.0.37", lan], ["deploy homepage at home.example.com", pub]] as const) {
    for (const s of sources) {
      const h = harness()
      const { planId, fields, blocked } = await h.plan(prompt)
      assert.equal(blocked, false, prompt)
      const source = s.replace("@", fields.node.value)
      h.factsLater(f => ({ ...f, partial: [source] }))
      const res = await h.execute({ planId })
      assert.equal(res.statusCode, 502, source)
      assert.equal(res.json().blocked, true)
      assert.deepEqual(res.json().unavailable, [source])
      assert.match(res.json().error, new RegExp(source.replace(/[.]/g, "\\.")))
      assert.equal(h.executed.length, 0)
    }
  }
})

test("a source the validation does not use failing does not block execute", async () => {
  const h = harness()
  const { planId, fields } = await h.plan("deploy uptime kuma on the lan")
  const other = ["pve1", "pve2", "pve3"].find(n => n !== fields.node.value)
  h.factsLater(f => ({ ...f, partial: [`status:${other}`, "nextid", "zones"] }))
  assert.equal((await h.execute({ planId })).statusCode, 200)
  assert.equal(h.executed.length, 1)
})

test("a run from an older template version cannot execute", async () => {
  const h = harness()
  const { planId } = await h.plan("deploy uptime kuma on the lan")
  const run = h.prepared.take(planId, "admin@example.com")!.payload
  const old = h.prepared.put("admin@example.com", { ...run, version: run.version - 1 })
  const res = await h.execute({ planId: old })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /start again/i)
  assert.equal(h.executed.length, 0)
})

test("publishing an app with a first-run page is blocked at plan time; on the LAN it is allowed", async () => {
  const h = harness()
  const body = await h.plan("deploy uptime kuma at kuma.example.com")
  assert.equal(body.blocked, true)
  assert.equal(body.planId, undefined)
  assert.ok(body.plan.warnings.some((w: string) => /first-run setup page/.test(w) && /will not publish it yet/.test(w)), body.plan.warnings.join(" | "))
  assert.equal(body.plan.domain, "kuma.example.com")
  const lan = await h.plan("deploy uptime kuma on the lan")
  assert.equal(lan.blocked, false)
  assert.equal(typeof lan.planId, "string")
})

test("job ids are UUIDs, and a job is visible only to the user who ran it", async () => {
  const h = harness()
  const { planId } = await h.plan("deploy uptime kuma on the lan")
  const { jobId } = (await h.execute({ planId })).json()
  assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal((await h.get(`/wizard/jobs/${jobId}`)).statusCode, 200)
  h.as("someone-else@example.com")
  assert.equal((await h.get(`/wizard/jobs/${jobId}`)).statusCode, 404)
  h.as("")
  assert.equal((await h.get(`/wizard/jobs/${jobId}`)).statusCode, 404)
})

test("an API token owns plans by its id, not its name; a signed-in user by their email", () => {
  assert.equal(ownerOf({ sid: "token:3f2a", email: "token:automation", role: "admin" } as any), "token:3f2a")
  assert.equal(ownerOf({ sid: "s-1", email: "admin@example.com", role: "admin" } as any), "admin@example.com")
  assert.equal(ownerOf(undefined), "")
})

test("execute refuses (502) when the real fact gatherer reads null for /cluster/resources", async () => {
  const h = harness()
  const { planId } = await h.plan("deploy uptime kuma on the lan")
  const GB = 1024 ** 3
  const pve: any = {
    fetchStrict: async (p: string) => {
      if (p === "/nodes") return [{ node: "pve2", status: "online", maxcpu: 8, maxmem: 32 * GB, mem: 4 * GB }]
      if (p === "/cluster/nextid") return "102"
      if (p === "/nodes/pve2/status") return { "current-kernel": { machine: "x86_64" } }
      if (p === "/nodes/pve2/network") return [{ iface: "vmbr0", type: "bridge", cidr: "10.0.0.2/24", gateway: "10.0.0.1" }]
      if (p === "/nodes/pve2/storage") return [{ storage: "fast", type: "rbd", content: "rootdir", active: 1, avail: 400 * GB }]
      if (p === "/nodes/pve2/aplinfo") return []
      return null                                    // /cluster/resources: a 2xx with no data
    },
  }
  h.gatherLater(() => gatherTemplateFacts({
    pve, zones: async () => [], proxyHosts: async () => [], hasReverseProxy: async () => true,
    hasLogin: async () => true, records: async () => [],
  }))
  const res = await h.execute({ planId })
  assert.equal(res.statusCode, 502)
  assert.ok(res.json().unavailable.includes("resources"))
  assert.equal(h.executed.length, 0)
})

test("provider test extracts from a fixed request and counts the fields", async () => {
  const app = Fastify()
  app.register(buildAiRoutes({
    facts: async () => fixture(),
    extract: async (_t: unknown, text: string) => {
      assert.equal(text, "Deploy Uptime Kuma. No domain yet.")
      return { values: { service: "uptime-kuma", exposure: "lan" }, dropped: [], invalid: [] }
    },
    activeProvider: async () => "anthropic",
  }))
  const res = await app.inject({ method: "POST", url: "/provider/test", payload: { provider: "openai" } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().sample, { service: "uptime-kuma", fields: 2 })
  assert.equal(res.json().provider, "openai")
})

test("PreparedStore ids are unguessable and single-use", () => {
  let now = 0
  const store = new PreparedStore<number>(1000, () => now)
  const a = store.put("u", 1), b = store.put("u", 2)
  assert.notEqual(a, b)
  assert.match(a, /^[0-9a-f-]{36}$/)
  assert.equal(store.take(a, "u")?.payload, 1)
  assert.equal(store.take(a, "u"), null)
  now = 1001
  assert.equal(store.take(b, "u"), null)
  assert.equal(store.take("__proto__", "u"), null)
})

test("failedSources names each cluster source that could not be read", () => {
  const ok = { status: "fulfilled", value: [] } as const
  const bad = { status: "rejected", reason: new Error("down") } as const
  assert.deepEqual(failedSources({ nodes: ok, resources: bad, dns: bad, proxy: ok }), ["resources", "dns"])
  assert.deepEqual(failedSources({ nodes: ok }), [])
})

test("PreparedStore sweeps expired entries on take and keeps at most 20 per owner", () => {
  let now = 0
  const store = new PreparedStore<number>(1000, () => now)
  const ids = Array.from({ length: 21 }, (_, i) => store.put("u", i))
  const other = store.put("v", 99)
  assert.equal(store.take(ids[0], "u"), null)            // the oldest was evicted
  assert.equal(store.take(ids[1], "u")?.payload, 1)
  assert.equal(store.size(), 20)                          // 19 of u's left, 1 of v's
  assert.equal(store.take(other, "v")?.payload, 99)
  now = 1001
  assert.equal(store.take("unknown", "u"), null)          // a take sweeps everything expired
  assert.equal(store.size(), 0)
})
