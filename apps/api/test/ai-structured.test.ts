// callStructured: one schema per provider, parsed the same way, retried once.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as z from "zod/v4"
import {
  anthropicBody, openaiBody, ollamaBody, anthropicText, callStructured, StructuredOutputError,
  type StructuredRequest, type RawSend, type ProviderId,
} from "../src/lib/ai/providers"

const schema = { type: "object", properties: { service: { type: ["string", "null"] } }, required: ["service"], additionalProperties: false }
const Z = z.strictObject({ service: z.string().nullable() })
const req: StructuredRequest<{ service: string | null }> = {
  name: "extract", system: "sys", user: "deploy kuma", schema, parse: raw => Z.parse(raw),
}
const opts = { model: "m" }
const seq = (...replies: string[]): { send: RawSend; calls: Array<[ProviderId, Record<string, unknown>]> } => {
  const calls: Array<[ProviderId, Record<string, unknown>]> = []
  let i = 0
  return { calls, send: async (p, b) => { calls.push([p, b]); return replies[Math.min(i++, replies.length - 1)] } }
}

test("each provider's body carries the one schema the way it expects", () => {
  assert.deepEqual((anthropicBody(req, "m") as any).output_config.format, { type: "json_schema", schema })
  const o = openaiBody(req, "m") as any
  assert.equal(o.response_format.json_schema.strict, true)
  assert.deepEqual(o.response_format.json_schema.schema, schema)
  assert.deepEqual((ollamaBody(req, "m") as any).format, schema)
  assert.equal((ollamaBody(req, "m") as any).options.temperature, 0.1)
})

test("ollama passes num_thread through only when set", async () => {
  assert.equal("num_thread" in (ollamaBody(req, "m") as any).options, false)
  assert.equal((ollamaBody(req, "m", 3) as any).options.num_thread, 3)
  const { send, calls } = seq('{"service":"x"}')
  await callStructured(req, "ollama", send, { model: "m", numThread: 3 })
  assert.equal((calls[0][1] as any).options.num_thread, 3)
})

test("OLLAMA_NUM_THREAD supplies the thread count when no option is given", async () => {
  process.env.OLLAMA_NUM_THREAD = "2"
  try {
    const { send, calls } = seq('{"service":"x"}')
    await callStructured(req, "ollama", send, { model: "m" })
    assert.equal((calls[0][1] as any).options.num_thread, 2)
  } finally { delete process.env.OLLAMA_NUM_THREAD }
})

test("a good reply parses on the first call", async () => {
  const { send, calls } = seq('{"service":"uptime-kuma"}')
  assert.deepEqual(await callStructured(req, "openai", send, opts), { service: "uptime-kuma" })
  assert.equal(calls.length, 1)
})

test("a reply that fails to parse is retried once, then succeeds", async () => {
  const { send, calls } = seq("not json", '{"service":null}')
  assert.deepEqual(await callStructured(req, "anthropic", send, opts), { service: null })
  assert.equal(calls.length, 2)
  const wrong = seq('{"service":5}', '{"service":"a"}')
  assert.deepEqual(await callStructured(req, "openai", wrong.send, opts), { service: "a" }, "schema failure retries too")
})

test("two bad replies ask the user to rephrase", async () => {
  const { send, calls } = seq("nope")
  await assert.rejects(callStructured(req, "ollama", send, opts), (e: any) => e instanceof StructuredOutputError && e.kind === "parse" && /rephrase/i.test(e.message))
  assert.equal(calls.length, 2, "exactly one retry")
})

test("fenced or prose-wrapped JSON from a small model is unwrapped", async () => {
  assert.deepEqual(await callStructured(req, "ollama", seq('```json\n{"service":"a"}\n```').send, opts), { service: "a" })
  assert.deepEqual(await callStructured(req, "ollama", seq('Sure! Here it is: {"service":"b"} Hope that helps').send, opts), { service: "b" })
})

test("a refusal stop reason is an error, not an empty result", () => {
  assert.throws(() => anthropicText({ stop_reason: "refusal", content: [] }), (e: any) => e instanceof StructuredOutputError && e.kind === "refusal")
  assert.equal(anthropicText({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }), "{}")
  assert.throws(() => anthropicText({ stop_reason: "end_turn", content: [] }), /no content/)
})

test("a transport error is not retried as a parse failure", async () => {
  let n = 0
  const send: RawSend = async () => { n++; throw new Error("HTTP 500") }
  await assert.rejects(callStructured(req, "openai", send, opts), /HTTP 500/)
  assert.equal(n, 1)
})
