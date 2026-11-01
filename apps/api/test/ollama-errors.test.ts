// A failed Ollama call says what failed; the keyword fallback never claims no provider is reachable.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ollamaSend, ModelCallError } from "../src/lib/ai/providers"
import { matchIntent, keywordIntent, NO_TASK_ANSWER } from "../src/lib/ai/intent"
import type { ModelCall } from "../src/lib/ai/extract"

const body = { model: "qwen3:4b", messages: [] }
const send = (f: typeof fetch, timeoutMs = 300_000) => ollamaSend("http://127.0.0.1:11434/", body, timeoutMs, f)
const failure = async (f: typeof fetch, timeoutMs?: number) => {
  try { await send(f, timeoutMs); assert.fail("did not throw") } catch (e) { assert.ok(e instanceof ModelCallError, String(e)); return e }
  throw new Error("unreachable")
}

test("an Ollama 404 is a model that is not installed, and names it", async () => {
  const e = await failure((async () => new Response('{"error":"model not found"}', { status: 404 })) as any)
  assert.equal(e.kind, "model-missing")
  assert.match(e.message, /qwen3:4b isn't installed/)
  assert.match(e.message, /Pick one under Models/)
})

test("an Ollama 500 is a refusal that quotes the status, not the body", async () => {
  const e = await failure((async () => new Response("secret prompt echo", { status: 500 })) as any)
  assert.equal(e.kind, "rejected")
  assert.match(e.message, /HTTP 500/)
  assert.doesNotMatch(e.message, /secret/)
})

test("a timeout names the limit", async () => {
  const e = await failure((async () => { throw new DOMException("timed out", "TimeoutError") }) as any, 90_000)
  assert.equal(e.kind, "timeout")
  assert.match(e.message, /took too long \(over 90 s\)/)
  assert.match(e.message, /qwen3:4b/)
})

test("a server that does not answer is unreachable", async () => {
  const e = await failure((async () => { throw new TypeError("fetch failed") }) as any)
  assert.equal(e.kind, "unreachable")
  assert.match(e.message, /can't be reached/)
})

test("a good reply is its text", async () => {
  const ok = async () => new Response(JSON.stringify({ message: { content: '{"a":1}' }, done_reason: "stop" }))
  assert.equal(await send(ok as any), '{"a":1}')
})

const failing = (e: Error): ModelCall => async () => { throw e }
const notInstalled = new ModelCallError("The local model qwen3:4b isn't installed. Pick one under Models.", "model-missing")

test("a question asked while the model is missing is answered with that cause, not 'no provider reachable'", async () => {
  const r = await matchIntent("What is Uptime Kuma?", { call: failing(notInstalled) })
  assert.equal(r.template, "none")
  assert.equal(r.question, true)
  assert.ok(r.answer.startsWith(notInstalled.message), r.answer)
  assert.doesNotMatch(r.answer, /only when an AI provider is reachable/)
})

test("something that is neither a task nor a question also gets the cause", async () => {
  const r = await matchIntent("hello", { call: failing(new ModelCallError("The local model took too long (over 300 s).", "timeout")) })
  assert.match(r.answer, /took too long \(over 300 s\)/)
  assert.match(r.answer, new RegExp(NO_TASK_ANSWER.slice(0, 20)))
})

test("a deploy request still classifies by keyword, and the extract call reports the cause", async () => {
  const r = await matchIntent("set up Gitea on pve2", { call: failing(notInstalled) })
  assert.equal(r.template, "deploy-service")
})

test("an error that is not ours is reported as the provider failing, with its text", async () => {
  const r = await matchIntent("What is Gitea?", { call: failing(new Error("openai returned HTTP 401")) })
  assert.match(r.answer, /openai returned HTTP 401/)
})

test("keywordIntent without a cause keeps its own wording", () => {
  assert.match(keywordIntent("what is Gitea?").answer, /only when an AI provider is reachable/)
})
