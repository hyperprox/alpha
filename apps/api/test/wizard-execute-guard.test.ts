// /wizard/execute runs only a plan the server produced and audited, once, for the user who asked for it.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { buildAiRoutes } from "../src/routes/ai"
import { PreparedStore } from "../src/lib/ai/prepared"
import { failedSources, gatherFacts } from "../src/lib/ai/facts"
import { AUDIT_SOURCES } from "../src/lib/ai/plan-schema"
import type { Plan, ClusterFacts } from "../src/lib/ai/plan-schema"

const baseFacts: ClusterFacts = {
  nodes: [{ node: "pve1", cores: 4, freeMemMb: 8000, totalMemMb: 16000 }],
  storages: [{ storage: "pool", type: "rbd", freeGb: 100, shared: true }],
  domains: ["example.com"], proxyHosts: [], nextVmid: 102, usedVmids: [101], gateway: "10.0.0.1",
  capabilities: { nodesWithLogin: ["pve1"], hasReverseProxy: true, installable: [] },
}

function fakePlan(service: string): Plan {
  const base = { hostname: "", node: "", storage: "", cores: 0, memory_mb: 0, disk_gb: 0, port: 0, vmid: 0, ip: "", gateway: "" }
  const step = (type: any, p = {}) => ({ id: type, type, label: type, description: "", params: { ...base, ...p } })
  return {
    service, domain: "app.example.com", understood: "",
    steps: [step("create_lxc", { vmid: 250, node: "pve1", storage: "pool" }), step("install_service"),
            step("configure_proxy"), step("create_dns"), step("wait_propagation"), step("request_ssl")],
    requirements: { ram_mb: 256, disk_gb: 2, cpu_cores: 1 }, warnings: [],
  }
}

function harness() {
  let clock = 1_000_000
  let user = "admin@example.com"
  let factsCalls = 0
  let laterFacts: ClusterFacts | null = null
  let laterGather: (() => Promise<ClusterFacts>) | null = null
  const executed: Array<{ jobId: string; plan: Plan }> = []
  const app = Fastify()
  app.register(buildAiRoutes({
    gatherFacts: async () => (factsCalls++ > 0 && laterGather) ? laterGather() : (factsCalls > 1 && laterFacts) ? laterFacts : baseFacts,
    generatePlan: async (text: string) => fakePlan(/mystery/i.test(text) ? "Mystery App" : "Uptime Kuma"),
    execute: async (jobId: string, plan: Plan) => { executed.push({ jobId, plan }) },
    prepared: new PreparedStore<Plan>(30 * 60_000, () => clock),
    whoami: () => user,
    activeProvider: async () => "anthropic",
    listProviders: async () => [],
  }))
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as any })
  return {
    app, inject, executed,
    advance: (ms: number) => { clock += ms },
    as: (email: string) => { user = email },
    factsLater: (f: ClusterFacts) => { laterFacts = f },
    gatherLater: (g: () => Promise<ClusterFacts>) => { laterGather = g },
  }
}

