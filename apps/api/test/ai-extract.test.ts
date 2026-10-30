// Extraction: the model fills named fields and nothing else.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { extractFields, extractSystemPrompt, type ModelCall } from "../src/lib/ai/extract"
import { callStructured, type RawSend, type StructuredRequest } from "../src/lib/ai/providers"
import { deployService } from "../src/lib/ai/templates/deploy-service"
import type { TemplateFacts } from "../src/lib/ai/templates/types"

const facts = (): TemplateFacts =>
  JSON.parse(readFileSync(join(__dirname, "scenarios/fixtures/three-node-cluster.json"), "utf8"))

/** callStructured with a faked send layer: the real parse and retry path, never a real provider. */
function fakeCall(...replies: unknown[]) {
  const requests: StructuredRequest<unknown>[] = []
  const bodies: Record<string, unknown>[] = []
  let i = 0
  const send: RawSend = async (_p, body) => {
    bodies.push(body)
    const r = replies[Math.min(i++, replies.length - 1)]
    return typeof r === "string" ? r : JSON.stringify(r)
  }
  const call: ModelCall = r => { requests.push(r as StructuredRequest<unknown>); return callStructured(r, "openai", send, { model: "m" }) }
  return { call, requests, bodies }
}
const nulls = () => Object.fromEntries(deployService.fields.filter(f => f.extract).map(f => [f.name, null]))
function logger() {
  const logged: Array<{ msg: string; data: any }> = []
  return { logged, log: (msg: string, data: object) => { logged.push({ msg, data }) } }
}

test("keys the template does not extract are dropped and logged", async () => {
  const { call } = fakeCall({ ...nulls(), service: "uptime-kuma", gateway: "10.0.0.254", features: "keyctl=1", steps: [] })
  const { logged, log } = logger()
  const x = await extractFields(deployService, "deploy kuma", facts(), { call, log })
  assert.deepEqual(x.dropped.sort(), ["features", "gateway", "steps"])
  assert.equal("gateway" in x.values, false)
  assert.equal("features" in x.values, false)
  assert.equal(x.values.service, "uptime-kuma")
  assert.equal(logged.length, 1)
  assert.equal(logged[0].msg, "ai.extract.dropped")
  const line = JSON.stringify(logged[0].data)
  assert.ok(!line.includes("10.0.0.254") && !line.includes("keyctl"), "key names only, never values")
})

test("a prototype key from the model is dropped, never a field", async () => {
  const { call } = fakeCall(`{"service":null,"__proto__":{"gateway":"x"},"constructor":"y","toString":"z"}`)
  const x = await extractFields(deployService, "deploy", facts(), { call, log: () => {} })
  assert.deepEqual(x.dropped.sort(), ["__proto__", "constructor", "toString"])
  assert.deepEqual(Object.keys(x.values), [])
  assert.equal(Object.getPrototypeOf(x.values), Object.prototype)
})

test("nulls are omitted; numeric strings are coerced; an off-enum value is reported invalid, not kept", async () => {
  const { call } = fakeCall({ ...nulls(), service: "plex-ish", memory_mb: "1024", vmid: 250, node: "pve9", ip: "10.0.0.50" })
  const x = await extractFields(deployService, "install plex-ish as 250", facts(), { call, log: () => {} })
  assert.deepEqual(x.values, { memory_mb: 1024, vmid: 250, ip: "10.0.0.50" })
  assert.deepEqual(x.invalid.map(i => i.field).sort(), ["node", "service"])
  assert.equal(x.invalid.find(i => i.field === "service")!.raw, "plex-ish")
  assert.deepEqual(x.dropped, [])
})

test("the extract request's schema has enums filled from facts", async () => {
  const f = facts()
  f.nodes[2].online = false
  const { call, requests } = fakeCall(nulls())
  await extractFields(deployService, "deploy gitea", f, { call, log: () => {} })
  const s: any = requests[0].schema
  assert.deepEqual(s.properties.node.enum, ["pve1", "pve2", null])
  assert.deepEqual(s.properties.service.enum, [...deployService.enums(f).service, null])
  assert.ok(s.properties.service.enum.includes("uptime-kuma"))
  assert.equal(s.additionalProperties, false)
  for (const k of ["gateway", "bridge", "features", "packages", "template", "storage"]) assert.equal(k in s.properties, false, k)
})

test("the system prompt is static per template version: field descriptions and the never-guess rule, no facts", async () => {
  const p = extractSystemPrompt(deployService)
  assert.equal(p, extractSystemPrompt(deployService))
  assert.match(p, /Fill fields only from the user's words\. Use null when a field is not stated\. Never guess\./)
  for (const spec of deployService.fields.filter(f => f.extract)) assert.ok(p.includes(spec.describe), spec.name)
  for (const k of ["gateway", "features", "packages"]) assert.ok(!p.includes(`${k}:`), k)
  assert.ok(!p.includes("pve1"), "no facts in the cached prompt")
  const { call, requests } = fakeCall(nulls())
  const other = facts(); other.nodes.pop()
  await extractFields(deployService, "a", facts(), { call, log: () => {} })
  await extractFields(deployService, "b", other, { call, log: () => {} })
  assert.equal(requests[0].system, requests[1].system)
})

test("an answer is extracted with the pending question in the prompt", async () => {
  const { call, requests } = fakeCall({ ...nulls(), vmid: "251" })
  const asking = { field: "vmid", question: "Which container ID should it use?" }
  const x = await extractFields(deployService, "251 please", facts(), { call, asking, log: () => {} })
  assert.equal(x.values.vmid, 251)
  assert.ok(requests[0].user.includes("Which container ID should it use?"))
  assert.ok(requests[0].user.includes("251 please"))
  assert.ok(requests[0].user.includes("vmid"))
})

test("a reply that is not an object is retried, then reported as a parse failure", async () => {
  const { call, bodies } = fakeCall("[1,2]", "null")
  await assert.rejects(extractFields(deployService, "x", facts(), { call, log: () => {} }), /rephrase/i)
  assert.equal(bodies.length, 2)
})
