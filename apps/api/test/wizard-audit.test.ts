// auditPlan: a plan the executor cannot run as written must come back blocked, with a plain reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { auditPlan, type Plan, type ClusterFacts } from "../src/lib/ai/plan-schema"

const facts: ClusterFacts = {
  nodes: [{ node: "alpha", cores: 4, freeMemMb: 8000, totalMemMb: 16000 }],
  storages: [{ storage: "pool", type: "rbd", freeGb: 100, shared: true }],
  domains: ["example.com"], proxyHosts: [], nextVmid: 102, usedVmids: [101], gateway: "10.0.0.1",
  capabilities: { nodesWithLogin: ["alpha"], hasReverseProxy: true, installable: [] },
}

function plan(service: string, params: Record<string, unknown> = {}): Plan {
  const base = { hostname: "", node: "", storage: "", cores: 0, memory_mb: 0, disk_gb: 0, port: 0, vmid: 0, ip: "", gateway: "" }
  const step = (type: any, p = {}) => ({ id: type, type, label: type, description: "", params: { ...base, ...p } })
  return {
    service, domain: "app.example.com", understood: "",
    steps: [step("create_lxc", params), step("install_service"), step("configure_proxy"),
            step("create_dns"), step("wait_propagation"), step("request_ssl")],
    requirements: { ram_mb: 256, disk_gb: 2, cpu_cores: 1 }, warnings: [],
  }
}

test("a known service with nothing unusual is not blocked", () => {
  assert.deepEqual(auditPlan(plan("Uptime Kuma"), facts), [])
})

test("a service with no install recipe is blocked with a plain warning", () => {
  const problems = auditPlan(plan("Mystery App"), facts)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no install recipe for "Mystery App"/)
})

test("service names match the catalogue however they are spelled", () => {
  assert.deepEqual(auditPlan(plan("uptime kuma"), facts), [])
  assert.deepEqual(auditPlan(plan("toString"), facts).length, 1)
})

test("vmid and ip: taken, out of range, malformed and off-network are all flagged", () => {
  assert.match(auditPlan(plan("Uptime Kuma", { vmid: 101 }), facts)[0], /already used/)
  assert.match(auditPlan(plan("Uptime Kuma", { vmid: 7 }), facts)[0], /not valid/)
  assert.match(auditPlan(plan("Uptime Kuma", { ip: "10.0.0.999/24" }), facts)[0], /CIDR/)
  assert.match(auditPlan(plan("Uptime Kuma", { ip: "10.4.0.9/24" }), facts)[0], /same network/)
  assert.deepEqual(auditPlan(plan("Uptime Kuma", { vmid: 250, ip: "10.0.0.37/24", gateway: "10.0.0.1" }), facts), [])
})

test("a gateway that is not the cluster's is called out as ignored", () => {
  assert.match(auditPlan(plan("Uptime Kuma", { ip: "10.0.0.37/24", gateway: "10.0.0.254" }), facts)[0], /will be ignored/)
})