test("a plan posted by the browser is refused and never executed", async () => {
  const { inject, executed } = harness()
  const res = await inject("/wizard/execute", { plan: { steps: [{ type: "create_lxc" }] } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /never run/)
  assert.equal(executed.length, 0)
})

test("a plan posted alongside a valid planId is still refused", async () => {
  const { inject, executed } = harness()
  const { planId } = (await inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  const res = await inject("/wizard/execute", { planId, plan: { steps: [{ type: "create_lxc" }] } })
  assert.equal(res.statusCode, 400)
  assert.equal(executed.length, 0)
})

test("a non-string planId is refused", async () => {
  const { inject, executed } = harness()
  assert.equal((await inject("/wizard/execute", { planId: { $ne: "" } })).statusCode, 400)
  assert.equal((await inject("/wizard/execute", {})).statusCode, 400)
  assert.equal(executed.length, 0)
})

test("a blocked plan gets no planId", async () => {
  const { inject } = harness()
  const body = (await inject("/wizard/plan", { prompt: "deploy mystery app" })).json()
  assert.equal(body.blocked, true)
  assert.equal(body.planId, undefined)
})

test("execute runs the server's copy of the plan, once", async () => {
  const { inject, executed } = harness()
  const { planId, plan, blocked } = (await inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  assert.equal(blocked, false)
  assert.equal(typeof planId, "string")
  const res = await inject("/wizard/execute", { planId })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(executed.length, 1)
  assert.equal(executed[0].jobId, res.json().jobId)
  assert.deepEqual(executed[0].plan.steps, plan.steps)
  assert.equal((await inject("/wizard/execute", { planId })).statusCode, 404)
  assert.equal(executed.length, 1)
})

test("an unknown, expired or another user's planId is 404", async () => {
  const h = harness()
  assert.equal((await h.inject("/wizard/execute", { planId: "not-a-plan" })).statusCode, 404)

  const { planId: stale } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  h.advance(30 * 60_000 + 1)
  const expired = await h.inject("/wizard/execute", { planId: stale })
  assert.equal(expired.statusCode, 404)
  assert.match(expired.json().error, /expired or was already run/)

  const { planId: mine } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  h.as("someone-else@example.com")
  assert.equal((await h.inject("/wizard/execute", { planId: mine })).statusCode, 404)
  // Trying it as another user must not burn it for the owner.
  h.as("admin@example.com")
  assert.equal((await h.inject("/wizard/execute", { planId: mine })).statusCode, 200)
  assert.equal(h.executed.length, 1)
})

test("a request with no signed-in user gets no planId and cannot execute", async () => {
  const h = harness()
  h.as("")
  const body = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  assert.equal(body.blocked, false)
  assert.equal(body.planId, undefined)
  assert.equal((await h.inject("/wizard/execute", { planId: "anything" })).statusCode, 404)
  assert.equal(h.executed.length, 0)
})

test("facts that changed since planning re-block at execute", async () => {
  const h = harness()
  const { planId } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  h.factsLater({ ...baseFacts, usedVmids: [101, 250] })
  const res = await h.inject("/wizard/execute", { planId })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().blocked, true)
  assert.ok(res.json().warnings.some((w: string) => /250 is already used/.test(w)))
  assert.equal(h.executed.length, 0)
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

test("execute refuses, naming the source, when the facts the audit needs could not be read", async () => {
  for (const source of AUDIT_SOURCES) {
    const h = harness()
    const { planId } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
    // An unreadable source reads as empty: no used IDs, no zones. That must not pass the re-audit.
    h.factsLater({ ...baseFacts, usedVmids: [], domains: [], partial: [source] })
    const res = await h.inject("/wizard/execute", { planId })
    assert.equal(res.statusCode, 502, source)
    assert.equal(res.json().blocked, true)
    assert.deepEqual(res.json().unavailable, [source])
    assert.match(res.json().error, new RegExp(source))
    assert.equal(h.executed.length, 0)
  }
})

test("a source the audit does not use failing does not block execute", async () => {
  const h = harness()
  const { planId } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  h.factsLater({ ...baseFacts, partial: ["proxy"] })
  assert.equal((await h.inject("/wizard/execute", { planId })).statusCode, 200)
  assert.equal(h.executed.length, 1)
})

test("planning with an unreadable source still plans, and says what it could not check", async () => {
  const h = harness()
  h.factsLater({ ...baseFacts, partial: ["resources"] })
  await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })   // first call uses baseFacts
  const body = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  assert.equal(body.ok, true)
  assert.ok(body.plan.warnings.some((w: string) => /could not read resources/i.test(w)), body.plan.warnings.join(" | "))
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

test("execute refuses (502) when the real fact gatherer reads null for /cluster/resources", async () => {
  const h = harness()
  const { planId } = (await h.inject("/wizard/plan", { prompt: "deploy uptime kuma" })).json()
  const GB = 1024 ** 3
  const pve: any = {
    fetchNode: async () => null,
    fetchStrict: async (p: string) => {
      if (p === "/nodes") return [{ node: "pve1", status: "online", maxcpu: 4, maxmem: 16 * GB, mem: 4 * GB }]
      if (p === "/nodes/pve1/storage") return [{ storage: "pool", type: "rbd", content: "rootdir", active: 1, avail: 100 * GB }]
      if (p === "/cluster/nextid") return "102"
      return null                                    // /cluster/resources: a 2xx with no data
    },
  }
  h.gatherLater(() => gatherFacts({ pve, zones: async () => ["example.com"], proxyHosts: async () => [] }))
  const res = await h.inject("/wizard/execute", { planId })
  assert.equal(res.statusCode, 502)
  assert.deepEqual(res.json().unavailable, ["resources"])
  assert.equal(h.executed.length, 0)
})
