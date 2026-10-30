// Template field typing: coercion and the flat, nullable extract schema.
import { test } from "node:test"
import assert from "node:assert/strict"
import { coerce, isRequired, extractJsonSchema, extractZod } from "../src/lib/ai/templates/fields"
import type { FieldSpec, TaskTemplate } from "../src/lib/ai/templates/types"

const spec = (name: string, type: FieldSpec["type"], extra: Partial<FieldSpec> = {}): FieldSpec =>
  ({ name, type, describe: name, required: true, source: "user", extract: true, ...extra })
const service = spec("service", "enum"), vmid = spec("vmid", "int"), ip = spec("ip", "ipv4cidr")
const host = spec("hostname", "hostname"), enumSpec = service, int = vmid
const fixed = spec("features", "string", { extract: false, source: "fixed" })

const toy: TaskTemplate = {
  id: "toy", version: 1, summary: "", intents: [], nearMisses: [],
  fields: [service, vmid, fixed], constants: {},
  enums: () => ({}), derive: f => f, validate: () => [], preflight: async () => [], steps: () => [],
}

test("extract schema: only extract:true fields, all required, each nullable, no extra keys", () => {
  const s: any = extractJsonSchema(toy, { service: ["uptime-kuma", "gitea"] })
  assert.deepEqual(Object.keys(s.properties).sort(), ["service", "vmid"])
  assert.deepEqual(s.required.sort(), ["service", "vmid"]); assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.properties.service.enum, ["uptime-kuma", "gitea", null])
  assert.deepEqual(s.properties.vmid.type, ["integer", "null"])
})

test("extract zod mirrors the schema: nulls pass, unknown keys and off-list values do not", () => {
  const zs = extractZod(toy, { service: ["gitea"] })
  assert.equal(zs.safeParse({ service: null, vmid: null }).success, true)
  assert.equal(zs.safeParse({ service: "gitea", vmid: 5 }).success, true)
  assert.equal(zs.safeParse({ service: "plex", vmid: 5 }).success, false)
  assert.equal(zs.safeParse({ service: null, vmid: 1.5 }).success, false)
  assert.equal(zs.safeParse({ service: null, vmid: null, features: "x" }).success, false)
  assert.equal(zs.safeParse({ service: null }).success, false)
})

test("coerce: ints from numeric strings; ipv4cidr accepts bare, cidr and dhcp; hostname lowercases and strips the dot", () => {
  assert.deepEqual(coerce(int, "237"), { ok: true, value: 237 })
  assert.equal(coerce(int, "two").ok, false)
  assert.equal(coerce(int, 1.5).ok, false)
  assert.deepEqual(coerce(ip, "10.0.0.37"), { ok: true, value: "10.0.0.37" })
  assert.deepEqual(coerce(ip, "10.0.0.37/24"), { ok: true, value: "10.0.0.37/24" })
  assert.deepEqual(coerce(ip, "DHCP"), { ok: true, value: "dhcp" })
  assert.equal(coerce(ip, "10.0.0.300/24").ok, false)
  assert.equal(coerce(ip, "10.0.0.5/33").ok, false)
  assert.deepEqual(coerce(host, "Kuma.Example.com."), { ok: true, value: "kuma.example.com" })
  assert.equal(coerce(host, "-bad.example.com").ok, false)
  assert.equal(coerce(enumSpec, "plex", ["gitea"]).ok, false)
  assert.deepEqual(coerce(enumSpec, "gitea", ["gitea"]), { ok: true, value: "gitea" })
  assert.equal(coerce(int, null).ok, false)
})

test("isRequired evaluates a function against the fields", () => {
  const cond = spec("x", "string", { required: f => f.y?.value === 1 })
  assert.equal(isRequired(cond, { y: { value: 1, source: "user" } }), true)
  assert.equal(isRequired(cond, {}), false)
  assert.equal(isRequired(vmid, {}), true)
})

test("ipv4cidr refuses leading-zero octets", () => {
  assert.equal(coerce(ip, "010.0.0.1").ok, false)
  assert.equal(coerce(ip, "10.0.0.01/24").ok, false)
  assert.deepEqual(coerce(ip, "10.0.0.0"), { ok: true, value: "10.0.0.0" })
})
